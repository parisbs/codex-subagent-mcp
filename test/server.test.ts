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
    {
      slug: "narrow-model",
      visibility: "list",
      default_reasoning_level: "high",
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
    },
    {
      slug: "gapped-model",
      visibility: "list",
      default_reasoning_level: "high",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
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
  // An answered run by default: a clean exit with no answer is itself a failure.
  nextRun = { events: [{ type: "item.completed", item: { type: "agent_message", text: "Done." } }], exitCode: 0 };
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

for (const tool of ["codex_delegate", "codex_follow_up"]) {
  const input = { prompt: "continue", ...(tool === "codex_follow_up" ? { thread_id: "some-thread" } : {}) };

  test(`${tool} refuses without spawning when the ceiling excludes every supported effort`, async () => {
    await withServer({ CODEX_SUBAGENT_MAX_EFFORT: "low" }, async (call) => {
      const result = (await call(tool, { ...input, model: "narrow-model", reasoning_effort: "high" })) as ToolResult;
      assert.equal(spawnedArgs.length, 0, "nothing should have been spawned");
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /narrow-model.*medium, high.*ceiling "low"/);
    });
  });

  test(`${tool} uses a supported effort below an unsupported ceiling and reports the adjustment`, async () => {
    await withServer({ CODEX_SUBAGENT_MAX_EFFORT: "medium" }, async (call) => {
      const result = (await call(tool, { ...input, model: "gapped-model", reasoning_effort: "high" })) as ToolResult;
      assert.notEqual(result.isError, true);
      assert.equal(spawnedArgs.length, 1);
      assert.ok(spawnedArgs[0]?.includes('model_reasoning_effort="low"'));
      assert.match(result.content[0]?.text ?? "", /Notes:.*ceiling "medium".*using "low"/);
    });
  });

  test(`${tool} keeps capping to a ceiling the model supports`, async () => {
    await withServer({ CODEX_SUBAGENT_MAX_EFFORT: "medium" }, async (call) => {
      const result = (await call(tool, { ...input, model: "cheap-model", reasoning_effort: "high" })) as ToolResult;
      assert.notEqual(result.isError, true);
      assert.equal(spawnedArgs.length, 1);
      assert.ok(spawnedArgs[0]?.includes('model_reasoning_effort="medium"'));
      assert.match(result.content[0]?.text ?? "", /Notes:.*using "medium"/);
    });
  });

  test(`${tool} preserves closest-match clamping without a ceiling`, async () => {
    await withServer({}, async (call) => {
      const result = (await call(tool, { ...input, model: "gapped-model", reasoning_effort: "medium" })) as ToolResult;
      assert.notEqual(result.isError, true);
      assert.equal(spawnedArgs.length, 1);
      assert.ok(spawnedArgs[0]?.includes('model_reasoning_effort="low"'));
      assert.match(result.content[0]?.text ?? "", /Notes: gapped-model does not support reasoning effort "medium" \(supported: low, high\); using "low" instead\./);
    });
  });

  test(`${tool} resolves an omitted effort from the model default within the ceiling`, async () => {
    await withServer({ CODEX_SUBAGENT_MAX_EFFORT: "medium", CODEX_SUBAGENT_DEFAULT_MODEL: "gapped-model" }, async (call) => {
      const result = (await call(tool, input)) as ToolResult;
      assert.notEqual(result.isError, true);
      assert.equal(spawnedArgs.length, 1);
      assert.ok(spawnedArgs[0]?.includes('model_reasoning_effort="low"'));
      assert.match(result.content[0]?.text ?? "", /Notes:.*"high".*ceiling "medium".*using "low"/);
    });
  });

  test(`${tool} prefers the requested effort over the configured default and the model default`, async () => {
    await withServer({ CODEX_SUBAGENT_MAX_EFFORT: "high", CODEX_SUBAGENT_DEFAULT_EFFORT: "low" }, async (call) => {
      await call(tool, { ...input, model: "cheap-model", reasoning_effort: "high" });
      assert.ok(spawnedArgs[0]?.includes('model_reasoning_effort="high"'));
    });
  });

  test(`${tool} prefers the configured effort over the model default within the ceiling`, async () => {
    await withServer({ CODEX_SUBAGENT_MAX_EFFORT: "high", CODEX_SUBAGENT_DEFAULT_EFFORT: "medium" }, async (call) => {
      const result = (await call(tool, { ...input, model: "gapped-model" })) as ToolResult;
      assert.notEqual(result.isError, true);
      assert.ok(spawnedArgs[0]?.includes('model_reasoning_effort="low"'));
      assert.match(result.content[0]?.text ?? "", /Notes:.*"medium".*using "low"/);
    });
  });
}

test("advertises the configured default and refusal behaviour for the delegate model", async () => {
  const { server } = createServer();
  try {
    const tools = server as unknown as ToolServer;
    const delegate = tools._registeredTools.codex_delegate as {
      inputSchema: { shape: Record<string, { description?: string }> };
    };
    assert.equal(
      delegate.inputSchema.shape.model?.description,
      "Catalog slug from list_codex_models. If omitted, the configured default is used; with no default configured the call is refused and the recommended model is returned.",
    );
  } finally {
    await server.close();
  }
});

const DESCRIPTION_CASES = [
  {
    name: "advertises web search as live retrieval for the run",
    tool: "codex_delegate",
    parameter: "web_search",
    description: "Enable live web search for this run, through Codex's web_search = \"live\" setting. When omitted, Codex's own configured web_search mode applies.",
  },
  {
    name: "advertises effort defaults and the supported ceiling constraint",
    tool: "codex_delegate",
    parameter: "reasoning_effort",
    description: "Reasoning depth, independent of model choice. Uses the configured default or the model's default when omitted. Clamped to supported levels within the configured ceiling; refused if none qualify.",
  },
  {
    name: "advertises auto-approval only for the workspace-write sandbox",
    tool: "codex_delegate",
    parameter: "auto_approve",
    description: "Adds --approve-for-me so Codex auto-approves its own commands. Only applies when sandbox is workspace-write.",
  },
  {
    name: "describes the worktree without promising to restrict all writes to it",
    tool: "codex_delegate",
    parameter: "use_worktree",
    description: "Run in a managed git worktree. Writes outside it remain subject to the sandbox policy and add_dirs.",
  },
  {
    name: "discloses the catalog fallback in the tool description",
    tool: "list_codex_models",
    parameter: undefined,
    description: "List the Codex models available on this machine, with the reasoning-effort levels each one supports. Read from the installed Codex CLI, with a warned static fallback if its catalog cannot be read. Call this before codex_delegate when choosing a model explicitly.",
  },
  {
    name: "describes retained follow-up context without promising lower cost",
    tool: "codex_follow_up",
    parameter: undefined,
    description: "Send a follow-up message to a previous delegation using its thread_id. Codex retains the earlier context, so only the new instruction needs to be sent.",
  },
];

for (const entry of DESCRIPTION_CASES) {
  test(entry.name, async () => {
    const { server } = createServer();
    try {
      const tools = server as unknown as ToolServer;
      const tool = tools._registeredTools[entry.tool] as {
        description?: string;
        inputSchema: { shape: Record<string, { description?: string }> };
      };
      assert.equal(
        entry.parameter ? tool.inputSchema.shape[entry.parameter]?.description : tool.description,
        entry.description,
      );
    } finally {
      await server.close();
    }
  });
}

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

test("fails a delegation whose turn failed and names the reason", async () => {
  await withServer({}, async (call) => {
    nextRun = {
      events: [ANSWER, { type: "turn.failed", error: { message: "You've hit your usage limit." } }],
      exitCode: 1,
    };
    const result = (await call("codex_delegate", { prompt: "anything", model: "cheap-model" })) as ToolResult;

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /turn as failed: You've hit your usage limit\./);
  });
});

test("shows configuration notices without counting them as errors", async () => {
  await withServer({}, async (call) => {
    const notice = { type: "item.completed", item: { type: "error", message: "Ignored unsupported project-local config keys in x: notify." } };
    nextRun = { events: [notice, notice, ANSWER], exitCode: 0 };
    const result = (await call("codex_delegate", { prompt: "anything", model: "cheap-model" })) as ToolResult;
    const text = result.content[0]?.text ?? "";

    assert.notEqual(result.isError, true);
    assert.match(text, /Codex notices \(1\):/);
    assert.doesNotMatch(text, /error\(s\)/);
  });
});
