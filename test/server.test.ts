import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";

/**
 * The tool handlers had no coverage at all, and two of the seven defects found
 * in 0.1.0 lived exactly there. These tests stand the real server up and drive
 * it through the SDK, with the Codex CLI replaced at the `child_process`
 * boundary — no quota, no credentials, no CLI needed on the machine.
 *
 * `CODEX_BIN` is pointed at Node itself so that executable resolution succeeds
 * on every platform; what the resolved binary would actually do never matters,
 * because both `execFile` and `spawn` are intercepted below.
 */

const CATALOG = {
  models: [
    {
      slug: "cheap-model",
      visibility: "list",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
    },
    {
      slug: "expensive-model",
      visibility: "list",
      default_reasoning_level: "high",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
    },
  ],
};

let spawnedArgs: string[][] = [];

const fakeExecFile = async (_file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
  if (args[0] === "--version") return { stdout: "codex-cli 0.154.0", stderr: "" };
  if (args[0] === "debug") return { stdout: JSON.stringify(CATALOG), stderr: "" };
  return { stdout: "Logged in using ChatGPT", stderr: "" };
};

cp.execFile = (() => {}) as unknown as typeof cp.execFile;
(cp.execFile as unknown as Record<symbol, unknown>)[promisify.custom] = fakeExecFile;

cp.spawn = ((_file: string, args: string[]) => {
  spawnedArgs.push(args);
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  setImmediate(() => {
    child["exitCode"] = 0;
    child.emit("close", 0);
  });
  return child;
}) as unknown as typeof cp.spawn;

syncBuiltinESMExports();

const { createServer } = await import("../src/server.ts");

interface ToolServer {
  _registeredTools: Record<string, unknown>;
  validateToolInput: (tool: unknown, args: unknown, name: string) => Promise<unknown>;
  executeToolHandler: (tool: unknown, args: unknown, extra: unknown) => Promise<unknown>;
  close: () => Promise<void>;
}

async function withServer<T>(
  env: Record<string, string | undefined>,
  body: (call: (name: string, args: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const keys = [
    "CODEX_SUBAGENT_ALLOWED_MODELS",
    "CODEX_SUBAGENT_MAX_EFFORT",
    "CODEX_SUBAGENT_DEFAULT_MODEL",
    "CODEX_SUBAGENT_DEFAULT_EFFORT",
    "CODEX_SUBAGENT_MAX_SANDBOX",
    "CODEX_BIN",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  for (const key of keys) delete process.env[key];
  process.env.CODEX_BIN = process.execPath;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }

  spawnedArgs = [];
  const { server, jobs } = createServer();
  const tools = server as unknown as ToolServer;
  const extra = { signal: new AbortController().signal, sendNotification: async () => {} };

  const call = async (name: string, args: unknown): Promise<unknown> => {
    const tool = tools._registeredTools[name];
    const validated = await tools.validateToolInput(tool, args, name);
    return tools.executeToolHandler(tool, validated, extra);
  };

  try {
    return await body(call);
  } finally {
    jobs.cancelAll();
    await tools.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("applies the configured ceiling to a follow-up that passes no overrides", async () => {
  // A resumed session keeps the model and effort it was created with, and the
  // server cannot read those back. Skipping the policy here let a thread run
  // above ALLOWED_MODELS and MAX_EFFORT forever, just by never overriding.
  await withServer(
    {
      CODEX_SUBAGENT_ALLOWED_MODELS: "cheap-model",
      CODEX_SUBAGENT_MAX_EFFORT: "low",
    },
    async (call) => {
      await call("codex_follow_up", { thread_id: "existing-expensive-thread", prompt: "continue" });

      assert.equal(spawnedArgs.length, 1);
      const args = spawnedArgs[0] ?? [];
      assert.equal(args[args.indexOf("--model") + 1], "cheap-model");
      assert.ok(
        args.includes('model_reasoning_effort="low"'),
        `effort ceiling missing from ${JSON.stringify(args)}`,
      );
    },
  );
});

test("refuses a follow-up naming a model outside the allow-list", async () => {
  await withServer({ CODEX_SUBAGENT_ALLOWED_MODELS: "cheap-model" }, async (call) => {
    const result = (await call("codex_follow_up", {
      thread_id: "some-thread",
      prompt: "continue",
      model: "expensive-model",
    })) as { isError?: boolean; content: { text: string }[] };

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /ALLOWED_MODELS/);
    assert.equal(spawnedArgs.length, 0, "nothing should have been spawned");
  });
});

test("leaves a follow-up inheriting the session when no ceiling is configured", async () => {
  // The ceiling is the reason to intervene. With none set, a follow-up should
  // still be the cheap "just continue" call it is meant to be.
  await withServer({}, async (call) => {
    await call("codex_follow_up", { thread_id: "some-thread", prompt: "continue" });

    const args = spawnedArgs[0] ?? [];
    assert.ok(!args.includes("--model"), `expected no model override, got ${JSON.stringify(args)}`);
  });
});

test("refuses an add_dirs entry that is not an existing absolute directory", async () => {
  await withServer({}, async (call) => {
    const result = (await call("codex_delegate", {
      prompt: "anything",
      model: "cheap-model",
      add_dirs: ["--dangerously-bypass-approvals-and-sandbox"],
    })) as { isError?: boolean; content: { text: string }[] };

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /add_dirs entry must be an absolute path/);
    assert.equal(spawnedArgs.length, 0, "nothing should have been spawned");
  });
});
