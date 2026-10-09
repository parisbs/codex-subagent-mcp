import assert from "node:assert/strict";
import cp, { type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { DoctorReportOptions, DoctorRunOutcome, runDoctorReport } from "../src/codex/doctor-report.ts";

import { createCodexHome } from "./fixtures/codex-home.ts";
import { createFakeCodex, type Scenario } from "./fixtures/fake-codex.ts";
import { isAlive } from "./fixtures/process-alive.ts";

/**
 * `codex_doctor` with `extended: true` (#69), driven through the real server.
 *
 * The cheap probes (`codex --version`, `codex login status`, `codex debug
 * models`, the listings) are answered here at the promisified `execFile`
 * boundary, routed by subcommand. Everything else is real: `spawn` is only
 * observed, and `CODEX_BIN` is Node itself, so `doctor --json` run in a
 * stand-in's directory executes the copied `doctor` file. That keeps the
 * process lifecycle real on every platform without the Codex CLI, credentials
 * or quota. Timing and concurrency are driven through the `doctorReportRunner`
 * seam instead, so no test waits a real minute.
 */

const POSIX = process.platform !== "win32";

const CATALOG = {
  models: [
    {
      slug: "cheap-model",
      visibility: "list",
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low" }],
    },
  ],
};

/** What `codex --version` prints, and how `codex login status` answers. */
let fakeVersion = "codex-cli 0.160.0";
let login: "ok" | "signed-out" | "config-error" | "timed-out" = "ok";
/** The options of every cheap probe, to compare the subcommand's environment with. */
let probeOptions: Record<string, unknown>[] = [];

const CHEAP_PROBES = new Set(["--version", "login", "debug", "mcp", "plugin"]);
const realExecFile = cp.execFile;
const realExecFileAsync = promisify(realExecFile);
const fakeExecFileAsync = async (
  file: string,
  args: string[],
  options?: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string }> => {
  // Routed by subcommand rather than by file: the resolved path of CODEX_BIN may differ from it.
  if (CHEAP_PROBES.has(args[0] ?? "")) {
    probeOptions.push(options ?? {});
    if (args[0] === "--version") return { stdout: fakeVersion, stderr: "" };
    if (args[0] === "login") {
      if (login === "signed-out") {
        throw Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: "Not logged in" });
      }
      if (login === "config-error") {
        throw Object.assign(new Error("Command failed"), {
          code: 1,
          stdout: "",
          stderr: "Error loading configuration: /Users/example/.codex/config.toml:1:1: invalid",
        });
      }
      if (login === "timed-out") {
        throw Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", stdout: "", stderr: "" });
      }
      return { stdout: "Logged in using ChatGPT", stderr: "" };
    }
    if (args[0] === "debug") return { stdout: JSON.stringify(CATALOG), stderr: "" };
    if (args[0] === "mcp") return { stdout: "[]", stderr: "" };
    if (args[0] === "plugin") return { stdout: '{"installed":[],"available":[]}', stderr: "" };
  }
  return realExecFileAsync(file, args, options ?? {}) as Promise<{ stdout: string; stderr: string }>;
};
// The callback form stays real: termination runs taskkill through it on Windows.
const execFileWrapper = function (this: unknown, ...args: unknown[]) {
  return (realExecFile as unknown as (...a: unknown[]) => unknown).apply(this, args);
};
(execFileWrapper as unknown as Record<symbol, unknown>)[promisify.custom] = fakeExecFileAsync;
cp.execFile = execFileWrapper as unknown as typeof cp.execFile;

interface SpawnRecord {
  file: string;
  args: string[];
  options:
    | { cwd?: string; shell?: unknown; stdio?: unknown; detached?: unknown; env?: NodeJS.ProcessEnv }
    | undefined;
  child: ChildProcess;
}
let spawns: SpawnRecord[] = [];
const realSpawn = cp.spawn;
cp.spawn = ((file: string, args: string[], options?: SpawnRecord["options"]) => {
  const child = (realSpawn as unknown as (...a: unknown[]) => ChildProcess)(file, args, options);
  spawns.push({ file, args: [...args], options, child });
  return child;
}) as unknown as typeof cp.spawn;

syncBuiltinESMExports();

const { createServer } = await import("../src/server.ts");
const { resetDoctorCache } = await import("../src/codex/doctor.ts");
const { resetCatalogCache } = await import("../src/codex/catalog.ts");

interface ToolServer {
  _registeredTools: Record<string, unknown>;
  validateToolInput: (tool: unknown, args: unknown, name: string) => Promise<unknown>;
  executeToolHandler: (tool: unknown, args: unknown, extra: unknown) => Promise<unknown>;
  close: () => Promise<void>;
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

const doctorSpawns = () => spawns.filter((spawn) => spawn.args[0] === "doctor");

function report(name: "healthy" | "warning" | "syntax" | "semantic"): string {
  return readFileSync(new URL(`./fixtures/doctor-report-0.162.0-${name}.json`, import.meta.url), "utf8");
}

function outcome(overrides: Partial<DoctorRunOutcome>): DoctorRunOutcome {
  return { stdout: "", stderr: "", exitCode: 0, signal: null, stopped: null, ...overrides };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** A doctor runner the test finishes by hand, recording what the server asked of it. */
function controlledDoctor() {
  const calls: { options: DoctorReportOptions; finish: (value: DoctorRunOutcome) => void; cancelled: boolean }[] = [];
  const run: typeof runDoctorReport = (options) => {
    let finish!: (value: DoctorRunOutcome) => void;
    const result = new Promise<DoctorRunOutcome>((resolve) => {
      finish = resolve;
    });
    const call = { options, finish, cancelled: false };
    calls.push(call);
    return {
      pid: undefined,
      result,
      exited: result.then(() => {}),
      cancel: () => {
        call.cancelled = true;
        finish(outcome({ exitCode: null, stopped: "cancelled" }));
      },
    };
  };
  return { calls, run };
}

type Call = (name: string, args: unknown, signal?: AbortSignal) => Promise<ToolResult>;

async function withServer(
  scenario: Scenario,
  body: (
    call: Call,
    fake: ReturnType<typeof createFakeCodex>,
    server: ReturnType<typeof createServer>,
    tools: ToolServer,
  ) => Promise<void>,
  options: Parameters<typeof createServer>[0] = {},
): Promise<void> {
  const keys = ["CODEX_BIN", "CODEX_HOME", "CODEX_SUBAGENT_USAGE_LOG", "CODEX_SUBAGENT_DEFAULT_MODEL", "CODEX_SUBAGENT_DEFAULT_EFFORT"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.CODEX_BIN = process.execPath;
  const codexHome = createCodexHome();
  process.env.CODEX_HOME = codexHome.path;
  fakeVersion = "codex-cli 0.160.0";
  login = "ok";
  probeOptions = [];
  spawns = [];
  resetDoctorCache();
  resetCatalogCache();

  const fake = createFakeCodex(scenario, { command: "doctor" });
  const created = createServer(options);
  const tools = created.server as unknown as ToolServer;
  const call: Call = async (name, args, signal) => {
    const tool = tools._registeredTools[name];
    const validated = await tools.validateToolInput(tool, args, name);
    const extra = { signal: signal ?? new AbortController().signal, sendNotification: async () => {} };
    return (await tools.executeToolHandler(tool, validated, extra)) as ToolResult;
  };
  try {
    await body(call, fake, created, tools);
  } finally {
    // Every process this file saw start is brought down, tracked or not.
    for (const { child } of spawns) {
      if (child.pid === undefined || !isAlive(child.pid)) continue;
      try {
        process.kill(POSIX ? -child.pid : child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    await created.runs.stopAll({ graceMs: 0, deadlineMs: 2_000 });
    const pid = fake.descendantPid();
    if (pid !== null && isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    created.jobs.cancelAll();
    await tools.close();
    await sleep(100);
    fake.dispose();
    codexHome.dispose();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// AC-1

test("AC-1 never runs codex doctor at startup, without extended, or from another tool's preflight", async () => {
  const controlled = controlledDoctor();
  await withServer(
    { chunks: [report("healthy")] },
    async (call, fake) => {
      assert.equal(doctorSpawns().length, 0, "spawned at startup");
      const plain = await call("codex_doctor", { working_dir: fake.workingDir });
      const explicit = await call("codex_doctor", { working_dir: fake.workingDir, extended: false });
      await call("list_codex_models", { working_dir: fake.workingDir });
      await call("codex_recommend", { task_description: "fix a typo" });
      await call("codex_delegate", {
        prompt: "irrelevant",
        model: "cheap-model",
        reasoning_effort: "low",
        working_dir: fake.workingDir,
        skip_git_repo_check: true,
      }).catch(() => undefined);
      assert.equal(doctorSpawns().length, 0);
      assert.equal(controlled.calls.length, 0, "the doctor runner was started");
      assert.equal(plain.content.length, 1, "no extended section without extended");
      assert.equal(explicit.content.length, 1);
      assert.equal(existsSync(join(fake.workingDir, "received.json")), false);
    },
    { doctorReportRunner: controlled.run },
  );
});

test("AC-1 rejects an extended value that is not a boolean", async () => {
  await withServer({ chunks: [report("healthy")] }, async (_call, _fake, _server, tools) => {
    const tool = tools._registeredTools["codex_doctor"];
    for (const value of ["yes", 1, null, [], {}]) {
      await assert.rejects(tools.validateToolInput(tool, { extended: value }, "codex_doctor"), JSON.stringify(value));
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2

test("AC-2 runs doctor --json by argv, without a shell or stdin, in the given directory, and adds the section", async () => {
  await withServer({ chunks: [report("warning")], exitCode: 1 }, async (call, fake) => {
    const result = await call("codex_doctor", { working_dir: fake.workingDir, extended: true });
    const runs = doctorSpawns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.file, process.execPath, "executableFor(diagnosis) is spawned");
    assert.deepEqual(runs[0]!.args, ["doctor", "--json"]);
    assert.equal(runs[0]!.options?.cwd, fake.workingDir);
    assert.equal(runs[0]!.options?.shell, false);
    const stdio = runs[0]!.options?.stdio;
    assert.ok(stdio === "ignore" || (Array.isArray(stdio) && stdio[0] === "ignore"), `stdin is ${JSON.stringify(stdio)}`);
    assert.equal(runs[0]!.options?.detached, POSIX, "its own process group on POSIX");
    const env = runs[0]!.options?.env;
    assert.ok(env === undefined || env === process.env || JSON.stringify(env) === JSON.stringify(process.env), "the environment the cheap probes use");
    assert.ok(probeOptions.every((options) => options.env === undefined), "the cheap probes inherit the environment");
    assert.deepEqual(fake.received().argv, ["--json"]);
    assert.equal(result.content.length, 2, "the cheap diagnosis and the extended section");
    const section = result.content[1]!.text;
    assert.ok(section.split("\n")[0]!.includes(fake.workingDir), "the header names the directory");
    assert.ok(section.includes('configured model: "sentinel-configured-model"'));
    assert.ok(!section.includes("/Users/example/.codex-alt"), "no path-valued detail");
  });
});

test("AC-2 still runs it for every cheap status that found a runnable CLI", async () => {
  const cases: { name: string; version?: string; login?: typeof login }[] = [
    { name: "unauthenticated", login: "signed-out" },
    { name: "config-error", login: "config-error" },
    { name: "unknown", login: "timed-out" },
    { name: "unverified-version", version: "codex-cli 0.150.0" },
  ];
  for (const entry of cases) {
    await withServer({ chunks: [report("healthy")] }, async (call, fake) => {
      if (entry.version) fakeVersion = entry.version;
      if (entry.login) login = entry.login;
      const result = await call("codex_doctor", { working_dir: fake.workingDir, extended: true, refresh: true });
      assert.match(result.content[0]!.text, new RegExp(`status: ${entry.name}`), entry.name);
      assert.equal(doctorSpawns().length, 1, entry.name);
      assert.equal(result.content.length, 2, entry.name);
      assert.ok(result.content[1]!.text.includes('configured model: "<default>"'), entry.name);
    });
  }
});

test("AC-2 runs it in this server's own directory when no working_dir is given", async () => {
  const controlled = controlledDoctor();
  await withServer(
    { chunks: [] },
    async (call) => {
      const pending = call("codex_doctor", { extended: true });
      await waitFor(() => controlled.calls.length === 1, 5_000, "the doctor runner");
      const { cwd, executable } = controlled.calls[0]!.options;
      assert.ok(cwd === undefined || cwd === process.cwd(), `ran in ${String(cwd)}`);
      assert.equal(executable, process.execPath);
      controlled.calls[0]!.finish(outcome({ stdout: report("healthy") }));
      const result = await pending;
      assert.ok(result.content[1]!.text.split("\n")[0]!.includes(process.cwd()));
    },
    { doctorReportRunner: controlled.run },
  );
});

// ---------------------------------------------------------------------------
// AC-4

test("AC-4 skips the subcommand when the cheap probes found no runnable CLI", async () => {
  await withServer({ chunks: [report("healthy")] }, async (call, fake) => {
    fakeVersion = "not a version banner";
    const result = await call("codex_doctor", { working_dir: fake.workingDir, extended: true });
    assert.equal(doctorSpawns().length, 0);
    assert.equal(result.content.length, 2);
    assert.match(result.content[1]!.text, /skipped/i);
    assert.match(result.content[1]!.text, /unavailable/i);
  });
});

test("AC-4 names a spawn failure in the section", async () => {
  const controlled = controlledDoctor();
  await withServer(
    { chunks: [] },
    async (call, fake) => {
      const pending = call("codex_doctor", { working_dir: fake.workingDir, extended: true });
      await waitFor(() => controlled.calls.length === 1, 5_000, "the doctor runner");
      controlled.calls[0]!.finish(outcome({ exitCode: null, stopped: "spawn-failed", spawnError: "spawn sentinel-binary EACCES" }));
      const section = (await pending).content[1]!.text;
      assert.match(section, /could not (be )?start/i);
      assert.match(section, /EACCES/);
    },
    { doctorReportRunner: controlled.run },
  );
});

// ---------------------------------------------------------------------------
// AC-5, AC-7

test("AC-5 AC-7 a timed-out run keeps the cheap diagnosis and says why it may have timed out", async () => {
  const controlled = controlledDoctor();
  await withServer(
    { chunks: [] },
    async (call, fake) => {
      const plain = await call("codex_doctor", { working_dir: fake.workingDir });
      const pending = call("codex_doctor", { working_dir: fake.workingDir, extended: true });
      await waitFor(() => controlled.calls.length === 1, 5_000, "the doctor runner");
      controlled.calls[0]!.finish(
        outcome({ stdout: report("warning").slice(0, 500), exitCode: null, signal: "SIGINT", stopped: "timed-out" }),
      );
      const extended = await pending;
      assert.equal(extended.content[0]!.text, plain.content[0]!.text);
      assert.equal(extended.isError, plain.isError);
      assert.match(extended.content[1]!.text, /timed out/i);
      assert.match(extended.content[1]!.text, /network/i);
      assert.match(extended.content[1]!.text, /MCP/);
      assert.ok(!extended.content[1]!.text.includes("sentinel-configured-model"), "no partial output parsed");
    },
    { doctorReportRunner: controlled.run },
  );
});

test("AC-7 leaves the cheap diagnosis and isError exactly as without extended, for real runs", async () => {
  const cases: { name: string; scenario: Scenario; login?: typeof login; version?: string }[] = [
    { name: "a usable report", scenario: { chunks: [report("healthy")] } },
    { name: "a failed config.load", scenario: { chunks: [report("syntax")], exitCode: 1 } },
    { name: "a usage error", scenario: { chunks: [], stderr: "error: unexpected argument '--json' found\n", exitCode: 2 } },
    { name: "unparseable output", scenario: { chunks: ["garbage"], exitCode: 0 } },
    { name: "a signed-out CLI", scenario: { chunks: [report("healthy")] }, login: "signed-out" },
    { name: "a config error", scenario: { chunks: [report("syntax")], exitCode: 1 }, login: "config-error" },
    { name: "an unavailable CLI", scenario: { chunks: [report("healthy")] }, version: "garbage" },
  ];
  for (const entry of cases) {
    await withServer(entry.scenario, async (call, fake) => {
      if (entry.login) login = entry.login;
      if (entry.version) fakeVersion = entry.version;
      const without = await call("codex_doctor", { working_dir: fake.workingDir, refresh: true });
      const withExtended = await call("codex_doctor", { working_dir: fake.workingDir, refresh: true, extended: true });
      assert.equal(without.content.length, 1, entry.name);
      assert.equal(withExtended.content.length, 2, entry.name);
      assert.equal(withExtended.content[0]!.text, without.content[0]!.text, entry.name);
      assert.equal(withExtended.isError, without.isError, entry.name);
    });
  }
});

test("AC-7 leaves the cheap diagnosis and isError unchanged for every stopped or unusable outcome", async () => {
  const outcomes: [string, DoctorRunOutcome][] = [
    ["spawn failure", outcome({ exitCode: null, stopped: "spawn-failed", spawnError: "spawn x ENOENT" })],
    ["cancellation", outcome({ exitCode: null, stopped: "cancelled" })],
    ["oversized output", outcome({ exitCode: null, signal: "SIGINT", stopped: "stdout-too-large" })],
    ["a foreign signal", outcome({ exitCode: null, signal: "SIGKILL" })],
    ["a future schema", outcome({ stdout: JSON.stringify({ schemaVersion: 2, checks: {} }) })],
    ["no config.load", outcome({ stdout: JSON.stringify({ schemaVersion: 1, checks: {} }) })],
  ];
  for (const [name, finished] of outcomes) {
    const controlled = controlledDoctor();
    await withServer(
      { chunks: [] },
      async (call, fake) => {
        const plain = await call("codex_doctor", { working_dir: fake.workingDir });
        const pending = call("codex_doctor", { working_dir: fake.workingDir, extended: true });
        await waitFor(() => controlled.calls.length === 1, 5_000, "the doctor runner");
        controlled.calls[0]!.finish(finished);
        const extended = await pending;
        assert.equal(extended.content[0]!.text, plain.content[0]!.text, name);
        assert.equal(extended.isError, plain.isError, name);
        assert.equal(extended.content.length, 2, name);
      },
      { doctorReportRunner: controlled.run },
    );
  }
});

// ---------------------------------------------------------------------------
// AC-10

test("AC-10 spawns nothing when the request was cancelled before the subcommand", async () => {
  await withServer({ chunks: [report("healthy")] }, async (call, fake) => {
    const controller = new AbortController();
    controller.abort();
    const result = await call("codex_doctor", { working_dir: fake.workingDir, extended: true }, controller.signal);
    assert.equal(doctorSpawns().length, 0);
    assert.match(result.content[1]?.text ?? "", /cancel/i, "the section says the run was cancelled");
  });
});

test("AC-10 passes the request's signal to the run", async () => {
  const controlled = controlledDoctor();
  await withServer(
    { chunks: [] },
    async (call, fake) => {
      const controller = new AbortController();
      const pending = call("codex_doctor", { working_dir: fake.workingDir, extended: true }, controller.signal);
      await waitFor(() => controlled.calls.length === 1, 5_000, "the doctor runner");
      const signal = controlled.calls[0]!.options.signal;
      assert.ok(signal, "no signal was passed");
      controller.abort();
      assert.equal(signal.aborted, true, "the run's signal follows the request's");
      controlled.calls[0]!.finish(outcome({ exitCode: null, stopped: "cancelled" }));
      await within(pending, 5_000, "the cancelled call");
    },
    { doctorReportRunner: controlled.run },
  );
});

test("AC-10 stops the process tree when the request is cancelled while it runs", async () => {
  await withServer({ chunks: [], stayRunning: true, descendant: { holdMs: 30_000 } }, async (call, fake, server) => {
    const controller = new AbortController();
    const pending = call("codex_doctor", { working_dir: fake.workingDir, extended: true }, controller.signal);
    await waitFor(() => fake.descendantPid() !== null, 10_000, "the descendant to start");
    assert.equal(server.runs.size, 1, "the run is tracked for shutdown");
    controller.abort();
    await within(pending, 8_000, "the cancelled call");
    const descendant = fake.descendantPid()!;
    await waitFor(() => !isAlive(descendant), 5_000, `descendant ${descendant} to stop`);
    const leader = doctorSpawns()[0]!.child.pid!;
    await waitFor(() => !isAlive(leader), 5_000, "the doctor process to stop");
    await waitFor(() => server.runs.size === 0, 5_000, "the run to leave the registry");
  });
});

test("AC-10 is stopped by the server's shutdown while it runs", async () => {
  await withServer({ chunks: [], stayRunning: true, descendant: { holdMs: 30_000 } }, async (call, fake, server) => {
    const pending = call("codex_doctor", { working_dir: fake.workingDir, extended: true });
    await waitFor(() => fake.descendantPid() !== null, 10_000, "the descendant to start");
    assert.equal(server.runs.size, 1);
    const unconfirmed = await server.runs.stopAll({ graceMs: 250, deadlineMs: 2_000 });
    assert.deepEqual(unconfirmed, []);
    const result = await within(pending, 5_000, "the call");
    assert.equal(result.content.length, 2);
    const descendant = fake.descendantPid()!;
    await waitFor(() => !isAlive(descendant), 5_000, `descendant ${descendant} to stop`);
  });
});

test("AC-10 spawns nothing once shutdown has begun", async () => {
  await withServer({ chunks: [report("healthy")] }, async (call, fake, server) => {
    await server.runs.stopAll({ graceMs: 250, deadlineMs: 300 });
    const result = await call("codex_doctor", { working_dir: fake.workingDir, extended: true });
    assert.equal(doctorSpawns().length, 0);
    assert.match(result.content[1]?.text ?? "", /shutting down/i);
  });
});

// ---------------------------------------------------------------------------
// AC-11

test("AC-11 runs the subcommand on every call, whatever refresh says", async () => {
  await withServer({ chunks: [report("healthy")] }, async (call, fake) => {
    const first = await call("codex_doctor", { working_dir: fake.workingDir, extended: true });
    assert.ok(first.content[1]!.text.includes('configured model: "<default>"'));
    fake.setScenario({ chunks: [report("warning")], exitCode: 1 });
    const second = await call("codex_doctor", { working_dir: fake.workingDir, extended: true, refresh: false });
    assert.ok(second.content[1]!.text.includes('configured model: "sentinel-configured-model"'), "a cached report was reused");
    await call("codex_doctor", { working_dir: fake.workingDir, extended: true, refresh: true });
    assert.equal(doctorSpawns().length, 3);
  });
});

test("AC-11 concurrent calls each get their own run and their own result", async () => {
  const controlled = controlledDoctor();
  await withServer(
    { chunks: [] },
    async (call, fake) => {
      const a = call("codex_doctor", { working_dir: fake.workingDir, extended: true, refresh: true });
      const b = call("codex_doctor", { working_dir: fake.workingDir, extended: true, refresh: false });
      await waitFor(() => controlled.calls.length === 2, 5_000, "two doctor runners");
      controlled.calls[1]!.finish(outcome({ stdout: report("warning"), exitCode: 1 }));
      controlled.calls[0]!.finish(outcome({ stdout: report("healthy") }));
      const [first, second] = await Promise.all([a, b]);
      const texts = [first.content[1]!.text, second.content[1]!.text];
      assert.equal(texts.filter((text) => text.includes('configured model: "sentinel-configured-model"')).length, 1);
      assert.equal(texts.filter((text) => text.includes('configured model: "<default>"')).length, 1);
    },
    { doctorReportRunner: controlled.run },
  );
});

// ---------------------------------------------------------------------------
// AC-12

test("AC-12 lists extended with a false default, an open-world read-only tool, and the new description", async () => {
  await withServer({ chunks: [] }, async (_call, _fake, created) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await created.server.connect(serverSide);
    const client = new Client({ name: "doctor-extended-test", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      const doctor = tools.find((tool) => tool.name === "codex_doctor");
      assert.ok(doctor);
      const extended = (doctor.inputSchema.properties as Record<string, { type?: unknown; default?: unknown }> | undefined)?.extended;
      assert.ok(extended, "extended is listed");
      assert.equal(extended.type, "boolean");
      assert.equal(extended.default, false);
      assert.equal(doctor.annotations?.readOnlyHint, true);
      assert.equal(doctor.annotations?.openWorldHint, true);
      assert.ok(doctor.description?.includes("never installs or repairs anything"), doctor.description);
      assert.ok(!doctor.description?.includes("changes anything"), doctor.description);
    } finally {
      await client.close();
    }
  });
});
