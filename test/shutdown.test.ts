import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runCodex, type RunHandle } from "../src/codex/runner.ts";
import { ActiveRuns } from "../src/runs.ts";
import { createShutdown, installShutdownTriggers } from "../src/shutdown.ts";
import { readProcessTable } from "../src/codex/terminate.ts";
import { EventEmitter } from "node:events";

import { createFakeCodex, jsonl, type FakeCodex } from "./fixtures/fake-codex.ts";

/**
 * Shutdown within the host's budget (#40).
 *
 * Measured on 2026-09-30: Claude Code sends SIGINT, SIGTERM 100 ms later, and
 * kills the server 430 to 550 ms after the first signal. Whatever the server has
 * not stopped by then outlives it, so shutdown must finish inside that window.
 * The sequence is tested in-process with real child processes; the signal and
 * stdin wiring of `src/index.ts` is tested against a real server process.
 */

const POSIX = process.platform !== "win32";
const DEADLINE_MS = 350;
/**
 * The host kills the server 430 to 550 ms after its first signal (#40). A test
 * with real processes measures the machine as well as the code, so it is held
 * to this budget, the limit that matters, not to the server's own schedule; the
 * schedule is checked with a mocked clock (#116).
 */
const HOST_BUDGET_MS = 430;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  // A zombie has stopped: it runs nothing and waits only to be reaped, which
  // under load can take longer than these tests wait (#116).
  if (!POSIX) return true;
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return state !== "" && !state.startsWith("Z");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A shutdown whose exit and log are recorded instead of performed. */
function harness(runs: ActiveRuns) {
  const exits: { code: number; atMs: number }[] = [];
  const logs: string[] = [];
  let cancelledJobs = 0;
  const shutdown = createShutdown({
    runs,
    jobs: { cancelAll: () => { cancelledJobs += 1; } },
    close: async () => {},
    exit: (code) => { exits.push({ code, atMs: Date.now() }); },
    log: (message) => { logs.push(message); },
  });
  return { shutdown, exits, logs, cancelledJobs: () => cancelledJobs };
}

async function waitForExit(exits: unknown[], ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (exits.length === 0 && Date.now() < until) await sleep(5);
}

/** Starts a stand-in that will not stop when asked, tracked like a delegation. */
async function startStubborn(runs: ActiveRuns): Promise<{ fake: FakeCodex; handle: RunHandle }> {
  const fake = createFakeCodex({
    chunks: [jsonl({ type: "thread.started", thread_id: "stubborn" })],
    stayRunning: true,
    ignoreSigterm: POSIX,
    descendant: { holdMs: 20_000, holdPipes: true, ignoreSigterm: POSIX },
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const handle = runs.track(runCodex({
    invocation: { kind: "exec", sandbox: "read-only", workingDir: fake.workingDir },
    prompt: "irrelevant",
    codexPath: fake.codexPath,
    codexHome: fake.workingDir,
    timeoutSeconds: 60,
    onEvent: (event) => { if (event.type === "thread.started") started(); },
  }));
  await ready;
  return { fake, handle };
}

function killQuietly(pid: number | null | undefined): void {
  if (pid === null || pid === undefined || !isAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

test("AC-1 stops every run, forcing the stubborn ones, within the host's budget", async () => {
  const runs = new ActiveRuns();
  const started = [await startStubborn(runs), await startStubborn(runs)];
  const pids = started.flatMap(({ fake, handle }) => [handle.pid!, fake.descendantPid()!]);
  try {
    const { shutdown, exits, cancelledJobs } = harness(runs);
    const at = Date.now();
    shutdown(143);
    await waitForExit(exits, 2000);

    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.code, 143);
    assert.ok(exits[0]!.atMs - at <= HOST_BUDGET_MS, `exited ${exits[0]!.atMs - at} ms after the signal`);
    assert.equal(cancelledJobs(), 1, "background jobs should be marked cancelled");
    await sleep(100);
    for (const pid of pids) assert.equal(isAlive(pid), false, `process ${pid} survived shutdown`);
  } finally {
    for (const pid of pids) killQuietly(pid);
    await sleep(100);
    for (const { fake } of started) fake.dispose();
  }
});

test("AC-3 (#107) stops a command Codex started in its own process group, within the host's budget", async () => {
  const runs = new ActiveRuns();
  const fake = createFakeCodex({
    chunks: [jsonl({ type: "thread.started", thread_id: "own-group" })],
    stayRunning: true,
    descendant: { holdMs: 20_000, holdPipes: false, ignoreSigterm: POSIX, ownGroup: true },
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  runs.track(runCodex({
    invocation: { kind: "exec", sandbox: "read-only", workingDir: fake.workingDir },
    prompt: "irrelevant",
    codexPath: fake.codexPath,
    codexHome: fake.workingDir,
    timeoutSeconds: 60,
    onEvent: (event) => { if (event.type === "thread.started") started(); },
  }));
  await ready;
  const pid = fake.descendantPid();
  try {
    const { shutdown, exits } = harness(runs);
    const at = Date.now();
    shutdown(143);
    await waitForExit(exits, 2000);
    assert.ok(exits[0]!.atMs - at <= HOST_BUDGET_MS, `exited ${exits[0]!.atMs - at} ms after the signal`);
    await sleep(100);
    assert.notEqual(pid, null);
    assert.equal(isAlive(pid!), false, `command ${pid} survived shutdown`);
  } finally {
    killQuietly(pid);
    await sleep(100);
    fake.dispose();
  }
});

test("AC-1 AC-2 AC-3 (#112) sends every forced stage before exiting, however slow the process table is", { skip: POSIX ? false : "Windows has no process table to read and ends the tree at once" }, async () => {
  // Each termination stage reads the process table (#107), which takes about
  // 30 ms on macOS. Read once per run, and with each SIGKILL counted from its
  // own run's polite stage, the second run's SIGKILL came after the exit.
  let reads = 0;
  const runs = new ActiveRuns({
    readProcessTable: () => {
      reads += 1;
      const until = Date.now() + 60;
      while (Date.now() < until) {
        // A slow process table, as on a loaded machine.
      }
      return readProcessTable();
    },
  });
  const started = [await startStubborn(runs), await startStubborn(runs)];
  const pids = started.flatMap(({ fake, handle }) => [handle.pid!, fake.descendantPid()!]);
  const order: string[] = [];
  const realKill = process.kill.bind(process);
  try {
    const shutdown = createShutdown({
      runs,
      jobs: { cancelAll: () => {} },
      close: async () => {},
      exit: () => { order.push("exit"); },
      log: () => {},
    });
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === "SIGKILL") order.push(`SIGKILL ${pid}`);
      return realKill(pid, signal);
    }) as typeof process.kill;
    shutdown(143);
    const until = Date.now() + 2000;
    while (!order.includes("exit") && Date.now() < until) await sleep(5);
  } finally {
    process.kill = realKill;
    for (const pid of pids) killQuietly(pid);
    await sleep(100);
    for (const { fake } of started) fake.dispose();
  }

  const exitAt = order.indexOf("exit");
  assert.notEqual(exitAt, -1, "the server never exited");
  for (const { handle } of started) {
    // A POSIX run's tree is its process group, signalled as the negative pid.
    const killedAt = order.indexOf(`SIGKILL ${-handle.pid!}`);
    assert.ok(killedAt !== -1 && killedAt < exitAt, `run ${handle.pid} was not forced before the exit: ${order.join(", ")}`);
  }
  // At least once, or the slow table above was never exercised.
  assert.ok(reads >= 1 && reads <= 2, `the process table was read ${reads} times for two runs; once per stage is enough`);
});

test("AC-3 exits at once when nothing is running", async () => {
  const { shutdown, exits } = harness(new ActiveRuns());
  const at = Date.now();
  shutdown(0);
  await waitForExit(exits, 2000);
  assert.equal(exits[0]?.code, 0);
  assert.ok(exits[0]!.atMs - at < 50, `waited ${exits[0]!.atMs - at} ms with nothing to stop`);
});

test("AC-5 exits on time and names a process it could not confirm stopped", async () => {
  const runs = new ActiveRuns();
  // A run whose process never reports back, as when its pipes are held forever.
  runs.track({
    pid: 424242,
    result: new Promise(() => {}),
    exited: new Promise(() => {}),
    cancel: () => {},
  });
  const { shutdown, exits, logs } = harness(runs);
  const at = Date.now();
  shutdown(143);
  await waitForExit(exits, 2000);
  assert.ok(exits[0]!.atMs - at <= DEADLINE_MS, `exited ${exits[0]!.atMs - at} ms after the signal`);
  assert.ok(logs.some((line) => line.includes("424242")), `stderr did not name the pid: ${logs.join(" | ")}`);
});

test("AC-1 AC-5 keep the deadline when starting to stop each run is slow", async () => {
  // Stopping a run on Windows spawns taskkill, which blocks for tens of
  // milliseconds; CI measured an exit at 373 ms with two runs when the deadline
  // was counted from after the cancels instead of from the signal.
  const runs = new ActiveRuns();
  const busy = (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // Stand-in for a synchronous process spawn.
    }
  };
  for (const pid of [101, 102, 103]) {
    runs.track({ pid, result: new Promise(() => {}), exited: new Promise(() => {}), cancel: () => busy(60) });
  }
  const { shutdown, exits } = harness(runs);
  const at = Date.now();
  shutdown(143);
  await waitForExit(exits, 2000);
  assert.ok(exits[0]!.atMs - at <= DEADLINE_MS, `exited ${exits[0]!.atMs - at} ms after the signal`);
});

test("AC-6 ignores a second signal while shutting down", async () => {
  const runs = new ActiveRuns();
  let cancels = 0;
  runs.track({ pid: 1, result: new Promise(() => {}), exited: sleep(150).then(() => {}), cancel: () => { cancels += 1; } });
  const { shutdown, exits } = harness(runs);
  shutdown(130);
  shutdown(143);
  await waitForExit(exits, 2000);
  await sleep(DEADLINE_MS);
  assert.deepEqual(exits.map((exit) => exit.code), [130]);
  assert.equal(cancels, 1);
});

const INDEX = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Starts the real server with no Codex CLI, waits until it is listening, then stops it. */
async function stopServer(stop: (child: ReturnType<typeof spawn>) => void): Promise<{ code: number | null; signal: string | null; ms: number }> {
  const child = spawn(process.execPath, ["--import", "tsx", INDEX], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_BIN: "/nonexistent/codex" },
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server did not start: ${stderr}`)), 15_000);
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes("running on stdio")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const at = Date.now();
  const exited = new Promise<{ code: number | null; signal: string | null; ms: number }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal, ms: Date.now() - at }));
  });
  stop(child);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    return await exited;
  } finally {
    clearTimeout(timer);
  }
}

test("AC-2 starts the shutdown with exit code 0 when stdin ends, and on each signal", () => {
  const proc = new EventEmitter();
  const stdin = new EventEmitter();
  const calls: number[] = [];
  installShutdownTriggers((code) => calls.push(code), { process: proc, stdin });
  stdin.emit("end");
  proc.emit("SIGTERM");
  proc.emit("SIGINT");
  assert.deepEqual(calls, [0, 143, 130]);
});

test("an idle server exits with code 0 when the host closes stdin", async () => {
  const outcome = await stopServer((child) => child.stdin!.end());
  assert.equal(outcome.signal, null, "the server should exit on its own, not be killed");
  assert.equal(outcome.code, 0);
});

test("exits with 143 on SIGTERM and 130 on SIGINT", { skip: POSIX ? false : "no catchable signals on Windows" }, async () => {
  assert.equal((await stopServer((child) => child.kill("SIGTERM"))).code, 143);
  assert.equal((await stopServer((child) => child.kill("SIGINT"))).code, 130);
});
