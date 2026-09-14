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

/** What the next spawned "Codex" writes to stdout and how it exits. */
let nextRun: { events: unknown[]; exitCode: number } = { events: [], exitCode: 0 };

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
  const { events, exitCode } = nextRun;
  setImmediate(() => {
    const stdout = child["stdout"] as PassThrough;
    for (const event of events) stdout.write(`${JSON.stringify(event)}\n`);
    child["exitCode"] = exitCode;
    // Let the stdout data events drain before close, as a real child would.
    setImmediate(() => child.emit("close", exitCode));
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
  nextRun = { events: [], exitCode: 0 };
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

type ToolResult = { isError?: boolean; content: { text: string }[] };

const ERROR_ITEM = { type: "item.completed", item: { type: "error", message: "model overloaded" } };
const ANSWER = { type: "item.completed", item: { type: "agent_message", text: "Done." } };

/** Starts a background delegation and waits until the registry reports it finished. */
async function runInBackground(call: (name: string, args: unknown) => Promise<unknown>): Promise<string> {
  const started = (await call("codex_delegate", {
    prompt: "anything",
    model: "cheap-model",
    mode: "background",
  })) as ToolResult;
  const jobId = /[0-9a-f-]{36}/.exec(started.content[0]?.text ?? "")?.[0];
  assert.ok(jobId, `no job id in ${started.content[0]?.text}`);

  for (let attempt = 0; attempt < 200; attempt++) {
    const status = (await call("codex_job_status", { job_id: jobId })) as ToolResult;
    if (!/state: running/.test(status.content[0]?.text ?? "")) return jobId;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${jobId} never finished`);
}

test("reports an in-band error with no answer as a failed delegation", async () => {
  // Codex can report a failure as an error item while still exiting 0. Checking
  // the exit code alone handed that back to the orchestrator as a success.
  await withServer({}, async (call) => {
    nextRun = { events: [ERROR_ITEM], exitCode: 0 };
    const result = (await call("codex_delegate", { prompt: "anything", model: "cheap-model" })) as ToolResult;

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /model overloaded/);
  });
});

test("does not flag a delegation that recovered from an error and still answered", async () => {
  // `errors` also carries truncation notices and errors Codex got past. Flagging
  // those would teach the orchestrator to ignore isError altogether.
  await withServer({}, async (call) => {
    nextRun = { events: [ERROR_ITEM, ANSWER], exitCode: 0 };
    const result = (await call("codex_delegate", { prompt: "anything", model: "cheap-model" })) as ToolResult;

    assert.notEqual(result.isError, true);
  });
});

test("marks the result of a background job that exited non-zero as an error", async () => {
  await withServer({}, async (call) => {
    nextRun = { events: [], exitCode: 1 };
    const jobId = await runInBackground(call);

    const status = (await call("codex_job_status", { job_id: jobId })) as ToolResult;
    assert.match(status.content[0]?.text ?? "", /state: failed/);

    const result = (await call("codex_job_result", { job_id: jobId })) as ToolResult;
    assert.equal(result.isError, true);
  });
});

test("fails a background job whose only signal was an in-band error", async () => {
  await withServer({}, async (call) => {
    nextRun = { events: [ERROR_ITEM], exitCode: 0 };
    const jobId = await runInBackground(call);

    const status = (await call("codex_job_status", { job_id: jobId })) as ToolResult;
    assert.match(status.content[0]?.text ?? "", /state: failed/);
    assert.match(status.content[0]?.text ?? "", /model overloaded/);

    const result = (await call("codex_job_result", { job_id: jobId })) as ToolResult;
    assert.equal(result.isError, true);
  });
});

test("returns a successful background job without isError", async () => {
  await withServer({}, async (call) => {
    nextRun = { events: [ANSWER], exitCode: 0 };
    const jobId = await runInBackground(call);

    const result = (await call("codex_job_result", { job_id: jobId })) as ToolResult;
    assert.notEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Done\./);
  });
});
