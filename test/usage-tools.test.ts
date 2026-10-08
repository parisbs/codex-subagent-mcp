import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import { createCodexHome, SESSION_META_LINE, turnContextLine } from "./fixtures/codex-home.ts";

/**
 * Acceptance tests for the usage log through the tools (#29, ADR 22, ADR 24).
 *
 * The harness is a copy of the one in `test/server.test.ts`: the real server, driven through the
 * SDK, with the Codex CLI replaced at the `child_process` boundary. Two differences matter here. A
 * spawned "Codex" reports a pid, because a delegation process counts once it has started; and with
 * a pid the server signals process groups and reads the process table, so `process.kill` and
 * `spawnSync` are replaced too, or a cancellation would signal whatever real process has that pid.
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

interface NextRun {
  events: unknown[];
  exitCode: number;
  /** Keep the child running until the test closes it. */
  hold?: boolean;
  /** Start without a pid and emit an `error` event, as a failed spawn does. */
  spawnError?: boolean;
  /** Throw from `spawn` itself. */
  spawnThrows?: boolean;
  stderr?: string;
}

type FakeChild = EventEmitter & Record<string, unknown>;

let spawnedArgs: string[][] = [];
let spawnedStdins: string[] = [];
let spawnedChildren: FakeChild[] = [];
let nextRun: NextRun = { events: [], exitCode: 0 };
let fakeVersion = "codex-cli 0.154.0";
let probedCwds: (string | undefined)[] = [];
let pendingRuns: Promise<unknown>[] = [];
let spawnBarrier = Promise.withResolvers<void>();
let signalled: number[] = [];
/** Runs inside every probe, before it answers: lets a test move a fake clock while probes run. */
let onProbe: (() => void) | undefined;

const fakeExecFile = async (
  _file: string,
  args: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> => {
  probedCwds.push(options?.cwd);
  onProbe?.();
  if (args[0] === "--version") return { stdout: fakeVersion, stderr: "" };
  if (args[0] === "mcp") return { stdout: "[]", stderr: "" };
  if (args[0] === "plugin") return { stdout: '{"installed":[],"available":[]}', stderr: "" };
  if (args[0] === "debug") return { stdout: JSON.stringify(CATALOG), stderr: "" };
  return { stdout: "Logged in using ChatGPT", stderr: "" };
};

// Callback-style execFile is what Windows termination uses (`taskkill`): answer at once.
cp.execFile = ((...args: unknown[]) => {
  const callback = args.findLast((arg) => typeof arg === "function") as ((error: Error | null) => void) | undefined;
  callback?.(null);
  return new EventEmitter();
}) as unknown as typeof cp.execFile;
(cp.execFile as unknown as Record<symbol, unknown>)[promisify.custom] = fakeExecFile;

// The process table is read through spawnSync (`ps`); report an empty one.
cp.spawnSync = (() => ({ pid: 0, status: 0, signal: null, output: [], stdout: "", stderr: "" })) as unknown as typeof cp.spawnSync;

cp.spawn = ((_file: string, args: string[]) => {
  const run = nextRun;
  if (run.spawnThrows) throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
  spawnedArgs.push(args);
  const stdinIndex = spawnedStdins.push("") - 1;
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdin: new PassThrough().on("data", (chunk: Buffer) => {
      spawnedStdins[stdinIndex] += chunk.toString("utf8");
    }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
    ...(run.spawnError ? {} : { pid: 424242 }),
  });
  spawnedChildren.push(child);
  spawnBarrier.resolve();
  setImmediate(() => {
    if (run.spawnError) {
      child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      return;
    }
    const stdout = child["stdout"] as PassThrough;
    for (const event of run.events) stdout.write(`${JSON.stringify(event)}\n`);
    if (run.stderr) (child["stderr"] as PassThrough).write(run.stderr);
    if (run.hold) return;
    child["exitCode"] = run.exitCode;
    setImmediate(() => child.emit("close", run.exitCode));
  });
  return child;
}) as unknown as typeof cp.spawn;

syncBuiltinESMExports();

const realKill = process.kill.bind(process);
process.kill = ((pid: number, signal?: string | number) => {
  // Only the fake children's pid, positive or as a group, ever reaches here from the server.
  if (Math.abs(pid) === 424242) {
    signalled.push(pid);
    return true;
  }
  return realKill(pid, signal);
}) as typeof process.kill;

const { createServer, SERVER_VERSION } = await import("../src/server.ts");
const { resetCatalogCache } = await import("../src/codex/catalog.ts");
const { resetDoctorCache } = await import("../src/codex/doctor.ts");
const { nodeUsageFileSystem, whenUsageIdle } = await import("../src/usage.ts");
type UsageFileSystem = import("../src/usage.ts").UsageFileSystem;

interface ToolServer {
  _registeredTools: Record<string, unknown>;
  validateToolInput: (tool: unknown, args: unknown, name: string) => Promise<unknown>;
  executeToolHandler: (tool: unknown, args: unknown, extra: unknown) => Promise<unknown>;
  close: () => Promise<void>;
}

type ToolResult = { content: { text: string }[]; isError?: boolean };
const textOf = (result: unknown) => (result as ToolResult).content[0]!.text;

interface Harness {
  call: (name: string, args: unknown) => Promise<unknown>;
  codexHome: ReturnType<typeof createCodexHome>;
  jobs: ReturnType<typeof createServer>["jobs"];
  controller: AbortController;
  stateHome: string;
  usageDir: string;
  /** Every parsed line of `usage.jsonl` and its archives. */
  lines: () => Record<string, unknown>[];
  /** Waits until every run started so far has settled and every usage write has finished. */
  settle: () => Promise<void>;
}

const ENV_KEYS = [
  "CODEX_SUBAGENT_MAX_DELEGATIONS_PER_HOUR",
  "CODEX_SUBAGENT_MAX_BACKGROUND_JOBS",
  "CODEX_SUBAGENT_MCP_SERVERS",
  "CODEX_SUBAGENT_PLUGINS",
  "CODEX_SUBAGENT_APPS",
  "CODEX_SUBAGENT_ALLOWED_MODELS",
  "CODEX_SUBAGENT_MAX_EFFORT",
  "CODEX_SUBAGENT_DEFAULT_MODEL",
  "CODEX_SUBAGENT_DEFAULT_EFFORT",
  "CODEX_SUBAGENT_DEFAULT_SANDBOX",
  "CODEX_SUBAGENT_MAX_SANDBOX",
  "CODEX_SUBAGENT_USAGE_LOG",
  "CODEX_BIN",
  "CODEX_HOME",
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
];

const ARCHIVE = /^usage-.+\.jsonl$/;

function readLines(usageDir: string): Record<string, unknown>[] {
  if (!existsSync(usageDir)) return [];
  const out: Record<string, unknown>[] = [];
  for (const file of readdirSync(usageDir).sort()) {
    if (file !== "usage.jsonl" && !ARCHIVE.test(file)) continue;
    for (const text of readFileSync(join(usageDir, file), "utf8").split("\n")) {
      if (text.trim() === "") continue;
      try {
        out.push(JSON.parse(text) as Record<string, unknown>);
      } catch {
        // Filler a test wrote is not an entry.
      }
    }
  }
  return out;
}

async function drain(): Promise<void> {
  await Promise.allSettled(pendingRuns);
  // Let the registry's result callbacks and the queued usage write run.
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  await whenUsageIdle();
}

async function withServer<T>(
  env: Record<string, string | undefined>,
  body: (harness: Harness) => Promise<T>,
  options: { stateHome?: string; usageFileSystem?: UsageFileSystem } = {},
): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const key of ["TMPDIR", "TEMP", "TMP"]) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
  }

  const ownStateHome = options.stateHome === undefined;
  const stateHome = options.stateHome ?? mkdtempSync(join(tmpdir(), "codex-subagent-state-"));
  process.env.CODEX_BIN = process.execPath;
  const codexHome = createCodexHome();
  process.env.CODEX_HOME = codexHome.path;
  process.env.XDG_STATE_HOME = stateHome;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  spawnedArgs = [];
  spawnedStdins = [];
  spawnedChildren = [];
  fakeVersion = "codex-cli 0.154.0";
  probedCwds = [];
  pendingRuns = [];
  signalled = [];
  onProbe = undefined;
  spawnBarrier = Promise.withResolvers<void>();
  resetCatalogCache();
  resetDoctorCache();
  nextRun = { events: [ANSWER], exitCode: 0 };

  const { server, jobs, runs } = createServer(
    options.usageFileSystem ? { usageFileSystem: options.usageFileSystem } : {},
  );
  const tools = server as unknown as ToolServer;
  const track = runs.track.bind(runs);
  runs.track = (handle) => {
    pendingRuns.push(handle.result);
    return track(handle);
  };
  const controller = new AbortController();
  const extra = { signal: controller.signal, sendNotification: async () => {} };
  const call = async (name: string, args: unknown): Promise<unknown> => {
    const tool = tools._registeredTools[name];
    assert.ok(tool, `tool ${name} is not registered`);
    const validated = await tools.validateToolInput(tool, args, name);
    return tools.executeToolHandler(tool, validated, extra);
  };
  const usageDir = join(stateHome, "codex-subagent-mcp");

  try {
    return await body({
      call,
      codexHome,
      jobs,
      controller,
      stateHome,
      usageDir,
      lines: () => readLines(usageDir),
      settle: drain,
    });
  } finally {
    jobs.cancelAll();
    for (const child of spawnedChildren) {
      if (child["exitCode"] === null) {
        child["exitCode"] = 0;
        child.emit("close", 0);
      }
    }
    await drain();
    await tools.close();
    codexHome.dispose();
    if (ownStateHome) rmSync(stateHome, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ON = { CODEX_SUBAGENT_USAGE_LOG: "on" };
const ANSWER = { type: "item.completed", item: { type: "agent_message", text: "Done." } };
const threadStarted = (threadId: string) => ({ type: "thread.started", thread_id: threadId });
const usage = (input: number, cached: number, output: number, reasoning: number) => ({
  type: "turn.completed",
  usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning },
});
const command = (text: string, output = "") => ({
  type: "item.completed",
  item: { type: "command_execution", command: text, aggregated_output: output, exit_code: 0, status: "completed" },
});
const SCHEMA = { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false };

/** A refusal is an isError result from the handler or a validation error from the SDK. */
async function refusal(pending: Promise<unknown>): Promise<string | null> {
  try {
    const result = (await pending) as ToolResult;
    return result.isError ? result.content[0]!.text : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function heldChild(): Promise<FakeChild> {
  await spawnBarrier.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  return spawnedChildren.at(-1)!;
}

function close(child: FakeChild, code = 0): void {
  child["exitCode"] = code;
  child.emit("close", code);
}

/** The single line a test expects, asserting first that there is exactly one. */
function only(lines: Record<string, unknown>[]): Record<string, unknown> {
  assert.equal(lines.length, 1, JSON.stringify(lines));
  return lines[0]!;
}

/** Exactly `count` lines, asserted before any is read. */
function exactly(count: number, lines: Record<string, unknown>[]): Record<string, unknown>[] {
  assert.equal(lines.length, count, JSON.stringify(lines));
  return lines;
}

const jobIdOf = (started: unknown) => {
  const id = /delegation ([0-9a-f-]{36})/.exec(textOf(started))?.[1];
  assert.ok(id, textOf(started));
  return id;
};

// AC-1: the log is off.

for (const value of [undefined, "", "   ", "off"]) {
  test(`AC-1 creates no usage-log file or directory when CODEX_SUBAGENT_USAGE_LOG is ${JSON.stringify(value)}`, async () => {
    await withServer({ CODEX_SUBAGENT_USAGE_LOG: value }, async (h) => {
      nextRun = { events: [threadStarted("off-thread"), { type: "item.completed", item: { type: "agent_message", text: '{"n":1}' } }], exitCode: 0 };
      const result = await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", output_schema: SCHEMA });
      assert.notEqual((result as ToolResult).isError, true, textOf(result));
      await h.settle();
      const args = spawnedArgs[0]!;
      const schemaPath = args[args.indexOf("--output-schema") + 1]!;
      assert.ok(args.includes("--output-schema"), JSON.stringify(args));
      assert.equal(existsSync(schemaPath), false, "the schema file is removed");
      assert.deepEqual(readdirSync(h.stateHome), []);
    });
  });
}

// AC-2: an invalid value refuses the delegation tools for the server's lifetime.

test("AC-2 refuses delegations and follow-ups while CODEX_SUBAGENT_USAGE_LOG is invalid, and codex_doctor lists it", async () => {
  await withServer({ CODEX_SUBAGENT_USAGE_LOG: "yes" }, async (h) => {
    const delegate = await refusal(h.call("codex_delegate", { prompt: "anything", model: "cheap-model" }));
    assert.match(delegate ?? "", /CODEX_SUBAGENT_USAGE_LOG/);
    // Fixing the environment later does not reach a running server: its configuration is read once.
    process.env.CODEX_SUBAGENT_USAGE_LOG = "on";
    const again = await refusal(h.call("codex_delegate", { prompt: "anything", model: "cheap-model" }));
    assert.match(again ?? "", /CODEX_SUBAGENT_USAGE_LOG/);
    const followUp = await refusal(h.call("codex_follow_up", { thread_id: "t1", prompt: "go", model: "cheap-model" }));
    assert.match(followUp ?? "", /CODEX_SUBAGENT_USAGE_LOG/);
    assert.equal(spawnedArgs.length, 0);
    const doctor = textOf(await h.call("codex_doctor", {}));
    assert.match(doctor, /CODEX_SUBAGENT_USAGE_LOG/);
    assert.deepEqual(h.lines(), []);
  });
});

// AC-3: one line per delegation process, and none for anything else.

type Mode = "blocking" | "background" | "follow-up";
type Outcome = "success" | "failure" | "timeout" | "cancelled";

for (const mode of ["blocking", "background", "follow-up"] as Mode[]) {
  for (const outcome of ["success", "failure", "timeout", "cancelled"] as Outcome[]) {
    test(`AC-3 appends exactly one line for a ${mode} run that ends in ${outcome}`, async (t: TestContext) => {
      await withServer(ON, async (h) => {
        const held = outcome === "timeout" || outcome === "cancelled";
        nextRun = {
          events: outcome === "success" ? [threadStarted("t-ac3"), ANSWER, usage(10, 4, 2, 1)] : [threadStarted("t-ac3")],
          exitCode: outcome === "failure" ? 1 : 0,
          hold: held,
        };
        if (outcome === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
        const pending = h.call(mode === "follow-up" ? "codex_follow_up" : "codex_delegate", {
          prompt: "anything",
          model: "cheap-model",
          thread_id: "t-ac3",
          timeout_seconds: 1,
          ...(mode === "background" ? { mode: "background" } : {}),
        });
        const jobId = mode === "background" ? jobIdOf(await pending) : undefined;
        if (held) {
          const child = await heldChild();
          if (outcome === "cancelled") {
            if (jobId) await h.call("codex_job_cancel", { job_id: jobId });
            else h.controller.abort();
          } else {
            t.mock.timers.tick(1000);
          }
          close(child);
        }
        if (!jobId) await pending;
        await h.settle();
        const lines = h.lines();
        assert.equal(lines.length, 1, JSON.stringify(lines));
        assert.equal(lines[0]!.outcome, outcome);
        assert.equal(lines[0]!.kind, mode === "follow-up" ? "follow-up" : "delegation");
        assert.equal(lines[0]!.mode, mode === "background" ? "background" : "blocking");
        if (held) assert.equal(lines[0]!.tokens, null, "a cancelled or timed-out run reported no tokens");
      });
    });
  }
}

test("AC-3 appends nothing for the preflight, catalog and listing probes", async () => {
  await withServer(ON, async (h) => {
    await h.call("codex_doctor", {});
    await h.call("list_codex_models", {});
    await h.call("codex_recommend", { task_description: "review a pull request" });
    assert.ok(probedCwds.length > 0, "the probes ran");
    assert.deepEqual(h.lines(), []);
  });
});

const preSpawnFailures: [string, Record<string, string | undefined>, () => Record<string, unknown>][] = [
  ["another variable is invalid", { CODEX_SUBAGENT_MAX_SANDBOX: "bogus" }, () => ({})],
  ["the preflight fails", { CODEX_BIN: join(tmpdir(), "no-such-codex-binary") }, () => ({})],
  ["the model is unknown", {}, () => ({ model: "no-such-model" })],
  ["the sandbox is above the ceiling", {}, () => ({ sandbox: "danger-full-access" })],
];

for (const [name, env, args] of preSpawnFailures) {
  test(`AC-3 appends nothing when ${name}`, async () => {
    await withServer({ ...ON, ...env }, async (h) => {
      const result = await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", ...args() });
      assert.equal((result as ToolResult).isError, true, textOf(result));
      await h.settle();
      assert.equal(spawnedArgs.length, 0);
      assert.deepEqual(h.lines(), []);
    });
  });
}

test("AC-3 appends nothing for a background delegation refused by the job cap", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [], exitCode: 0, hold: true };
    for (let i = 0; i < 8; i++) {
      jobIdOf(await h.call("codex_delegate", { prompt: "hold", model: "cheap-model", mode: "background" }));
    }
    const ninth = await h.call("codex_delegate", { prompt: "one more", model: "cheap-model", mode: "background" });
    assert.equal((ninth as ToolResult).isError, true, textOf(ninth));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await whenUsageIdle();
    assert.deepEqual(h.lines(), []);
  });
});

test("AC-3 appends nothing when the schema file cannot be created", async () => {
  await withServer(ON, async (h) => {
    const missing = join(tmpdir(), "codex-subagent-no-such-tmp", "nested");
    for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = missing;
    const result = await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", output_schema: SCHEMA });
    assert.equal((result as ToolResult).isError, true, textOf(result));
    await h.settle();
    assert.equal(spawnedArgs.length, 0);
    assert.deepEqual(h.lines(), []);
  });
});

test("AC-3 appends nothing when the child reports a spawn error and never starts", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [], exitCode: 0, spawnError: true };
    const result = await h.call("codex_delegate", { prompt: "anything", model: "cheap-model" });
    assert.equal((result as ToolResult).isError, true, textOf(result));
    await h.settle();
    assert.deepEqual(h.lines(), []);
  });
});

test("AC-3 appends nothing when spawn throws", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [], exitCode: 0, spawnThrows: true };
    const result = await h.call("codex_delegate", { prompt: "anything", model: "cheap-model" });
    assert.equal((result as ToolResult).isError, true, textOf(result));
    await h.settle();
    assert.deepEqual(h.lines(), []);
  });
});

test("AC-3 appends nothing when the cancellation arrived before the spawn", async () => {
  await withServer(ON, async (h) => {
    h.controller.abort();
    const result = await h.call("codex_delegate", { prompt: "anything", model: "cheap-model" });
    assert.equal((result as ToolResult).isError, true, textOf(result));
    await h.settle();
    assert.equal(spawnedArgs.length, 0);
    assert.deepEqual(h.lines(), []);
  });
});

// AC-4: a cancellation between the pipes closing and the job settling.

test("AC-4 records cancelled for a background job cancelled after its pipes closed but before it settled", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [threadStarted("late-cancel"), ANSWER, usage(10, 4, 2, 1)], exitCode: 0, hold: true };
    const jobId = jobIdOf(await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", mode: "background" }));
    const child = await heldChild();
    close(child);
    // Synchronously after close: the runner is still reading the applied settings.
    h.jobs.cancel(jobId);
    await h.settle();
    const lines = h.lines();
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0]!.outcome, "cancelled");
  });
});

test("AC-4 leaves the line alone when a job is cancelled after it settled", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [threadStarted("settled"), ANSWER, usage(10, 4, 2, 1)], exitCode: 0 };
    const jobId = jobIdOf(await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", mode: "background" }));
    await h.settle();
    await h.call("codex_job_cancel", { job_id: jobId });
    await h.settle();
    const lines = h.lines();
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0]!.outcome, "success");
  });
});

// AC-5: thread ids, tokens and unconfirmed settings.

test("AC-5 records a null thread id for a delegation that ended before Codex reported one", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [], exitCode: 1 };
    await h.call("codex_delegate", { prompt: "anything", model: "cheap-model" });
    await h.settle();
    assert.equal(only(h.lines()).thread_id, null);
  });
});

test("AC-5 records the requested thread id for a follow-up that ended before Codex reported one", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [], exitCode: 1 };
    await h.call("codex_follow_up", { thread_id: "requested-thread", prompt: "go", model: "cheap-model" });
    await h.settle();
    assert.equal(only(h.lines()).thread_id, "requested-thread");
  });
});

test("AC-5 records the thread Codex reported before the run failed, with unknown tokens", async () => {
  await withServer(ON, async (h) => {
    nextRun = {
      events: [threadStarted("reported-then-failed"), { type: "error", message: "boom" }, { type: "turn.failed", error: { message: "boom" } }],
      exitCode: 1,
    };
    await h.call("codex_delegate", { prompt: "anything", model: "cheap-model" });
    await h.settle();
    const entry = only(h.lines());
    assert.equal(entry.thread_id, "reported-then-failed");
    assert.equal(entry.outcome, "failure");
    assert.equal(entry.tokens, null);
  });
});

test("AC-5 records every token field as null when any counter is missing or invalid, and real zeros as zeros", async () => {
  await withServer(ON, async (h) => {
    const full = { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 };
    const cases: [string, unknown][] = [["no usage at all", undefined]];
    for (const counter of Object.keys(full)) {
      const without = { ...full } as Record<string, unknown>;
      delete without[counter];
      cases.push([`${counter} missing`, without]);
      for (const bad of [-1, 1.5, "7", null]) cases.push([`${counter}=${JSON.stringify(bad)}`, { ...full, [counter]: bad }]);
    }
    for (const [, value] of cases) {
      nextRun = {
        events: [threadStarted("tokens"), ANSWER, value === undefined ? { type: "turn.completed" } : { type: "turn.completed", usage: value }],
        exitCode: 0,
      };
      await h.call("codex_delegate", { prompt: "anything", model: "cheap-model" });
    }
    nextRun = { events: [threadStarted("zeros"), ANSWER, usage(0, 0, 0, 0)], exitCode: 0 };
    await h.call("codex_delegate", { prompt: "anything", model: "cheap-model" });
    await h.settle();
    const lines = h.lines();
    assert.equal(lines.length, cases.length + 1);
    cases.forEach(([name], index) => assert.equal(lines[index]!.tokens, null, name));
    assert.deepEqual(lines.at(-1)!.tokens, { input: 0, cached: 0, output: 0, reasoning: 0, uncached: 0 });
  });
});

test("AC-5 records unconfirmed applied settings as such, never copied from the requested ones", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [threadStarted("no-session-file"), ANSWER], exitCode: 0 };
    await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", reasoning_effort: "low" });
    await h.settle();
    const entry = only(h.lines());
    assert.deepEqual(entry.requested, { model: "cheap-model", effort: "low", sandbox: "read-only" });
    assert.deepEqual(entry.applied, { model: "unconfirmed", effort: "unconfirmed", sandbox: "unconfirmed" });
  });
});

test("AC-5 records the applied settings Codex's session file confirms", async () => {
  await withServer(ON, async (h) => {
    h.codexHome.write({
      threadId: "confirmed-thread",
      day: "2026-10-07",
      lines: [SESSION_META_LINE, turnContextLine({ cwd: process.cwd(), model: "cheap-model", effort: "high", sandbox_policy: { type: "read-only" } })],
    });
    nextRun = { events: [threadStarted("confirmed-thread"), ANSWER], exitCode: 0 };
    await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", reasoning_effort: "low" });
    await h.settle();
    const entry = only(h.lines());
    assert.deepEqual(entry.applied, { model: "cheap-model", effort: "high", sandbox: "read-only" });
  });
});

// AC-6: nothing from the call's inputs or the run's output.

test("AC-6 keeps every input and output of the run out of the entry, and keeps the label", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "SENTINEL-WORKDIR-"));
  const addDir = mkdtempSync(join(tmpdir(), "SENTINEL-ADDDIR-"));
  try {
    await withServer(ON, async (h) => {
      nextRun = {
        events: [
          threadStarted("private-thread"),
          command("SENTINEL-COMMAND --flag", "SENTINEL-COMMAND-OUTPUT"),
          { type: "item.completed", item: { type: "file_change", changes: [{ path: "SENTINEL-CHANGED.ts", kind: "add" }] } },
          { type: "item.completed", item: { type: "error", message: "SENTINEL-ITEM-ERROR" } },
          { type: "item.completed", item: { type: "agent_message", text: "SENTINEL-MESSAGE" } },
          { type: "error", message: "SENTINEL-TOP-ERROR" },
          { type: "turn.failed", error: { message: "SENTINEL-TURN-FAILED" } },
        ],
        exitCode: 1,
        stderr: "SENTINEL-STDERR",
      };
      await h.call("codex_delegate", {
        prompt: "SENTINEL-PROMPT",
        context: "SENTINEL-CONTEXT",
        system_instructions: "SENTINEL-SYSTEM",
        acceptance_criteria: ["SENTINEL-CRITERION"],
        target_files: ["SENTINEL-TARGET.ts"],
        output_schema: { ...SCHEMA, description: "SENTINEL-SCHEMA" },
        working_dir: workDir,
        add_dirs: [addDir],
        sandbox: "workspace-write",
        model: "cheap-model",
        label: "my-own-label",
      });
      await h.settle();
      assert.ok(existsSync(join(h.usageDir, "usage.jsonl")), "no usage.jsonl was written");
      const raw = readFileSync(join(h.usageDir, "usage.jsonl"), "utf8");
      assert.equal(raw.trim().split("\n").length, 1, raw);
      assert.doesNotMatch(raw, /SENTINEL/);
      assert.ok(!raw.includes(workDir) && !raw.includes(addDir), raw);
      assert.equal(JSON.parse(raw).label, "my-own-label");
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(addDir, { recursive: true, force: true });
  }
});

// AC-7: requested settings, flags and bounded text.

test("AC-7 records the requested model, effort and sandbox as passed to the CLI after defaults and clamping", async () => {
  await withServer(
    { ...ON, CODEX_SUBAGENT_DEFAULT_MODEL: "cheap-model", CODEX_SUBAGENT_MAX_EFFORT: "low", CODEX_SUBAGENT_DEFAULT_SANDBOX: "workspace-write" },
    async (h) => {
      nextRun = { events: [threadStarted("clamped"), ANSWER], exitCode: 0 };
      await h.call("codex_delegate", { prompt: "anything", reasoning_effort: "high" });
      await h.settle();
      const args = spawnedArgs[0]!;
      assert.equal(args[args.indexOf("--model") + 1], "cheap-model");
      assert.ok(args.includes('model_reasoning_effort="low"'), JSON.stringify(args));
      assert.deepEqual(only(h.lines()).requested, { model: "cheap-model", effort: "low", sandbox: "workspace-write" });
    },
  );
});

test("AC-7 sets each flag if and only if use_worktree is true, the array is non-empty, or a schema was given", async () => {
  await withServer(ON, async (h) => {
    const calls: [Record<string, unknown>, Record<string, boolean>][] = [
      [{}, { use_worktree: false, target_files: false, acceptance_criteria: false, output_schema: false }],
      [
        { use_worktree: false, target_files: [], acceptance_criteria: [] },
        { use_worktree: false, target_files: false, acceptance_criteria: false, output_schema: false },
      ],
      [
        { use_worktree: true, target_files: ["a.ts"], acceptance_criteria: ["works"], output_schema: SCHEMA },
        { use_worktree: true, target_files: true, acceptance_criteria: true, output_schema: true },
      ],
    ];
    for (const [args] of calls) {
      nextRun = { events: [threadStarted("flags"), { type: "item.completed", item: { type: "agent_message", text: '{"n":1}' } }], exitCode: 0 };
      await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", ...args });
    }
    await h.settle();
    const lines = h.lines();
    assert.equal(lines.length, calls.length);
    calls.forEach(([, expected], index) => assert.deepEqual(lines[index]!.flags, expected, JSON.stringify(calls[index]![0])));
  });
});

test("AC-7 cuts text taken from the CLI to 128 code points without splitting a character", async () => {
  await withServer(ON, async (h) => {
    const exact = "😀".repeat(128);
    const over = "😀".repeat(129);
    h.codexHome.write({
      threadId: "long-model-thread",
      day: "2026-10-07",
      lines: [SESSION_META_LINE, turnContextLine({ cwd: process.cwd(), model: over, effort: "low" })],
    });
    for (const id of [exact, over, "long-model-thread"]) {
      nextRun = { events: [threadStarted(id), ANSWER], exitCode: 0 };
      await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", reasoning_effort: "low" });
    }
    await h.settle();
    const [first, second, third] = exactly(3, h.lines());
    assert.equal(first!.thread_id, exact);
    const cut = second!.thread_id as string;
    assert.ok([...cut].length <= 128 && cut.isWellFormed() && exact.startsWith(cut), cut);
    const model = (third!.applied as { model: string }).model;
    assert.ok([...model].length <= 128 && model.isWellFormed() && over.startsWith(model), model);
  });
});

// AC-8: Windows without a usable directory.

test("AC-8 says in the result that nothing was written on Windows without XDG_STATE_HOME or LOCALAPPDATA", { skip: process.platform !== "win32" }, async () => {
  await withServer({ ...ON, XDG_STATE_HOME: undefined, LOCALAPPDATA: undefined }, async (h) => {
    nextRun = { events: [threadStarted("win"), ANSWER], exitCode: 0 };
    const result = await h.call("codex_delegate", { prompt: "anything", model: "cheap-model" });
    assert.notEqual((result as ToolResult).isError, true, textOf(result));
    assert.match(textOf(result), /not written/i);
    assert.match(textOf(result), /LOCALAPPDATA/);
  });
});

// AC-10: a write that fails changes nothing but the report.

test("AC-10 keeps the outcome of blocking delegations and follow-ups and says the entry was not written", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-subagent-blocked-"));
  try {
    writeFileSync(join(root, "a-file"), "");
    await withServer({ ...ON, XDG_STATE_HOME: join(root, "a-file", "state") }, async (h) => {
      nextRun = { events: [threadStarted("blocked"), ANSWER], exitCode: 0 };
      const ok = (await h.call("codex_delegate", { prompt: "anything", model: "cheap-model" })) as ToolResult;
      assert.notEqual(ok.isError, true, textOf(ok));
      assert.match(textOf(ok), /not written/i);

      nextRun = { events: [threadStarted("blocked"), ANSWER], exitCode: 1 };
      const failed = (await h.call("codex_delegate", { prompt: "anything", model: "cheap-model" })) as ToolResult;
      assert.equal(failed.isError, true);
      assert.match(textOf(failed), /not written/i);

      nextRun = { events: [threadStarted("blocked"), ANSWER], exitCode: 0 };
      const followUp = (await h.call("codex_follow_up", { thread_id: "blocked", prompt: "go" })) as ToolResult;
      assert.notEqual(followUp.isError, true, textOf(followUp));
      assert.match(textOf(followUp), /not written/i);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC-10 reports a background job's unwritten entry in codex_job_result", async () => {
  const appendFailure = async () => {
    throw Object.assign(new Error("injected append failure"), { code: "EIO" });
  };
  await withServer(ON, async (h) => {
    nextRun = { events: [threadStarted("bg-blocked"), ANSWER], exitCode: 0 };
    const jobId = jobIdOf(await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", mode: "background" }));
    await h.settle();
    const result = (await h.call("codex_job_result", { job_id: jobId })) as ToolResult;
    assert.notEqual(result.isError, true, textOf(result));
    assert.match(textOf(result), /not written/i);
    assert.match(textOf(result), /injected append failure/);
  }, { usageFileSystem: { ...nodeUsageFileSystem, appendFile: appendFailure } });
});

test("AC-10 writes the entry and says the archives could not be pruned when only their deletion fails", async () => {
  const unlinkFailure = async () => {
    throw Object.assign(new Error("injected unlink failure"), { code: "EPERM" });
  };
  await withServer(ON, async (h) => {
    mkdirSync(h.usageDir, { recursive: true });
    for (let day = 1; day <= 5; day++) {
      const name = join(h.usageDir, `usage-2026100${day}T000000000Z-1.jsonl`);
      writeFileSync(name, "");
      truncateSync(name, 10 * 1024 * 1024);
    }
    writeFileSync(join(h.usageDir, "usage.jsonl"), "");
    truncateSync(join(h.usageDir, "usage.jsonl"), 10 * 1024 * 1024);
    nextRun = { events: [threadStarted("prune"), ANSWER], exitCode: 0 };
    const result = (await h.call("codex_delegate", { prompt: "anything", model: "cheap-model" })) as ToolResult;
    assert.notEqual(result.isError, true, textOf(result));
    assert.match(textOf(result), /pruned/i);
    assert.doesNotMatch(textOf(result), /not written/i);
    assert.deepEqual(readLines(h.usageDir).map((line) => line.thread_id), ["prune"]);
  }, { usageFileSystem: { ...nodeUsageFileSystem, unlink: unlinkFailure } });
});

// AC-11: the label is validated before any CLI process and never sent to Codex.

test("AC-11 refuses an invalid label before any CLI process, on both tools", async () => {
  await withServer(ON, async (h) => {
    for (const label of ["", "a".repeat(65), "a\nb", "a‮b", "a\uD800b"]) {
      const delegate = await refusal(h.call("codex_delegate", { prompt: "anything", model: "cheap-model", label }));
      assert.ok(delegate, `delegate accepted ${JSON.stringify(label)}`);
      const followUp = await refusal(h.call("codex_follow_up", { thread_id: "t1", prompt: "go", model: "cheap-model", label }));
      assert.ok(followUp, `follow-up accepted ${JSON.stringify(label)}`);
    }
    assert.equal(spawnedArgs.length, 0);
    assert.deepEqual(probedCwds, []);
  });
});

test("AC-11 stores the label verbatim and keeps it out of the prompt sent to Codex", async () => {
  await withServer(ON, async (h) => {
    const label = "LBL é 😀  100% quota";
    nextRun = { events: [threadStarted("labelled"), ANSWER], exitCode: 0 };
    await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", label });
    await h.settle();
    assert.equal(only(h.lines()).label, label);
    assert.ok(!spawnedStdins[0]!.includes("LBL"), spawnedStdins[0]);
    assert.ok(!spawnedArgs[0]!.some((arg) => arg.includes("LBL")), JSON.stringify(spawnedArgs[0]));
  });
});

test("AC-11 accepts a label with the log off", async () => {
  await withServer({}, async (h) => {
    nextRun = { events: [threadStarted("off-label"), ANSWER], exitCode: 0 };
    const result = await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", label: "review" });
    assert.notEqual((result as ToolResult).isError, true, textOf(result));
    assert.equal(spawnedArgs.length, 1);
    assert.deepEqual(readdirSync(h.stateHome), []);
  });
});

// AC-12: follow-ups inherit the label through this server's registry only.

test("AC-12 lets follow-ups inherit the latest label of a spawned call, and ignores calls refused before spawning", async () => {
  await withServer(ON, async (h) => {
    const run = async (tool: string, args: Record<string, unknown>, exitCode = 0) => {
      nextRun = { events: [threadStarted("T1"), ANSWER], exitCode };
      await h.call(tool, { prompt: "go", model: "cheap-model", ...args });
    };
    await run("codex_delegate", { label: "L1" });
    await run("codex_follow_up", { thread_id: "T1" });
    await run("codex_follow_up", { thread_id: "T1", label: "L2" });
    await run("codex_follow_up", { thread_id: "T1" });
    // Refused before spawning: auto_approve, a spawn error, a schema file that cannot be written.
    assert.ok(await refusal(h.call("codex_follow_up", { thread_id: "T1", prompt: "go", auto_approve: true, label: "L3" })));
    nextRun = { events: [], exitCode: 0, spawnError: true };
    await h.call("codex_follow_up", { thread_id: "T1", prompt: "go", label: "L4" });
    const saved = ["TMPDIR", "TEMP", "TMP"].map((key) => [key, process.env[key]] as const);
    for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = join(tmpdir(), "codex-subagent-no-such-tmp", "x");
    await h.call("codex_follow_up", { thread_id: "T1", prompt: "go", label: "L5", output_schema: SCHEMA });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run("codex_follow_up", { thread_id: "T1" });
    // Spawned and failed: still recorded, and inherited.
    await run("codex_follow_up", { thread_id: "T1", label: "L6" }, 1);
    await run("codex_follow_up", { thread_id: "T1" });
    await h.settle();
    assert.deepEqual(h.lines().map((line) => line.label), ["L1", "L1", "L2", "L2", "L2", "L6", "L6"]);
  });
});

test("AC-12 records a null label for a follow-up on a thread recovered from the session file", async () => {
  await withServer(ON, async (h) => {
    h.codexHome.write({
      threadId: "recovered-thread",
      day: "2026-10-07",
      lines: [SESSION_META_LINE, turnContextLine({ cwd: process.cwd(), model: "cheap-model", effort: "low" })],
    });
    nextRun = { events: [threadStarted("recovered-thread"), ANSWER], exitCode: 0 };
    await h.call("codex_follow_up", { thread_id: "recovered-thread", prompt: "go" });
    await h.settle();
    assert.equal(only(h.lines()).label, null);
  });
});

test("AC-12 records a null label after a restart", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "codex-subagent-restart-"));
  try {
    await withServer(ON, async (h) => {
      nextRun = { events: [threadStarted("restart-thread"), ANSWER], exitCode: 0 };
      await h.call("codex_delegate", { prompt: "go", model: "cheap-model", label: "before-restart" });
    }, { stateHome });
    await withServer(ON, async (h) => {
      nextRun = { events: [threadStarted("restart-thread"), ANSWER], exitCode: 0 };
      await h.call("codex_follow_up", { thread_id: "restart-thread", prompt: "go", model: "cheap-model" });
      await h.settle();
      assert.deepEqual(h.lines().map((line) => line.label), ["before-restart", null]);
    }, { stateHome });
  } finally {
    rmSync(stateHome, { recursive: true, force: true });
  }
});

test("AC-12 records a null label once the thread was evicted from the registry", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [threadStarted("first-thread"), ANSWER], exitCode: 0 };
    await h.call("codex_delegate", { prompt: "go", model: "cheap-model", label: "evicted" });
    for (let i = 0; i < 500; i++) {
      nextRun = { events: [threadStarted(`filler-${i}`), ANSWER], exitCode: 0 };
      await h.call("codex_delegate", { prompt: "go", model: "cheap-model" });
    }
    nextRun = { events: [threadStarted("first-thread"), ANSWER], exitCode: 0 };
    await h.call("codex_follow_up", { thread_id: "first-thread", prompt: "go", model: "cheap-model" });
    await h.settle();
    assert.equal(exactly(502, h.lines()).at(-1)!.label, null);
  });
});

// AC-13 to AC-17: codex_usage through the tool.

function seed(usageDir: string, entries: Record<string, unknown>[]): void {
  mkdirSync(usageDir, { recursive: true });
  writeFileSync(join(usageDir, "usage.jsonl"), entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
}

function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    ended_at: new Date(Date.now() - 60_000).toISOString(),
    duration_ms: 1000,
    kind: "delegation",
    mode: "blocking",
    thread_id: "t",
    label: null,
    requested: { model: "cheap-model", effort: "low", sandbox: "read-only" },
    applied: { model: "cheap-model", effort: "low", sandbox: "read-only" },
    flags: { use_worktree: false, target_files: false, acceptance_criteria: false, output_schema: false },
    commands: 1,
    tokens: { input: 100, cached: 40, output: 10, reasoning: 2, uncached: 60 },
    outcome: "success",
    sandbox_ceiling: "workspace-write",
    server_version: "0.5.0",
    cli_version: "0.160.1",
    ...overrides,
  };
}

test("AC-13 summarises by model and says the summary combines every registration writing to the files", async () => {
  await withServer(ON, async (h) => {
    seed(h.usageDir, [stored(), stored(), stored({ applied: { model: "expensive-model", effort: "high", sandbox: "read-only" } })]);
    const result = (await h.call("codex_usage", {})) as ToolResult;
    assert.notEqual(result.isError, true, textOf(result));
    const text = textOf(result);
    assert.match(text, /cheap-model/);
    assert.match(text, /expensive-model/);
    assert.match(text, /registration/i);
    assert.doesNotMatch(text, /lower bound/i);
  });
});

test("AC-13 says the sums are a lower bound when an entry has unknown tokens", async () => {
  await withServer(ON, async (h) => {
    seed(h.usageDir, [stored(), stored({ tokens: null, outcome: "cancelled" })]);
    const text = textOf(await h.call("codex_usage", { group_by: "outcome" }));
    assert.match(text, /lower bound/i);
  });
});

test("AC-14 refuses since_hours outside greater than 0 and at most 8,760, naming the range", async () => {
  await withServer(ON, async (h) => {
    for (const since_hours of [0, -1, 8760.5, 8761]) {
      const message = await refusal(h.call("codex_usage", { since_hours }));
      assert.match(message ?? "", /8,?760/, String(since_hours));
    }
    for (const since_hours of [0.5, 8760]) {
      const result = (await h.call("codex_usage", { since_hours })) as ToolResult;
      assert.notEqual(result.isError, true, `${since_hours}: ${textOf(result)}`);
    }
  });
});

test("AC-15 reports how many lines were skipped and names a file it could not read", async () => {
  const readFailure = async (path: string) => {
    if (path.endsWith("usage-20261001T000000000Z-1.jsonl")) throw new Error("injected read failure");
    return nodeUsageFileSystem.readFile(path);
  };
  await withServer(ON, async (h) => {
    seed(h.usageDir, [stored()]);
    writeFileSync(join(h.usageDir, "usage.jsonl"), "not json\n{\"schema\":7}\n", { flag: "a" });
    writeFileSync(join(h.usageDir, "usage-20261001T000000000Z-1.jsonl"), `${JSON.stringify(stored())}\n`);
    const text = textOf(await h.call("codex_usage", {}));
    assert.match(text, /\b2\b[^\n]*skipped|skipped[^\n]*\b2\b/i);
    assert.match(text, /usage-20261001T000000000Z-1\.jsonl/);
  }, { usageFileSystem: { ...nodeUsageFileSystem, readFile: readFailure } });
});

test("AC-15 says there is nothing to summarise when no file exists", async () => {
  await withServer(ON, async (h) => {
    const text = textOf(await h.call("codex_usage", {}));
    assert.match(text, /nothing to summari[sz]e/i);
  });
});

test("AC-16 says the log is off, names the variable, and still summarises existing files", async () => {
  await withServer({}, async (h) => {
    seed(h.usageDir, [stored({ label: "left-from-before" })]);
    const text = textOf(await h.call("codex_usage", { group_by: "label" }));
    assert.match(text, /CODEX_SUBAGENT_USAGE_LOG/);
    assert.match(text, /\boff\b/i);
    assert.match(text, /left-from-before/);
  });
});

test("AC-16 never runs the CLI preflight", async () => {
  for (const env of [ON, {}]) {
    await withServer(env, async (h) => {
      seed(h.usageDir, [stored()]);
      await h.call("codex_usage", {});
      assert.deepEqual(probedCwds, []);
      assert.equal(spawnedArgs.length, 0);
    });
  }
});

test("AC-17 computes no quota, usage-window share, credit or currency figure, and shows labels as written", async () => {
  await withServer(ON, async (h) => {
    const label = "100% quota $5 credit";
    seed(h.usageDir, [stored({ label }), stored({ label: "é 😀" }), stored({ tokens: null })]);
    for (const group_by of ["model", "label", "outcome", "kind"]) {
      const text = textOf(await h.call("codex_usage", { group_by }));
      if (group_by === "label") {
        assert.ok(text.includes(label), text);
        assert.ok(text.includes("é 😀"), text);
      }
      // A sentence saying what the tool never reports is fine; a figure of that kind is not.
      const computed = text.split(label).join("").split("é 😀").join("");
      assert.doesNotMatch(computed, /\d\s*%/, group_by);
      assert.doesNotMatch(computed, /[$€£]\s*\d|\d\s*(USD|EUR|GBP)\b/i, group_by);
      assert.doesNotMatch(computed, /\d[\d,.]*\s*credits?\b/i, group_by);
      assert.doesNotMatch(computed, /^(?=.*\b(quota|allowance|usage window|remaining)\b).*\d/im, group_by);
    }
  });
});

// AC-18: the shape of an entry.

test("AC-18 writes every field of schema 1 with the server's and the CLI's values", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [threadStarted("shape"), command("ls"), command("pwd"), ANSWER, usage(100, 40, 7, 3)], exitCode: 0 };
    await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", reasoning_effort: "low" });
    nextRun = { events: [threadStarted("shape"), ANSWER], exitCode: 0 };
    jobIdOf(await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", mode: "background" }));
    await h.settle();
    nextRun = { events: [threadStarted("shape"), ANSWER], exitCode: 0 };
    await h.call("codex_follow_up", { thread_id: "shape", prompt: "go" });
    await h.settle();
    const [blocking, background, followUp] = exactly(3, h.lines());
    assert.deepEqual(Object.keys(blocking!).sort(), [
      "applied", "cli_version", "commands", "duration_ms", "ended_at", "flags", "kind", "label", "mode", "outcome",
      "requested", "sandbox_ceiling", "schema", "server_version", "thread_id", "tokens",
    ]);
    assert.equal(blocking!.schema, 1);
    assert.equal(blocking!.kind, "delegation");
    assert.equal(blocking!.mode, "blocking");
    assert.equal(blocking!.commands, 2);
    assert.deepEqual(blocking!.tokens, { input: 100, cached: 40, output: 7, reasoning: 3, uncached: 60 });
    assert.equal(blocking!.sandbox_ceiling, "workspace-write");
    assert.equal(blocking!.server_version, SERVER_VERSION);
    assert.equal(blocking!.cli_version, "0.154.0");
    assert.equal(new Date(blocking!.ended_at as string).toISOString(), blocking!.ended_at);
    assert.equal(typeof blocking!.duration_ms, "number");
    assert.equal(background!.mode, "background");
    assert.equal(followUp!.kind, "follow-up");
    assert.equal(followUp!.mode, "blocking");
  });
});

// AC-19: a timeout is recorded when it settles the run.

test("AC-19 writes a timed-out run's line without waiting for the process to exit, and later output changes nothing", async (t) => {
  await withServer(ON, async (h) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    nextRun = { events: [threadStarted("slow"), command("one"), command("two")], exitCode: 0, hold: true };
    const pending = h.call("codex_delegate", { prompt: "anything", model: "cheap-model", timeout_seconds: 1 });
    const child = await heldChild();
    t.mock.timers.tick(1000);
    const result = (await pending) as ToolResult;
    assert.equal(result.isError, true);
    await whenUsageIdle();
    const before = h.lines();
    assert.equal(before.length, 1, JSON.stringify(before));
    assert.equal(before[0]!.outcome, "timeout");
    assert.equal(before[0]!.commands, 2);
    assert.equal(before[0]!.tokens, null);
    const stdout = child["stdout"] as PassThrough;
    stdout.write(`${JSON.stringify(command("three"))}\n`);
    stdout.write(`${JSON.stringify(usage(10, 4, 2, 1))}\n`);
    close(child);
    await h.settle();
    assert.deepEqual(h.lines(), before);
  });
});

// AC-20: end time and duration on a fake clock.

for (const mode of ["blocking", "background"] as const) {
  test(`AC-20 times a ${mode} run from its spawn to the moment its outcome became final`, async (t) => {
    await withServer(ON, async (h) => {
      const start = Date.parse("2026-10-07T12:00:00.000Z");
      t.mock.timers.enable({ apis: ["Date"], now: start });
      // Probes before the spawn take three seconds that the duration must not count.
      onProbe = () => t.mock.timers.tick(1000);
      nextRun = { events: [threadStarted(`clock-${mode}`), ANSWER], exitCode: 0, hold: true };
      const pending = h.call("codex_delegate", {
        prompt: "anything",
        model: "cheap-model",
        ...(mode === "background" ? { mode } : {}),
      });
      const jobId = mode === "background" ? jobIdOf(await pending) : undefined;
      const child = await heldChild();
      onProbe = undefined;
      const spawnedAt = Date.now();
      t.mock.timers.tick(5000);
      close(child);
      // The process has exited; the outcome becomes final only after the applied settings are read.
      t.mock.timers.tick(2000);
      if (!jobId) await pending;
      await h.settle();
      const entry = only(h.lines());
      assert.ok(spawnedAt - start >= 3000, "the probes advanced the clock");
      assert.equal(entry.duration_ms, 7000);
      assert.equal(entry.ended_at, new Date(spawnedAt + 7000).toISOString());
    });
  });
}

// AC-21: a follow-up's own tokens.

test("AC-21 records a follow-up's tokens as the reported total minus the thread's previous total", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [threadStarted("delta"), ANSWER, usage(1000, 400, 50, 5)], exitCode: 0 };
    await h.call("codex_delegate", { prompt: "go", model: "cheap-model" });
    nextRun = { events: [threadStarted("delta"), ANSWER, usage(1500, 600, 80, 9)], exitCode: 0 };
    await h.call("codex_follow_up", { thread_id: "delta", prompt: "more" });
    await h.settle();
    const [, followUp] = exactly(2, h.lines());
    assert.deepEqual(followUp!.tokens, { input: 500, cached: 200, output: 30, reasoning: 4, uncached: 300 });
  });
});

test("AC-21 records null tokens for a follow-up whose thread has no total in this server", async () => {
  await withServer(ON, async (h) => {
    h.codexHome.write({
      threadId: "recovered-delta",
      day: "2026-10-07",
      lines: [SESSION_META_LINE, turnContextLine({ cwd: process.cwd(), model: "cheap-model", effort: "low" })],
    });
    nextRun = { events: [threadStarted("unknown-delta"), ANSWER, usage(1500, 600, 80, 9)], exitCode: 0 };
    await h.call("codex_follow_up", { thread_id: "unknown-delta", prompt: "more", model: "cheap-model" });
    nextRun = { events: [threadStarted("recovered-delta"), ANSWER, usage(1500, 600, 80, 9)], exitCode: 0 };
    await h.call("codex_follow_up", { thread_id: "recovered-delta", prompt: "more" });
    await h.settle();
    assert.deepEqual(h.lines().map((line) => line.tokens), [null, null]);
  });
});

// Regressions found by reviewing the implementation (#29), added to the oracle with the maintainer's approval.

test("AC-4 AC-5 keeps the tokens a background run reported before a late cancellation", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [threadStarted("late-cancel-tokens"), ANSWER, usage(10, 4, 2, 1)], exitCode: 0, hold: true };
    const jobId = jobIdOf(await h.call("codex_delegate", { prompt: "anything", model: "cheap-model", mode: "background" }));
    const child = await heldChild();
    close(child);
    h.jobs.cancel(jobId);
    await h.settle();
    const entry = only(h.lines());
    assert.equal(entry.outcome, "cancelled");
    assert.deepEqual(entry.tokens, { input: 10, cached: 4, output: 2, reasoning: 1, uncached: 6 });
  });
});

test("AC-21 derives a follow-up's tokens when Codex reported usage but no thread, and keeps the next turn exact", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [threadStarted("no-thread-usage"), ANSWER, usage(1000, 400, 50, 5)], exitCode: 0 };
    await h.call("codex_delegate", { prompt: "go", model: "cheap-model" });
    nextRun = { events: [ANSWER, usage(1500, 600, 80, 9)], exitCode: 0 };
    await h.call("codex_follow_up", { thread_id: "no-thread-usage", prompt: "more" });
    nextRun = { events: [threadStarted("no-thread-usage"), ANSWER, usage(1800, 700, 90, 10)], exitCode: 0 };
    await h.call("codex_follow_up", { thread_id: "no-thread-usage", prompt: "more" });
    await h.settle();
    const [, second, third] = exactly(3, h.lines());
    assert.equal(second.thread_id, "no-thread-usage");
    assert.deepEqual(second.tokens, { input: 500, cached: 200, output: 30, reasoning: 4, uncached: 300 });
    assert.deepEqual(third.tokens, { input: 300, cached: 100, output: 10, reasoning: 1, uncached: 200 });
  });
});

test("AC-21 never charges a follow-up for an earlier spawned turn that reported neither thread nor usage", async () => {
  await withServer(ON, async (h) => {
    nextRun = { events: [threadStarted("silent-turn"), ANSWER, usage(1000, 400, 50, 5)], exitCode: 0 };
    await h.call("codex_delegate", { prompt: "go", model: "cheap-model" });
    nextRun = { events: [], exitCode: 1 };
    await h.call("codex_follow_up", { thread_id: "silent-turn", prompt: "more" });
    // The cumulative total now includes whatever the silent turn spent; it cannot be told apart.
    nextRun = { events: [threadStarted("silent-turn"), ANSWER, usage(1800, 700, 90, 10)], exitCode: 0 };
    await h.call("codex_follow_up", { thread_id: "silent-turn", prompt: "more" });
    await h.settle();
    const [, silent, next] = exactly(3, h.lines());
    assert.equal(silent.thread_id, "silent-turn");
    assert.equal(silent.tokens, null);
    assert.equal(next.tokens, null);
  });
});
