import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import { createCodexHome, SESSION_META_LINE, turnContextLine } from "./fixtures/codex-home.ts";

/**
 * Acceptance tests for the delegation bound (#62, ADR 23, ADR 25).
 *
 * The harness is a copy of the one in `test/usage-tools.test.ts`: the real server, driven through
 * the SDK, with the Codex CLI replaced at the `child_process` boundary. It adds what these criteria
 * need: probes that can be held so that calls wait before their spawn, a signal per call so that
 * one request can be cancelled alone, injectable probe failures, the argv and time of every spawn,
 * and a spy on `readdir` that sees a follow-up reading Codex's session directory.
 *
 * Every wait has a deadline in real time, read from `performance.now()`, which no fake clock
 * replaces: a call that is wrongly admitted with a held process must fail its test, not hang it.
 */

const HOURLY = "CODEX_SUBAGENT_MAX_DELEGATIONS_PER_HOUR";
const CAP = "CODEX_SUBAGENT_MAX_BACKGROUND_JOBS";
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** How long anything may take before the test fails instead of waiting. */
const DEADLINE_MS = 5000;
/** A refusal starts no process, so it must come back well within this. */
const REFUSAL_DEADLINE_MS = 2000;
const CAP_8_MESSAGE =
  "Too many background delegations already running (limit 8). Wait for one to finish or cancel it with codex_job_cancel.";

const CATALOG = {
  models: [
    {
      slug: "cheap-model",
      visibility: "list",
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
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
}

type FakeChild = EventEmitter & Record<string, unknown>;

interface Hold {
  when: (args: string[]) => boolean;
  /** How many probes to hold before `entered` resolves. */
  limit: number;
  held: number;
  entered: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
}

let nextRun: NextRun = { events: [], exitCode: 0 };
/** Every call to `spawn`, including one that throws. */
let spawnCalls = 0;
/** The argv of every call to `spawn`, in order. */
let spawnArgs: string[][] = [];
let children: FakeChild[] = [];
/** `Date.now()` at each spawn that produced a pid, in order. */
let spawnTimes: number[] = [];
let probes: string[] = [];
let hold: Hold | undefined;
/** Runs once, inside the next probe. */
let onNextProbe: (() => void) | undefined;
let failProbe: string | undefined;
let mcpList = "[]";
let catalogOutput = JSON.stringify(CATALOG);
let pendingRuns: Promise<unknown>[] = [];
let readdirPaths: string[] = [];

const fakeExecFile = async (_file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
  probes.push(args.join(" "));
  const hook = onNextProbe;
  onNextProbe = undefined;
  hook?.();
  if (hold && hold.held < hold.limit && hold.when(args)) {
    hold.held += 1;
    if (hold.held === hold.limit) hold.entered.resolve();
    await hold.release.promise;
  }
  if (failProbe !== undefined && args[0] === failProbe) {
    throw Object.assign(new Error(`spawn ${failProbe} ENOENT`), { code: "ENOENT" });
  }
  if (args[0] === "--version") return { stdout: "codex-cli 0.154.0", stderr: "" };
  if (args[0] === "mcp") return { stdout: mcpList, stderr: "" };
  if (args[0] === "plugin") return { stdout: '{"installed":[],"available":[]}', stderr: "" };
  if (args[0] === "debug") return { stdout: catalogOutput, stderr: "" };
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
  spawnCalls += 1;
  spawnArgs.push([...args]);
  if (run.spawnThrows) throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
    ...(run.spawnError ? {} : { pid: 424242 }),
  });
  if (!run.spawnError) spawnTimes.push(Date.now());
  children.push(child);
  setImmediate(() => {
    if (run.spawnError) {
      child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      return;
    }
    const stdout = child["stdout"] as PassThrough;
    for (const event of run.events) stdout.write(`${JSON.stringify(event)}\n`);
    if (run.hold) return;
    child["exitCode"] = run.exitCode;
    setImmediate(() => child.emit("close", run.exitCode));
  });
  return child;
}) as unknown as typeof cp.spawn;

// A follow-up recovering its thread lists Codex's session directory; record every listing.
const realReaddir = fsp.readdir.bind(fsp);
fsp.readdir = (async (path: Parameters<typeof fsp.readdir>[0], ...rest: unknown[]) => {
  readdirPaths.push(String(path));
  return (realReaddir as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
}) as typeof fsp.readdir;

syncBuiltinESMExports();

const realKill = process.kill.bind(process);
process.kill = ((pid: number, signal?: string | number) => {
  // Only the fake children's pid, positive or as a group, ever reaches here from the server. The
  // group is alive while one of them runs, so a liveness check after the last close finds none.
  if (Math.abs(pid) === 424242) {
    const alive = children.some((child) => child["pid"] !== undefined && child["exitCode"] === null);
    if (signal === 0 && !alive) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    return true;
  }
  return realKill(pid, signal);
}) as typeof process.kill;

const { createServer } = await import("../src/server.ts");
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
  /** Each call gets its own signal unless one is passed. */
  call: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
  codexHome: ReturnType<typeof createCodexHome>;
  jobs: ReturnType<typeof createServer>["jobs"];
  stateHome: string;
  /** Waits until every run started so far has settled. Never call it while a held run is open. */
  settle: () => Promise<void>;
}

const ENV_KEYS = [
  HOURLY,
  CAP,
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
const TMP_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Resolves with `pending`, or fails the test once `ms` of real time pass without it settling. */
async function within<T>(pending: Promise<T>, what: string, ms = DEADLINE_MS): Promise<T> {
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  const start = performance.now();
  while (!settled && performance.now() - start < ms) await tick();
  assert.ok(settled, `${what}: still pending after ${ms} ms`);
  return pending;
}

async function drain(): Promise<void> {
  await within(Promise.allSettled(pendingRuns), "a delegation run never settled");
  // Let the registry's result callbacks and any queued usage write run.
  for (let i = 0; i < 5; i++) await tick();
  await within(whenUsageIdle(), "a usage write never finished");
}

function closeOpenChildren(): void {
  for (const child of children) {
    if (child["pid"] !== undefined && child["exitCode"] === null) {
      child["exitCode"] = 0;
      child.emit("close", 0);
    }
  }
}

async function withServer<T>(
  env: Record<string, string | undefined>,
  body: (harness: Harness) => Promise<T>,
  options: { stateHome?: string; usageFileSystem?: UsageFileSystem } = {},
): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const ownStateHome = options.stateHome === undefined;
  let stateHome: string | undefined;
  let codexHome: ReturnType<typeof createCodexHome> | undefined;
  let tools: ToolServer | undefined;
  let jobs: ReturnType<typeof createServer>["jobs"] | undefined;
  const controllers: AbortController[] = [];
  const inflight: Promise<unknown>[] = [];

  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const key of TMP_KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
    }
    stateHome = options.stateHome ?? mkdtempSync(join(tmpdir(), "codex-subagent-state-"));
    process.env.CODEX_BIN = process.execPath;
    codexHome = createCodexHome();
    process.env.CODEX_HOME = codexHome.path;
    process.env.XDG_STATE_HOME = stateHome;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    nextRun = { events: [ANSWER], exitCode: 0 };
    spawnCalls = 0;
    spawnArgs = [];
    children = [];
    spawnTimes = [];
    probes = [];
    hold = undefined;
    onNextProbe = undefined;
    failProbe = undefined;
    mcpList = "[]";
    catalogOutput = JSON.stringify(CATALOG);
    pendingRuns = [];
    readdirPaths = [];
    resetCatalogCache();
    resetDoctorCache();

    const created = createServer(options.usageFileSystem ? { usageFileSystem: options.usageFileSystem } : {});
    jobs = created.jobs;
    const server = created.server as unknown as ToolServer;
    tools = server;
    const track = created.runs.track.bind(created.runs);
    created.runs.track = (handle) => {
      pendingRuns.push(handle.result);
      return track(handle);
    };
    const call = (name: string, args: unknown, signal?: AbortSignal): Promise<unknown> => {
      const tool = server._registeredTools[name];
      assert.ok(tool, `tool ${name} is not registered`);
      const controller = new AbortController();
      controllers.push(controller);
      const pending = (async () => {
        const validated = await server.validateToolInput(tool, args, name);
        return server.executeToolHandler(tool, validated, {
          signal: signal ?? controller.signal,
          sendNotification: async () => {},
        });
      })();
      inflight.push(pending.catch(() => {}));
      return pending;
    };

    return await body({ call, codexHome, jobs, stateHome, settle: drain });
  } finally {
    try {
      hold?.release.resolve();
      onNextProbe = undefined;
      // A released call may still spawn, so stop everything until every call has returned.
      let returned = false;
      void Promise.allSettled(inflight).then(() => (returned = true));
      const start = performance.now();
      while (!returned && performance.now() - start < DEADLINE_MS) {
        jobs?.cancelAll();
        for (const controller of controllers) controller.abort();
        closeOpenChildren();
        await tick();
      }
      jobs?.cancelAll();
      closeOpenChildren();
      try {
        await drain();
      } catch {
        // The test has already failed or passed; cleanup must still run to the end.
      }
      await tools?.close();
    } finally {
      codexHome?.dispose();
      if (ownStateHome && stateHome) rmSync(stateHome, { recursive: true, force: true });
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}

/** Holds the next `limit` probes that `when` accepts, until the test releases them. */
function holdProbes(limit = 1, when: (args: string[]) => boolean = () => true): Hold {
  hold = { when, limit, held: 0, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  return hold;
}

const entered = (held: Hold) => within(held.entered.promise, "the held probe was never reached");

const ANSWER = { type: "item.completed", item: { type: "agent_message", text: "Done." } };
const threadStarted = (threadId: string) => ({ type: "thread.started", thread_id: threadId });

type Kind = "blocking" | "background" | "follow-up";
const KINDS: Kind[] = ["blocking", "background", "follow-up"];

/** Arguments for one entry point. A follow-up names its directory, so it never reads a session file. */
function argsFor(kind: Kind, extra: Record<string, unknown> = {}): [string, Record<string, unknown>] {
  if (kind === "follow-up") {
    return ["codex_follow_up", { thread_id: "t-follow", prompt: "go on", model: "cheap-model", working_dir: process.cwd(), ...extra }];
  }
  return [
    "codex_delegate",
    { prompt: "anything", model: "cheap-model", ...(kind === "background" ? { mode: "background" } : {}), ...extra },
  ];
}

const callKind = (h: Harness, kind: Kind, extra: Record<string, unknown> = {}, signal?: AbortSignal) => {
  const [name, args] = argsFor(kind, extra);
  return h.call(name, args, signal);
};

function assertAdmitted(result: unknown, context = ""): void {
  assert.notEqual((result as ToolResult).isError, true, `${context || "the call"} was refused: ${textOf(result)}`);
}

function assertRefused(result: unknown, pattern: RegExp, context = ""): string {
  const text = textOf(result);
  assert.equal((result as ToolResult).isError, true, `${context || "the call"} was not refused: ${text}`);
  assert.match(text, pattern);
  return text;
}

/** A refusal starts no process, so it comes back at once; a wrongly admitted call fails here. */
async function refusedPromptly(pending: Promise<unknown>, pattern: RegExp, context = ""): Promise<string> {
  const result = await within(pending, `${context || "the call"} was not refused`, REFUSAL_DEADLINE_MS);
  return assertRefused(result, pattern, context);
}

const jobIdOf = (started: unknown) => {
  const id = /delegation ([0-9a-f-]{36})/.exec(textOf(started))?.[1];
  assert.ok(id, textOf(started));
  return id;
};

async function doctorText(h: Harness): Promise<string> {
  return textOf(await within(h.call("codex_doctor", {}), "codex_doctor"));
}

function lineOf(text: string, label: string): string {
  const match = new RegExp(`^${label}: (.*)$`, "m").exec(text);
  assert.ok(match, `codex_doctor has no "${label}" line:\n${text}`);
  return match[1]!;
}

async function counts(h: Harness): Promise<{ processes: number; pending: number }> {
  const text = await doctorText(h);
  return {
    processes: Number(lineOf(text, "delegation processes in the last hour")),
    pending: Number(lineOf(text, "calls holding a slot before spawning")),
  };
}

/** Waits for `count` calls to `spawn` in total, and returns the last of them. */
async function spawned(count: number): Promise<FakeChild> {
  const start = performance.now();
  while (spawnCalls < count && performance.now() - start < DEADLINE_MS) await tick();
  assert.ok(spawnCalls >= count, `expected ${count} spawns, saw ${spawnCalls}`);
  await tick();
  await tick();
  return children[count - 1]!;
}

function close(child: FakeChild, code = 0): void {
  child["exitCode"] = code;
  child.emit("close", code);
}

/** Is `path` the directory `root` or inside it, however either is spelled? */
function isInside(path: string, root: string): boolean {
  const normalise = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  for (const base of new Set([root, realpathSync(root)])) {
    const rel = relative(normalise(base), normalise(path));
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

/** A refusal must report no spend figure: the words are allowed, numbers attached to them are not. */
function assertNoSpendFigure(text: string): void {
  assert.doesNotMatch(text, /\d\s*%/);
  assert.doesNotMatch(text, /\d[\d,.]*\s*(tokens?|credits?|quota)\b/i);
  assert.doesNotMatch(text, /\b(tokens?|credits?|quota)\b\s*(remaining|left|available|used)?\s*(:|=|of)?\s*\d/i);
}

/** The variable and the value it is set to, close together, in either order. */
const namesValue = (variable: string, value: number) =>
  new RegExp(`${variable}\\D{0,40}\\b${value}\\b|\\b${value}\\b\\D{0,40}${variable}`);

const USER_LIMIT = [/user/i, /limit/i];
const RAISE = /raise|increase|higher/i;
const DO_NOT_RETRY = /(do not|don't|not) (retry|try again|call again)/i;
const NOT_A_PROMISE =
  /not (a )?(promise|guarantee)|(does not|doesn't|cannot|can't) (promise|guarantee)|no guarantee|not guaranteed/i;

function assertTellsCallerToStop(text: string, value: number): void {
  assert.match(text, namesValue(HOURLY, value));
  for (const pattern of USER_LIMIT) assert.match(text, pattern);
  assert.match(text, DO_NOT_RETRY);
  assert.match(text, RAISE);
  assertNoSpendFigure(text);
}

const T0 = Date.parse("2026-10-08T12:00:00.000Z");

// AC-1: no hourly bound unless the variable is set.

for (const value of [undefined, "", "   "]) {
  test(`AC-1 applies no hourly bound when ${HOURLY} is ${JSON.stringify(value)}, and still counts for codex_doctor`, async () => {
    await withServer({ [HOURLY]: value }, async (h) => {
      for (const kind of KINDS) {
        for (let i = 0; i < 9; i++) {
          assertAdmitted(await callKind(h, kind), `${kind} call ${i + 1}`);
          await h.settle();
        }
      }
      assert.equal(spawnTimes.length, 27);
      const text = await doctorText(h);
      assert.equal(lineOf(text, "hourly delegation bound"), `none (${HOURLY} is unset)`);
      assert.equal(lineOf(text, "delegation processes in the last hour"), "27");
      assert.equal(lineOf(text, "calls holding a slot before spawning"), "0");
    });
  });
}

// AC-2: plain decimal digits in range, read once.

const INVALID_VALUES = ["0", "+5", "-1", "5.0", "1e3", "1_000", "9007199254740992", "５", "1 0", "five"];

for (const [variable, values] of [
  [HOURLY, INVALID_VALUES],
  [CAP, [...INVALID_VALUES, "9"]],
] as const) {
  for (const value of values) {
    test(`AC-2 AC-14 refuses every entry point while ${variable} is ${JSON.stringify(value)}, and codex_doctor lists it`, async () => {
      await withServer({ [variable]: value }, async (h) => {
        for (const kind of KINDS) {
          const probesBefore = probes.length;
          await refusedPromptly(callKind(h, kind), new RegExp(variable), kind);
          assert.equal(probes.length, probesBefore, `${kind} ran a probe before refusing`);
        }
        // The configuration is read once: fixing the environment does not reach a running server.
        process.env[variable] = "2";
        await refusedPromptly(callKind(h, "blocking"), new RegExp(variable), "after the environment was fixed");
        assert.equal(spawnCalls, 0);

        const text = await doctorText(h);
        assert.match(text, /This MCP server is misconfigured/);
        assert.ok(text.includes(variable), text);
        const own = variable === HOURLY ? "hourly delegation bound" : "background job cap";
        const other = variable === HOURLY ? "background job cap" : "hourly delegation bound";
        assert.equal(lineOf(text, own), "invalid (see the configuration errors above)");
        assert.equal(lineOf(text, other), variable === HOURLY ? "8 (default)" : `none (${HOURLY} is unset)`);
      });
    });
  }
}

for (const [variable, raw, shown] of [
  [HOURLY, "05", `5 (${HOURLY})`],
  [HOURLY, " 5 ", `5 (${HOURLY})`],
  [HOURLY, "1", `1 (${HOURLY})`],
  [HOURLY, "9007199254740991", `9007199254740991 (${HOURLY})`],
  [CAP, "05", `5 (${CAP})`],
  [CAP, " 5 ", `5 (${CAP})`],
  [CAP, "1", `1 (${CAP})`],
  [CAP, "8", `8 (${CAP})`],
  [CAP, "", "8 (default)"],
  [CAP, "   ", "8 (default)"],
] as const) {
  test(`AC-2 AC-14 accepts ${variable}=${JSON.stringify(raw)} and shows it as "${shown}"`, async () => {
    await withServer({ [variable]: raw }, async (h) => {
      const text = await doctorText(h);
      assert.doesNotMatch(text, /This MCP server is misconfigured/);
      assert.equal(lineOf(text, variable === HOURLY ? "hourly delegation bound" : "background job cap"), shown);
      assertAdmitted(await callKind(h, "blocking"));
    });
  });
}

for (const raw of ["05", " 5 "]) {
  test(`AC-2 ${HOURLY}=${JSON.stringify(raw)} admits five delegation processes and refuses the sixth`, async () => {
    await withServer({ [HOURLY]: raw }, async (h) => {
      for (let i = 0; i < 5; i++) assertAdmitted(await callKind(h, "blocking"), `call ${i + 1}`);
      await h.settle();
      await refusedPromptly(callKind(h, "blocking"), namesValue(HOURLY, 5), "the sixth call");
    });
  });

  test(`AC-2 ${CAP}=${JSON.stringify(raw)} admits five running background jobs and refuses the sixth`, async () => {
    await withServer({ [CAP]: raw }, async (h) => {
      nextRun = { events: [], exitCode: 0, hold: true };
      for (let i = 0; i < 5; i++) jobIdOf(await callKind(h, "background"));
      await refusedPromptly(callKind(h, "background"), new RegExp(CAP), "the sixth background call");
    });
  });
}

for (const raw of ["", "   "]) {
  test(`AC-2 ${CAP}=${JSON.stringify(raw)} keeps the cap at 8 and today's message`, async () => {
    await withServer({ [CAP]: raw }, async (h) => {
      nextRun = { events: [], exitCode: 0, hold: true };
      for (let i = 0; i < 8; i++) jobIdOf(await callKind(h, "background"));
      const text = await refusedPromptly(callKind(h, "background"), /Too many background delegations/);
      assert.equal(text, CAP_8_MESSAGE);
    });
  });
}

test("AC-2 keeps the hourly bound it started with when the environment changes later, at every entry point", async () => {
  await withServer({ [HOURLY]: "1" }, async (h) => {
    process.env[HOURLY] = "5";
    assertAdmitted(await callKind(h, "blocking"));
    await h.settle();
    for (const kind of KINDS) await refusedPromptly(callKind(h, kind), new RegExp(HOURLY), kind);
    assert.equal(lineOf(await doctorText(h), "hourly delegation bound"), `1 (${HOURLY})`);
  });
});

test("AC-2 keeps the background cap it started with when the environment changes later", async () => {
  await withServer({ [CAP]: "1" }, async (h) => {
    process.env[CAP] = "5";
    nextRun = { events: [], exitCode: 0, hold: true };
    jobIdOf(await callKind(h, "background"));
    await refusedPromptly(callKind(h, "background"), new RegExp(CAP), "the second background call");
    assert.equal(lineOf(await doctorText(h), "background job cap"), `1 (${CAP})`);
  });
});

// AC-3: a full window refuses every entry point before any probe or other await.

test("AC-3 refuses every entry point before any probe once an exec and a resume process fill the bound", async () => {
  await withServer({ [HOURLY]: "2" }, async (h) => {
    nextRun = { events: [threadStarted("t-follow"), ANSWER], exitCode: 0 };
    assertAdmitted(await callKind(h, "blocking"));
    assertAdmitted(await callKind(h, "follow-up"));
    await h.settle();
    assert.equal(spawnTimes.length, 2);
    assert.equal(spawnArgs[0]![0], "exec");
    assert.ok(!spawnArgs[0]!.includes("resume"), `the delegation was not a plain exec: ${spawnArgs[0]!.join(" ")}`);
    assert.equal(spawnArgs[1]![0], "exec");
    assert.ok(spawnArgs[1]!.includes("resume"), `the follow-up was not an exec resume: ${spawnArgs[1]!.join(" ")}`);
    for (const kind of KINDS) {
      const probesBefore = probes.length;
      const spawnsBefore = spawnCalls;
      await refusedPromptly(callKind(h, kind), new RegExp(HOURLY), kind);
      assert.equal(probes.length, probesBefore, `${kind} ran a probe`);
      assert.equal(spawnCalls, spawnsBefore, `${kind} spawned`);
    }
  });
});

test("AC-3 counts a process from its spawn, before its run settles", async () => {
  await withServer({ [HOURLY]: "1" }, async (h) => {
    nextRun = { events: [ANSWER], exitCode: 0, hold: true };
    const first = callKind(h, "blocking");
    const child = await spawned(1);
    assert.deepEqual(await counts(h), { processes: 1, pending: 0 });
    await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY));
    close(child);
    assertAdmitted(await within(first, "the first call"));
  });
});

test("AC-3 refuses a follow-up that would recover its thread before reading Codex's session directory", async () => {
  await withServer({ [HOURLY]: "1" }, async (h) => {
    for (const threadId of ["recover-one", "recover-two"]) {
      h.codexHome.write({
        threadId,
        day: "2026-10-08",
        lines: [SESSION_META_LINE, turnContextLine({ cwd: process.cwd(), model: "cheap-model", effort: "low" })],
      });
    }
    const sessionReads = () => readdirPaths.filter((path) => isInside(path, h.codexHome.path)).length;

    // Positive control: with room in the window, the recovery does read the session directory.
    nextRun = { events: [threadStarted("recover-one"), ANSWER], exitCode: 0 };
    assertAdmitted(await h.call("codex_follow_up", { thread_id: "recover-one", prompt: "go" }));
    await h.settle();
    assert.ok(sessionReads() > 0, "the recovery never listed the session directory");

    const readsBefore = sessionReads();
    const probesBefore = probes.length;
    await refusedPromptly(h.call("codex_follow_up", { thread_id: "recover-two", prompt: "go" }), new RegExp(HOURLY));
    assert.equal(sessionReads(), readsBefore, "the refused follow-up read the session directory");
    assert.equal(probes.length, probesBefore);
  });
});

// AC-4: two calls at once with a bound of one, for every pair of entry points.

for (const first of KINDS) {
  for (const second of KINDS) {
    test(`AC-4 admits only a pending ${first} call against a concurrent ${second} call under a bound of 1`, async () => {
      await withServer({ [HOURLY]: "1" }, async (h) => {
        const held = holdProbes();
        const pending = callKind(h, first);
        await entered(held);
        const probesBefore = probes.length;
        await refusedPromptly(callKind(h, second), new RegExp(HOURLY), `the ${second} call`);
        assert.equal(probes.length, probesBefore, `the ${second} call ran a probe`);
        assert.equal(spawnCalls, 0);
        held.release.resolve();
        assertAdmitted(await within(pending, "the first call"), `the ${first} call`);
        await h.settle();
        assert.equal(spawnCalls, 1);
        assert.equal(spawnTimes.length, 1);
      });
    });
  }
}

// AC-5: a call that fails before its spawn gives its slot back, exactly once.

/** With a bound of 1 and an empty window, two concurrent calls admit exactly one. */
async function assertOneSlotLeft(h: Harness): Promise<void> {
  assert.deepEqual(await counts(h), { processes: 0, pending: 0 });
  const spawnsBefore = spawnTimes.length;
  const results = await within(Promise.all([callKind(h, "blocking"), callKind(h, "blocking")]), "two concurrent calls");
  const refused = results.filter((result) => (result as ToolResult).isError === true);
  assert.equal(refused.length, 1, results.map(textOf).join("\n---\n"));
  assert.match(textOf(refused[0]), new RegExp(HOURLY));
  await h.settle();
  assert.equal(spawnTimes.length - spawnsBefore, 1);
}

let savedTmp: Record<string, string | undefined> = {};

interface PreSpawnFailure {
  name: string;
  kinds: Kind[];
  /** Arranges the failure and returns the call's extra arguments. */
  arrange: (h: Harness) => Record<string, unknown>;
  /** Proves the failure that happened is the one arranged. */
  happened: (result: unknown) => void;
  restore: () => void;
}

const restoreNextRun = () => {
  nextRun = { events: [ANSWER], exitCode: 0 };
};

const PRE_SPAWN_FAILURES: PreSpawnFailure[] = [
  {
    name: "the model is unknown",
    kinds: KINDS,
    arrange: () => ({ model: "no-such-model" }),
    happened: (result) => assert.match(textOf(result), /no-such-model/),
    restore: () => {},
  },
  {
    name: "the sandbox is above the ceiling",
    kinds: KINDS,
    arrange: () => ({ sandbox: "danger-full-access" }),
    happened: (result) => assert.match(textOf(result), /danger-full-access/),
    restore: () => {},
  },
  {
    name: "the preflight fails",
    kinds: KINDS,
    arrange: () => {
      failProbe = "--version";
      return {};
    },
    happened: () => assert.ok(probes.some((probe) => probe.startsWith("--version")), "the preflight never ran"),
    restore: () => {
      failProbe = undefined;
    },
  },
  {
    name: "the catalog cannot be read",
    kinds: KINDS,
    arrange: () => {
      catalogOutput = "not json";
      resetCatalogCache();
      return {};
    },
    happened: () => assert.ok(probes.some((probe) => probe.startsWith("debug models")), "the catalog was never read"),
    restore: () => {
      catalogOutput = JSON.stringify(CATALOG);
      resetCatalogCache();
    },
  },
  {
    name: "the MCP listing cannot be read",
    kinds: KINDS,
    arrange: () => {
      mcpList = "not json";
      return {};
    },
    happened: () => assert.ok(probes.some((probe) => probe.startsWith("mcp list")), "the MCP servers were never listed"),
    restore: () => {
      mcpList = "[]";
    },
  },
  {
    name: "the schema file cannot be created",
    kinds: KINDS,
    arrange: (h) => {
      savedTmp = Object.fromEntries(TMP_KEYS.map((key) => [key, process.env[key]]));
      const missing = join(h.stateHome, "missing", "nested");
      for (const key of TMP_KEYS) process.env[key] = missing;
      return { output_schema: { type: "object", properties: {}, required: [], additionalProperties: false } };
    },
    happened: () => assert.equal(spawnCalls, 0, "a process was spawned without its schema file"),
    restore: () => {
      for (const key of TMP_KEYS) {
        if (savedTmp[key] === undefined) delete process.env[key];
        else process.env[key] = savedTmp[key];
      }
    },
  },
  {
    name: "spawn throws",
    kinds: KINDS,
    arrange: () => {
      nextRun = { events: [], exitCode: 0, spawnThrows: true };
      return {};
    },
    happened: () => assert.equal(spawnCalls, 1, "spawn was never attempted"),
    restore: restoreNextRun,
  },
  {
    name: "the spawn reports an error and no pid",
    kinds: KINDS,
    arrange: () => {
      nextRun = { events: [], exitCode: 0, spawnError: true };
      return {};
    },
    happened: () => {
      assert.equal(spawnCalls, 1, "spawn was never attempted");
      assert.equal(spawnTimes.length, 0);
    },
    restore: restoreNextRun,
  },
];

/**
 * A call that fails before its spawn is refused, or, in the background, may return a job id whose
 * job then fails: ADR 23 and ADR 25 require the slot back either way, not one of the two shapes.
 */
async function assertFailedBeforeSpawn(h: Harness, kind: Kind, result: unknown): Promise<void> {
  if ((result as ToolResult).isError === true) return;
  assert.equal(kind, "background", `a ${kind} call that failed before its spawn was not refused: ${textOf(result)}`);
  jobIdOf(result);
  await h.settle();
  assert.deepEqual(h.jobs.list().map((job) => job.state), ["failed"]);
}

for (const failure of PRE_SPAWN_FAILURES) {
  for (const kind of failure.kinds) {
    test(`AC-5 releases the slot of a ${kind} call once when ${failure.name}`, async () => {
      await withServer({ [HOURLY]: "1" }, async (h) => {
        const extra = failure.arrange(h);
        let result: unknown;
        try {
          result = await within(callKind(h, kind, extra), `the ${kind} call`);
          await assertFailedBeforeSpawn(h, kind, result);
          await h.settle();
          failure.happened(result);
        } finally {
          failure.restore();
        }
        await assertOneSlotLeft(h);
      });
    });
  }
}

for (const failure of PRE_SPAWN_FAILURES.filter((f) => f.name !== "the sandbox is above the ceiling")) {
  test(`AC-5 a call failing because ${failure.name} never releases another call's reservation`, async () => {
    await withServer({ [HOURLY]: "2" }, async (h) => {
      const held = holdProbes();
      const first = callKind(h, "blocking");
      await entered(held);
      const extra = failure.arrange(h);
      try {
        const result = await within(callKind(h, "blocking", extra), "the failing call");
        assert.equal((result as ToolResult).isError, true, textOf(result));
      } finally {
        failure.restore();
      }
      assertAdmitted(await within(callKind(h, "blocking"), "the call that takes the second slot"));
      await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "a call while the first still holds its slot");
      held.release.resolve();
      assertAdmitted(await within(first, "the first call"));
      await h.settle();
      assert.equal(spawnTimes.length, 2);
    });
  });
}

test("AC-5 releases the slot of a call cancelled before it arrived", async () => {
  await withServer({ [HOURLY]: "1" }, async (h) => {
    for (const kind of KINDS) {
      const controller = new AbortController();
      controller.abort();
      await within(callKind(h, kind, {}, controller.signal), `the cancelled ${kind} call`);
      await h.settle();
    }
    assert.equal(spawnCalls, 0);
    assert.equal(h.jobs.list().length, 0, "a cancelled background request created a job");
    await assertOneSlotLeft(h);
  });
});

for (const kind of ["blocking", "follow-up"] as const) {
  test(`AC-5 a ${kind} call cancelled in its preflight keeps its slot until its handler returns, then gives it back`, async () => {
    await withServer({ [HOURLY]: "1" }, async (h) => {
      const held = holdProbes();
      const controller = new AbortController();
      const pending = callKind(h, kind, {}, controller.signal);
      await entered(held);
      controller.abort();
      assert.deepEqual(await counts(h), { processes: 0, pending: 1 });
      await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "a call before the cancelled handler returned");
      held.release.resolve();
      await within(pending, "the cancelled call");
      await h.settle();
      assert.equal(spawnCalls, 0);
      await assertOneSlotLeft(h);
    });
  });
}

test("AC-5 refused by the background cap, a call releases its hourly slot", async () => {
  await withServer({ [HOURLY]: "2", [CAP]: "1" }, async (h) => {
    nextRun = { events: [], exitCode: 0, hold: true };
    jobIdOf(await callKind(h, "background"));
    await spawned(1);
    await refusedPromptly(callKind(h, "background"), new RegExp(CAP), "the second background call");
    assert.deepEqual(await counts(h), { processes: 1, pending: 0 });
    restoreNextRun();
    // The held background run never settles, so the harness's settle would wait for it forever.
    assertAdmitted(await within(callKind(h, "blocking"), "the blocking call"), "the blocking call that takes the released slot");
    await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "a call over the bound");
  });
});

test("AC-5 the preflight, catalog and listing probes never count", async () => {
  await withServer({ [HOURLY]: "1" }, async (h) => {
    await h.call("codex_doctor", { refresh: true });
    await h.call("list_codex_models", { refresh: true });
    await h.call("codex_recommend", { task_description: "review a pull request" });
    assert.ok(probes.length > 0, "the probes ran");
    assert.deepEqual(await counts(h), { processes: 0, pending: 0 });
    assertAdmitted(await callKind(h, "blocking"));
  });
});

// AC-6: a spawned process counts whatever its outcome.

const EXPECTED_JOB_STATE = { success: "completed", failure: "failed", timeout: "failed", cancelled: "cancelled" } as const;

for (const kind of KINDS) {
  for (const outcome of ["failure", "timeout", "cancelled", "success"] as const) {
    test(`AC-6 a ${kind} process that ends in ${outcome} counts until sixty minutes after its spawn`, async (t: TestContext) => {
      await withServer({ [HOURLY]: "1" }, async (h) => {
        t.mock.timers.enable({ apis: outcome === "timeout" ? ["Date", "setTimeout"] : ["Date"], now: T0 });
        const held = outcome === "timeout" || outcome === "cancelled";
        nextRun = {
          events: outcome === "success" ? [threadStarted("t-follow"), ANSWER] : [threadStarted("t-follow")],
          exitCode: outcome === "failure" ? 1 : 0,
          hold: held,
        };
        const controller = new AbortController();
        const pending = callKind(h, kind, { timeout_seconds: 1 }, controller.signal);
        const jobId = kind === "background" ? jobIdOf(await within(pending, "the background call")) : undefined;
        const child = await spawned(1);
        const spawnedAt = spawnTimes[0]!;
        if (outcome === "timeout") {
          t.mock.timers.tick(1000);
          close(child);
        } else if (outcome === "cancelled") {
          if (jobId) await h.call("codex_job_cancel", { job_id: jobId });
          else controller.abort();
          close(child);
        }
        if (jobId) {
          await h.settle();
          assert.deepEqual(h.jobs.list().map((job) => job.state), [EXPECTED_JOB_STATE[outcome]]);
        } else {
          const result = await within(pending, `the ${kind} call`);
          assert.equal((result as ToolResult).isError === true, outcome !== "success", textOf(result));
          await h.settle();
        }
        restoreNextRun();

        assert.deepEqual(await counts(h), { processes: 1, pending: 0 });
        await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "right after the run");
        t.mock.timers.setTime(spawnedAt + HOUR_MS - 1);
        await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "one millisecond before the hour");
        t.mock.timers.setTime(spawnedAt + HOUR_MS);
        assertAdmitted(await within(callKind(h, "blocking"), "the call at the hour"), "at the hour");
      });
    });
  }
}

test("AC-6 a cancelled background job frees its cap place but keeps its hourly entry", async () => {
  await withServer({ [HOURLY]: "2", [CAP]: "1" }, async (h) => {
    nextRun = { events: [], exitCode: 0, hold: true };
    const first = jobIdOf(await callKind(h, "background"));
    await spawned(1);
    await h.call("codex_job_cancel", { job_id: first });
    jobIdOf(await within(callKind(h, "background"), "the replacement background call"));
    await spawned(2);
    await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "a third call while both processes count");
    assert.deepEqual(await counts(h), { processes: 2, pending: 0 });
  });
});

// AC-7: the window starts at the spawn, not at the reservation, and lets entries go one at a time.

for (const kind of KINDS) {
  test(`AC-7 a ${kind} process reserved at t0 and spawned five minutes later counts for exactly an hour from its spawn`, async (t: TestContext) => {
    await withServer({ [HOURLY]: "1" }, async (h) => {
      t.mock.timers.enable({ apis: ["Date"], now: T0 });
      onNextProbe = () => t.mock.timers.setTime(T0 + 5 * MINUTE_MS);
      assertAdmitted(await within(callKind(h, kind), `the ${kind} call`));
      await spawned(1);
      await h.settle();
      assert.equal(spawnTimes[0], T0 + 5 * MINUTE_MS);

      t.mock.timers.setTime(spawnTimes[0]! + HOUR_MS - 1);
      assert.deepEqual(await counts(h), { processes: 1, pending: 0 });
      await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY));
      t.mock.timers.setTime(spawnTimes[0]! + HOUR_MS);
      assert.deepEqual(await counts(h), { processes: 0, pending: 0 });
      assertAdmitted(await within(callKind(h, "blocking"), "the call at the hour"));
    });
  });
}

test("AC-7 a window of two lets its entries go one at a time, each an hour after its own spawn", async (t: TestContext) => {
  await withServer({ [HOURLY]: "2" }, async (h) => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    assertAdmitted(await callKind(h, "blocking"));
    t.mock.timers.setTime(T0 + 10 * MINUTE_MS);
    assertAdmitted(await callKind(h, "blocking"));
    await h.settle();
    t.mock.timers.setTime(T0 + HOUR_MS);
    assert.deepEqual(await counts(h), { processes: 1, pending: 0 });
    assertAdmitted(await within(callKind(h, "blocking"), "the call that takes the first freed slot"));
    await h.settle();
    await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "a call while the second entry still counts");
    t.mock.timers.setTime(T0 + 10 * MINUTE_MS + HOUR_MS);
    assert.deepEqual(await counts(h), { processes: 1, pending: 0 });
    assertAdmitted(await within(callKind(h, "blocking"), "the call that takes the second freed slot"));
  });
});

// AC-8: a reservation never expires by age.

for (const kind of KINDS) {
  test(`AC-8 a ${kind} call held sixty-one minutes before its spawn keeps its slot, then counts from its spawn`, async (t: TestContext) => {
    await withServer({ [HOURLY]: "1" }, async (h) => {
      t.mock.timers.enable({ apis: ["Date"], now: T0 });
      const held = holdProbes();
      const first = callKind(h, kind);
      await entered(held);
      t.mock.timers.setTime(T0 + 61 * MINUTE_MS);
      assert.deepEqual(await counts(h), { processes: 0, pending: 1 });
      const probesBefore = probes.length;
      await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY));
      assert.equal(probes.length, probesBefore);
      held.release.resolve();
      assertAdmitted(await within(first, "the held call"));
      await spawned(1);
      await h.settle();
      assert.equal(spawnTimes.length, 1);
      assert.equal(spawnTimes[0], T0 + 61 * MINUTE_MS);
      assert.deepEqual(await counts(h), { processes: 1, pending: 0 });
    });
  });
}

// AC-9: the refusal when processes are counted.

test("AC-9 gives the oldest spawn plus an hour in UTC and the minutes left, and tells the caller to stop", async (t: TestContext) => {
  await withServer({ [HOURLY]: "2" }, async (h) => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    assertAdmitted(await callKind(h, "blocking"));
    t.mock.timers.setTime(T0 + 10 * MINUTE_MS);
    assertAdmitted(await callKind(h, "blocking"));
    await h.settle();
    t.mock.timers.setTime(T0 + 20 * MINUTE_MS);
    const text = await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY));
    assertTellsCallerToStop(text, 2);
    const at = text.indexOf("2026-10-08T13:00:00.000Z");
    assert.ok(at >= 0, text);
    const minutes = text.search(/\b40 (minutes|min)\b/);
    assert.ok(minutes > at, `the minutes left follow the time: ${text}`);
    assert.match(text, NOT_A_PROMISE);
  });
});

test("AC-9 rounds the minutes left up, and never below one", async (t: TestContext) => {
  await withServer({ [HOURLY]: "1" }, async (h) => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    assertAdmitted(await callKind(h, "blocking"));
    await h.settle();
    t.mock.timers.setTime(T0 + HOUR_MS - (39 * MINUTE_MS + 1));
    assert.match(await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY)), /\b40 (minutes|min)\b/);
    t.mock.timers.setTime(T0 + HOUR_MS - 1);
    const last = await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY));
    assert.match(last, /\b1 (minutes?|min)\b/);
    assert.match(last, /2026-10-08T13:00:00\.000Z/);
  });
});

// AC-10: the refusal when calls that have not spawned hold slots.

test("AC-10 gives no time when every slot is held by calls that have not started Codex", async () => {
  await withServer({ [HOURLY]: "1" }, async (h) => {
    const held = holdProbes();
    const first = callKind(h, "blocking");
    await entered(held);
    const text = await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY));
    assert.match(text, namesValue(HOURLY, 1));
    assert.match(text, /Codex/);
    assert.match(text, /not (yet )?(started|spawned)|yet to start|have not started|haven't started/i);
    assert.match(text, /wait/i);
    assert.match(text, /result/i);
    assert.match(text, /(no|cannot|can't|unable to|not possible to)\b[^.]*\btime\b/i, "says why no time is given");
    for (const pattern of USER_LIMIT) assert.match(text, pattern);
    assert.match(text, RAISE);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "an absolute time");
    assert.doesNotMatch(text, /\b\d{1,2}:\d{2}\b/, "a clock time");
    assert.doesNotMatch(text, /\d+\s*(ms|milliseconds?|s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?)\b/i, "a delay in figures");
    assert.doesNotMatch(
      text,
      /\b(a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|sixty) (seconds?|minutes?|hours?)\b/i,
      "a delay in words",
    );
    assert.doesNotMatch(text, /tomorrow|later today/i, "a day");
    assertNoSpendFigure(text);
    held.release.resolve();
    assertAdmitted(await within(first, "the held call"));
  });
});

test("AC-10 gives the time of the counted process and says a call still starting may free a slot sooner", async (t: TestContext) => {
  await withServer({ [HOURLY]: "2" }, async (h) => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    assertAdmitted(await callKind(h, "blocking"));
    await h.settle();
    t.mock.timers.setTime(T0 + 20 * MINUTE_MS);
    const held = holdProbes();
    const pending = callKind(h, "blocking");
    await entered(held);
    const text = await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY));
    assertTellsCallerToStop(text, 2);
    assert.match(text, /2026-10-08T13:00:00\.000Z/);
    assert.match(text, /\b40 (minutes|min)\b/);
    assert.match(text, /sooner|earlier|before (that|this) (time|timestamp)/i);
    held.release.resolve();
    assertAdmitted(await within(pending, "the held call"));
  });
});

// AC-11: the background cap.

test("AC-11 refuses a third background call under a cap of 2, naming the variable, and leaves blocking calls alone", async () => {
  await withServer({ [HOURLY]: "3", [CAP]: "2" }, async (h) => {
    nextRun = { events: [], exitCode: 0, hold: true };
    jobIdOf(await callKind(h, "background"));
    jobIdOf(await callKind(h, "background"));
    await spawned(2);
    const text = await refusedPromptly(callKind(h, "background"), new RegExp(CAP), "the third background call");
    assert.match(text, namesValue(CAP, 2));
    assert.deepEqual(await counts(h), { processes: 2, pending: 0 });
    restoreNextRun();
    assertAdmitted(await within(callKind(h, "blocking"), "the blocking call"), "a blocking call, which never uses the cap");
  });
});

test("AC-11 admits exactly one of two background calls racing for the last place under a configured cap", async () => {
  await withServer({ [CAP]: "1" }, async (h) => {
    nextRun = { events: [], exitCode: 0, hold: true };
    const results = await within(
      Promise.all([callKind(h, "background"), callKind(h, "background")]),
      "two concurrent background calls",
    );
    const refused = results.filter((result) => (result as ToolResult).isError === true);
    assert.equal(refused.length, 1, results.map(textOf).join("\n---\n"));
    assert.match(textOf(refused[0]), new RegExp(CAP));
    await spawned(1);
    assert.equal(h.jobs.list().filter((job) => job.state === "running").length, 1);
    assert.equal(spawnTimes.length, 1);
  });
});

test("AC-11 a cancelled job stops counting toward the cap while its process is still being stopped", async () => {
  await withServer({ [CAP]: "1" }, async (h) => {
    nextRun = { events: [], exitCode: 0, hold: true };
    const first = jobIdOf(await callKind(h, "background"));
    const child = await spawned(1);
    await h.call("codex_job_cancel", { job_id: first });
    assert.equal(child["exitCode"], null, "the cancelled process is still alive");
    jobIdOf(await within(callKind(h, "background"), "the replacement background call"));
  });
});

test("AC-11 a settled job stops counting toward the cap, whether it succeeded or failed", async () => {
  await withServer({ [CAP]: "1" }, async (h) => {
    jobIdOf(await callKind(h, "background"));
    await h.settle();
    nextRun = { events: [], exitCode: 1 };
    jobIdOf(await callKind(h, "background"));
    await h.settle();
    jobIdOf(await callKind(h, "background"));
  });
});

test("AC-11 keeps the cap at 8 and today's message when the variable is unset", async () => {
  await withServer({}, async (h) => {
    nextRun = { events: [], exitCode: 0, hold: true };
    for (let i = 0; i < 8; i++) jobIdOf(await callKind(h, "background"));
    const text = await refusedPromptly(callKind(h, "background"), /Too many background delegations/);
    assert.equal(text, CAP_8_MESSAGE);
  });
});

// AC-12: a background request cancelled before its job exists creates no job.

for (const bound of ["1", undefined]) {
  test(`AC-12 a background request cancelled in its preflight creates no job, ${bound ? "and keeps its slot until its handler returns" : "with no hourly bound"}`, async () => {
    await withServer({ [HOURLY]: bound }, async (h) => {
      const held = holdProbes();
      const controller = new AbortController();
      const pending = callKind(h, "background", {}, controller.signal);
      await entered(held);
      controller.abort();
      if (bound) {
        assert.deepEqual(await counts(h), { processes: 0, pending: 1 });
        await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "a call before the cancelled handler returned");
      }
      held.release.resolve();
      await within(pending, "the cancelled call");
      await h.settle();
      assert.equal(h.jobs.list().length, 0, "a job was created");
      assert.equal(spawnCalls, 0, "a process was spawned");
      assert.deepEqual(await counts(h), { processes: 0, pending: 0 });
      assertAdmitted(await within(callKind(h, "blocking"), "a later call"), "a later call");
    });
  });
}

test("AC-12 a background request that arrives already cancelled creates no job, with no hourly bound", async () => {
  await withServer({}, async (h) => {
    const controller = new AbortController();
    controller.abort();
    await within(callKind(h, "background", {}, controller.signal), "the cancelled call");
    await h.settle();
    assert.equal(h.jobs.list().length, 0, "a job was created");
    assert.equal(spawnCalls, 0, "a process was spawned");
  });
});

test("AC-12 a background request cancelled during its last listing creates no job", async () => {
  await withServer({ [HOURLY]: "1" }, async (h) => {
    const held = holdProbes(1, (args) => args[0] === "mcp");
    const controller = new AbortController();
    const pending = callKind(h, "background", {}, controller.signal);
    await entered(held);
    controller.abort();
    held.release.resolve();
    await within(pending, "the cancelled call");
    await h.settle();
    assert.equal(h.jobs.list().length, 0);
    assert.equal(spawnCalls, 0);
    assert.deepEqual(await counts(h), { processes: 0, pending: 0 });
  });
});

test("AC-12 cancelling the request after the job id was returned leaves the job running", async () => {
  await withServer({ [HOURLY]: "1" }, async (h) => {
    nextRun = { events: [], exitCode: 0, hold: true };
    const controller = new AbortController();
    const jobId = jobIdOf(await callKind(h, "background", {}, controller.signal));
    await spawned(1);
    controller.abort();
    await tick();
    assert.match(textOf(await h.call("codex_job_status", { job_id: jobId })), /running/);
  });
});

// AC-13: independent of the usage log, and empty in a new server.

const appendFailures: string[] = [];
const failingUsageFs: UsageFileSystem = {
  ...nodeUsageFileSystem,
  appendFile: async (path) => {
    appendFailures.push(path);
    throw Object.assign(new Error("injected append failure"), { code: "EIO" });
  },
};

for (const log of ["off", "on", "failing"] as const) {
  for (const kind of KINDS) {
    test(`AC-13 the hourly bound counts a ${kind} process the same with the usage log ${log}`, async () => {
      appendFailures.length = 0;
      await withServer(
        { [HOURLY]: "1", CODEX_SUBAGENT_USAGE_LOG: log === "off" ? "off" : "on" },
        async (h) => {
          assertAdmitted(await within(callKind(h, kind), `the ${kind} call`));
          await h.settle();
          await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY));
          assert.deepEqual(await counts(h), { processes: 1, pending: 0 });
          if (log === "failing") assert.ok(appendFailures.length > 0, "the failing log was never written to");
        },
        log === "failing" ? { usageFileSystem: failingUsageFs } : {},
      );
    });
  }
}

test("AC-13 a new server starts with an empty window whatever the usage log holds", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "codex-subagent-state-"));
  try {
    const env = { [HOURLY]: "1", CODEX_SUBAGENT_USAGE_LOG: "on" };
    await withServer(env, async (h) => {
      assertAdmitted(await callKind(h, "blocking"));
      await h.settle();
    }, { stateHome });
    const usageDir = join(stateHome, "codex-subagent-mcp");
    const lines = existsSync(usageDir)
      ? readdirSync(usageDir).flatMap((file) => readFileSync(join(usageDir, file), "utf8").split("\n").filter(Boolean))
      : [];
    assert.ok(lines.length > 0, "the first server wrote no usage entry");
    await withServer(env, async (h) => {
      assert.deepEqual(await counts(h), { processes: 0, pending: 0 });
      assertAdmitted(await callKind(h, "blocking"));
    }, { stateHome });
  } finally {
    rmSync(stateHome, { recursive: true, force: true });
  }
});

// AC-14: codex_doctor reports the bounds and the window, fresh on every call.

test("AC-14 reports the configured bounds and counts calls holding a slot apart from spawned processes", async () => {
  await withServer({ [HOURLY]: "3", [CAP]: "2" }, async (h) => {
    const initial = await doctorText(h);
    assert.equal(lineOf(initial, "hourly delegation bound"), `3 (${HOURLY})`);
    assert.equal(lineOf(initial, "background job cap"), `2 (${CAP})`);
    assert.equal(lineOf(initial, "delegation processes in the last hour"), "0");
    assert.equal(lineOf(initial, "calls holding a slot before spawning"), "0");

    resetDoctorCache();
    const both = holdProbes(2);
    const first = callKind(h, "blocking");
    const second = callKind(h, "blocking");
    await entered(both);
    assert.deepEqual(await counts(h), { processes: 0, pending: 2 });
    both.release.resolve();
    assertAdmitted(await within(first, "the first held call"));
    assertAdmitted(await within(second, "the second held call"));
    await h.settle();
    assert.deepEqual(await counts(h), { processes: 2, pending: 0 });

    const third = holdProbes();
    const pending = callKind(h, "blocking");
    await entered(third);
    assert.deepEqual(await counts(h), { processes: 2, pending: 1 });
    third.release.resolve();
    assertAdmitted(await within(pending, "the third held call"));
  });
});

test("AC-14 reports the defaults when neither variable is set", async () => {
  await withServer({}, async (h) => {
    const text = await doctorText(h);
    assert.equal(lineOf(text, "hourly delegation bound"), `none (${HOURLY} is unset)`);
    assert.equal(lineOf(text, "background job cap"), "8 (default)");
    assert.equal(lineOf(text, "delegation processes in the last hour"), "0");
    assert.equal(lineOf(text, "calls holding a slot before spawning"), "0");
  });
});

test("AC-14 an entry that leaves the window between two calls is no longer counted, without a refresh", async (t: TestContext) => {
  await withServer({}, async (h) => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    assertAdmitted(await callKind(h, "blocking"));
    await h.settle();
    t.mock.timers.setTime(T0 + HOUR_MS - 1);
    assert.deepEqual(await counts(h), { processes: 1, pending: 0 });
    t.mock.timers.setTime(T0 + HOUR_MS);
    assert.deepEqual(await counts(h), { processes: 0, pending: 0 });
  });
});

test("AC-14 codex_doctor never reserves or counts a slot, even while it is still running", async () => {
  await withServer({ [HOURLY]: "2" }, async (h) => {
    for (let i = 0; i < 5; i++) await h.call("codex_doctor", {});
    resetDoctorCache();
    const held = holdProbes();
    const doctor = h.call("codex_doctor", { refresh: true });
    await entered(held);
    assertAdmitted(await within(callKind(h, "blocking"), "the first call"));
    assertAdmitted(await within(callKind(h, "blocking"), "the second call"));
    await h.settle();
    await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY));
    held.release.resolve();
    await within(doctor, "codex_doctor");
  });
});

// AC-16: a clock moved back keeps an entry counted.

test("AC-16 a process still counts after the clock moves back, until sixty minutes after its spawn time", async (t: TestContext) => {
  await withServer({ [HOURLY]: "1" }, async (h) => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    assertAdmitted(await callKind(h, "blocking"));
    await h.settle();
    t.mock.timers.setTime(T0 - 30 * MINUTE_MS);
    assert.deepEqual(await counts(h), { processes: 1, pending: 0 });
    await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "after the clock moved back");
    t.mock.timers.setTime(T0 + HOUR_MS - 1);
    await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "one millisecond before the hour");
    t.mock.timers.setTime(T0 + HOUR_MS);
    assertAdmitted(await within(callKind(h, "blocking"), "the call at the hour"), "at the hour");
  });
});

test("AC-16 entries on both sides of a clock moved back each leave an hour after their own spawn", async (t: TestContext) => {
  await withServer({ [HOURLY]: "2" }, async (h) => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    assertAdmitted(await callKind(h, "blocking"));
    t.mock.timers.setTime(T0 - 30 * MINUTE_MS);
    assertAdmitted(await callKind(h, "blocking"));
    await h.settle();
    const text = await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "with both entries counted");
    assert.match(text, /2026-10-08T12:30:00\.000Z/, "the earliest time follows the earliest spawn time");
    t.mock.timers.setTime(T0 + 30 * MINUTE_MS - 1);
    await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "just before the earlier entry leaves");
    t.mock.timers.setTime(T0 + 30 * MINUTE_MS);
    assert.deepEqual(await counts(h), { processes: 1, pending: 0 });
    assertAdmitted(await within(callKind(h, "blocking"), "the call that takes its slot"));
    await h.settle();
    await refusedPromptly(callKind(h, "blocking"), new RegExp(HOURLY), "while the later entry still counts");
  });
});
