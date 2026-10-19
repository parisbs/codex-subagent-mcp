import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { runCodex, type RunHandle } from "../src/codex/runner.ts";
import { describeFailure } from "../src/outcome.ts";
import type { DelegationResult } from "../src/types.ts";

import { createFakeCodex, jsonl, type Scenario } from "./fixtures/fake-codex.ts";
import { processTableDecision } from "./support/process-table-gate.ts";

/**
 * What stopping a run leaves behind (#96).
 *
 * Codex runs commands, and those commands are the runner's grandchildren. Before
 * #96 a cancellation signalled only the Codex process: its descendants kept
 * running, and one that held the inherited stdout kept the result from settling
 * until the timeout. These tests use the Node stand-in, so they run on every
 * platform; only the SIGTERM-ignoring variants are POSIX-specific, because
 * Windows has no SIGTERM to ignore.
 */

const POSIX = process.platform !== "win32";

/** Short, so the forced stage of termination is exercised without slowing the suite. */
const GRACE_MS = 300;

/** How long a settle may take beyond the grace: process teardown and pipe close. */
const SETTLE_SLACK_MS = 2500;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Captured before any test mocks the clock (#169), so the helpers below keep
// waiting in real time while a test drives the runner's timers.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const sleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));

/** Fails by assertion instead of hanging the suite when `promise` never settles. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    realClearTimeout(timer);
  }
}

/** Fails by assertion instead of hanging the suite when a result never settles. */
const settleWithin = (result: Promise<DelegationResult>, ms: number): Promise<DelegationResult> =>
  within(result, ms, "the run did not settle");

/** Resolves once `condition` holds, checking in real time. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await sleep(10);
}

/** The deadline of the timed-out runs, ticked on a mocked clock. */
const TIMEOUT_SECONDS = 1;

/**
 * How much later than on an idle machine the descendant of the cancelled runs
 * can ignore a signal (#174), so their cancel would reach it too early unless
 * it waits for that.
 */
const DESCENDANT_START_DELAY_MS = 500;

/**
 * Starts a run against the stand-in and cancels it once `cancelOn` has been
 * seen, or lets the timeout end it. Always kills the descendant afterwards,
 * so a failing assertion never leaves a process behind.
 *
 * A run cancelled on `thread.started` is cancelled only once the descendant,
 * if the scenario has one, can ignore the polite request it is meant to ignore
 * (#174): the stand-in starts it just before that event, and a request that
 * arrives before its handlers are in place ends it without the forced stage.
 *
 * A timed-out run is driven on the mocked clock `timeOutOnThread` (#169): the
 * stand-in may start late on a loaded machine, so the deadline passes only once
 * `thread.started` has been seen, which implies the descendant's pid, and once
 * the descendant can ignore the polite request it is meant to ignore. The grace
 * is ticked once Codex has exited on that request, the order a real run goes
 * through, and the clock is restored before any check runs.
 */
async function runAndStop(
  scenario: Scenario,
  options: { cancelOnThread?: boolean; cancelOnMessage?: boolean; timeOutOnThread?: TestContext["mock"]["timers"] },
  check: (outcome: DelegationResult, descendantPid: number | null, cancelledAt: number) => Promise<void>,
): Promise<void> {
  const fake = createFakeCodex(scenario);
  const timers = options.timeOutOnThread;
  let descendantPid: number | null = null;
  let handle: RunHandle | undefined;
  try {
    let cancelledAt = 0;
    let seen!: () => void;
    const started = new Promise<void>((resolve) => { seen = resolve; });
    // The runner arms its deadline as the run starts.
    timers?.enable({ apis: ["setTimeout"] });
    handle = runCodex({
      invocation: { kind: "exec", sandbox: "read-only", workingDir: fake.workingDir },
      prompt: "irrelevant",
      codexPath: fake.codexPath,
      codexHome: fake.workingDir,
      timeoutSeconds: timers ? TIMEOUT_SECONDS : 60,
      killGraceMs: GRACE_MS,
      onEvent: (event) => {
        if (event.type === "thread.started") seen();
        if (options.cancelOnMessage && event.type === "item.completed" && cancelledAt === 0) {
          cancelledAt = Date.now();
          handle?.cancel();
        }
      },
    });
    if (options.cancelOnThread || timers) {
      await within(started, 10_000, "thread.started did not arrive");
      if (scenario.descendant) await within(until(fake.descendantReady), 10_000, "the descendant was not ready");
    }
    if (options.cancelOnThread) {
      cancelledAt = Date.now();
      handle.cancel();
    }
    if (timers) {
      timers.tick(TIMEOUT_SECONDS * 1000);
      const codexPid = handle.pid!;
      await within(until(() => !isAlive(codexPid)), 5000, "Codex did not exit on the polite request");
      timers.tick(GRACE_MS);
      timers.reset();
    }
    const outcome = await settleWithin(handle.result, GRACE_MS + SETTLE_SLACK_MS + 1000);
    descendantPid = fake.descendantPid();
    await check(outcome, descendantPid, cancelledAt);
  } finally {
    if (timers) {
      // Real time again, so a failure above can still stop the run.
      timers.reset();
      handle?.cancel({ graceMs: 0 });
    }
    descendantPid ??= fake.descendantPid();
    if (descendantPid !== null && isAlive(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    // Windows keeps the fixture directory busy while the stand-in lives.
    await sleep(100);
    fake.dispose();
  }
}

const THREAD = jsonl({ type: "thread.started", thread_id: "tree" });

test("AC-1 (#174 AC-2 AC-3) settles a cancelled run while a descendant holds its pipes", async () => {
  await runAndStop(
    {
      chunks: [THREAD],
      stayRunning: true,
      // Ready after `thread.started`, as on a loaded machine (#174).
      descendant: { holdMs: 20_000, holdPipes: true, ignoreSigterm: POSIX, startDelayMs: DESCENDANT_START_DELAY_MS },
    },
    { cancelOnThread: true },
    async (outcome, _pid, cancelledAt) => {
      const settledAfter = Date.now() - cancelledAt;
      assert.ok(settledAfter < GRACE_MS + SETTLE_SLACK_MS, `settled ${settledAfter} ms after the cancel`);
      assert.equal(outcome.threadId, "tree");
    },
  );
});

test("AC-2 AC-3 (#174 AC-1 AC-3) leaves no descendant alive after a cancelled run's grace period", async () => {
  await runAndStop(
    {
      chunks: [THREAD],
      stayRunning: true,
      // Ready after `thread.started`, as on a loaded machine (#174).
      descendant: { holdMs: 20_000, holdPipes: false, ignoreSigterm: POSIX, startDelayMs: DESCENDANT_START_DELAY_MS },
    },
    { cancelOnThread: true },
    async (_outcome, pid) => {
      assert.notEqual(pid, null, "the stand-in should have started its descendant");
      await sleep(GRACE_MS + 500);
      assert.equal(isAlive(pid!), false, `descendant ${pid} outlived the cancelled run`);
    },
  );
});

test("AC-2 AC-3 (#169 AC-3) leaves no descendant alive after a timed-out run's grace period", async (t) => {
  await runAndStop(
    {
      chunks: [THREAD],
      stayRunning: true,
      descendant: { holdMs: 20_000, holdPipes: true, ignoreSigterm: POSIX },
      // Starting after the 1 s timeout, as on a loaded machine (#169).
      startDelayMs: 1200,
    },
    { timeOutOnThread: t.mock.timers },
    async (outcome, pid) => {
      assert.equal(outcome.timedOut, true);
      assert.notEqual(pid, null, "the stand-in should have started its descendant");
      await sleep(GRACE_MS + 500);
      assert.equal(isAlive(pid!), false, `descendant ${pid} outlived the timed-out run`);
    },
  );
});

test("AC-5 reports a cancelled run as cancelled and keeps its partial output", async () => {
  await runAndStop(
    {
      chunks: [
        THREAD,
        jsonl({ type: "item.completed", item: { type: "agent_message", text: "Partial findings." } }),
      ],
      stayRunning: true,
      // A CLI that answers the stop request by finishing cleanly must still not read as a success.
      onStop: {
        chunks: [jsonl({ type: "item.completed", item: { type: "agent_message", text: "Stopping." } })],
        exitCode: 0,
      },
    },
    { cancelOnMessage: true },
    async (outcome) => {
      assert.equal(outcome.cancelled, true);
      assert.match(describeFailure(outcome) ?? "", /cancel/i);
      assert.ok(outcome.agentMessages.includes("Partial findings."));
      if (POSIX) {
        // The stand-in answered the stop request, so its last words were read too.
        assert.ok(outcome.agentMessages.includes("Stopping."));
        assert.equal(outcome.exitCode, 0);
      }
    },
  );
});

// #107: what the real CLI does, reproduced — a command in a process group of
// its own, which a signal to Codex's group never reaches.

test("AC-4 (#107) asks Codex to stop with SIGINT first", { skip: POSIX ? false : "no signals on Windows" }, async () => {
  const fake = createFakeCodex({ chunks: [THREAD], stayRunning: true, recordSignals: true });
  try {
    let handle: RunHandle | undefined;
    handle = runCodex({
      invocation: { kind: "exec", sandbox: "read-only", workingDir: fake.workingDir },
      prompt: "irrelevant",
      codexPath: fake.codexPath,
      codexHome: fake.workingDir,
      killGraceMs: GRACE_MS,
      onEvent: (event) => { if (event.type === "thread.started") handle?.cancel(); },
    });
    await settleWithin(handle.result, GRACE_MS + SETTLE_SLACK_MS + 1000);
    assert.equal(fake.signals()[0], "SIGINT");
  } finally {
    await sleep(100);
    fake.dispose();
  }
});

const OWN_GROUP_COMMAND: Scenario = {
  chunks: [THREAD],
  stayRunning: true,
  descendant: { holdMs: 20_000, holdPipes: false, ignoreSigterm: POSIX, ownGroup: true },
};

test("AC-1 (#107) stops a command Codex started in its own process group when the run is cancelled", async (t) => {
  const table = processTableDecision();
  if (table.action === "skip") return t.skip(table.reason);
  if (table.action === "fail") assert.fail(table.message);
  await runAndStop(OWN_GROUP_COMMAND, { cancelOnThread: true }, async (_outcome, pid) => {
    assert.notEqual(pid, null);
    await sleep(GRACE_MS + 500);
    assert.equal(isAlive(pid!), false, `command ${pid} outlived the cancelled run`);
  });
});

test("AC-2 (#107) (#169 AC-3) stops a command Codex started in its own process group when the run times out", async (t) => {
  const table = processTableDecision();
  if (table.action === "skip") return t.skip(table.reason);
  if (table.action === "fail") assert.fail(table.message);
  // Starting after the 1 s timeout, as on a loaded machine (#169).
  await runAndStop({ ...OWN_GROUP_COMMAND, startDelayMs: 1200 }, { timeOutOnThread: t.mock.timers }, async (outcome, pid) => {
    assert.equal(outcome.timedOut, true);
    assert.notEqual(pid, null);
    await sleep(GRACE_MS + 500);
    assert.equal(isAlive(pid!), false, `command ${pid} outlived the timed-out run`);
  });
});
