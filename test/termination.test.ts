import assert from "node:assert/strict";
import { test } from "node:test";

import { runCodex, type RunHandle } from "../src/codex/runner.ts";
import { describeFailure } from "../src/outcome.ts";
import type { DelegationResult } from "../src/types.ts";

import { createFakeCodex, jsonl, type Scenario } from "./fixtures/fake-codex.ts";

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fails by assertion instead of hanging the suite when a result never settles. */
async function settleWithin(result: Promise<DelegationResult>, ms: number): Promise<DelegationResult> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the run did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([result, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts a run against the stand-in and cancels it once `cancelOn` has been
 * seen, or lets `timeoutSeconds` end it. Always kills the descendant afterwards,
 * so a failing assertion never leaves a process behind.
 */
async function runAndStop(
  scenario: Scenario,
  options: { cancelOnThread?: boolean; cancelOnMessage?: boolean; timeoutSeconds?: number },
  check: (outcome: DelegationResult, descendantPid: number | null, cancelledAt: number) => Promise<void>,
): Promise<void> {
  const fake = createFakeCodex(scenario);
  let descendantPid: number | null = null;
  try {
    let cancelledAt = 0;
    let handle: RunHandle | undefined;
    handle = runCodex({
      invocation: { kind: "exec", sandbox: "read-only", workingDir: fake.workingDir },
      prompt: "irrelevant",
      codexPath: fake.codexPath,
      codexHome: fake.workingDir,
      timeoutSeconds: options.timeoutSeconds ?? 60,
      killGraceMs: GRACE_MS,
      onEvent: (event) => {
        const due =
          (options.cancelOnThread && event.type === "thread.started") ||
          (options.cancelOnMessage && event.type === "item.completed");
        if (due && cancelledAt === 0) {
          cancelledAt = Date.now();
          handle?.cancel();
        }
      },
    });
    const outcome = await settleWithin(
      handle.result,
      (options.timeoutSeconds ?? 0) * 1000 + GRACE_MS + SETTLE_SLACK_MS + 1000,
    );
    descendantPid = fake.descendantPid();
    await check(outcome, descendantPid, cancelledAt);
  } finally {
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

test("AC-1 settles a cancelled run while a descendant holds its pipes", async () => {
  await runAndStop(
    {
      chunks: [THREAD],
      stayRunning: true,
      descendant: { holdMs: 20_000, holdPipes: true, ignoreSigterm: POSIX },
    },
    { cancelOnThread: true },
    async (outcome, _pid, cancelledAt) => {
      const settledAfter = Date.now() - cancelledAt;
      assert.ok(settledAfter < GRACE_MS + SETTLE_SLACK_MS, `settled ${settledAfter} ms after the cancel`);
      assert.equal(outcome.threadId, "tree");
    },
  );
});

test("AC-2 AC-3 leaves no descendant alive after a cancelled run's grace period", async () => {
  await runAndStop(
    {
      chunks: [THREAD],
      stayRunning: true,
      descendant: { holdMs: 20_000, holdPipes: false, ignoreSigterm: POSIX },
    },
    { cancelOnThread: true },
    async (_outcome, pid) => {
      assert.notEqual(pid, null, "the stand-in should have started its descendant");
      await sleep(GRACE_MS + 500);
      assert.equal(isAlive(pid!), false, `descendant ${pid} outlived the cancelled run`);
    },
  );
});

test("AC-2 AC-3 leaves no descendant alive after a timed-out run's grace period", async () => {
  await runAndStop(
    {
      chunks: [THREAD],
      stayRunning: true,
      descendant: { holdMs: 20_000, holdPipes: true, ignoreSigterm: POSIX },
    },
    { timeoutSeconds: 1 },
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
      // A CLI that answers SIGTERM by finishing cleanly must still not read as a success.
      onSigterm: {
        chunks: [jsonl({ type: "item.completed", item: { type: "agent_message", text: "Stopping." } })],
        exitCode: 0,
      },
    },
    { cancelOnMessage: true },
    async (outcome) => {
      assert.equal(outcome.cancelled, true);
      assert.match(describeFailure(outcome) ?? "", /cancel/i);
      assert.ok(outcome.agentMessages.includes("Partial findings."));
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

test("AC-1 (#107) stops a command Codex started in its own process group when the run is cancelled", async () => {
  await runAndStop(OWN_GROUP_COMMAND, { cancelOnThread: true }, async (_outcome, pid) => {
    assert.notEqual(pid, null);
    await sleep(GRACE_MS + 500);
    assert.equal(isAlive(pid!), false, `command ${pid} outlived the cancelled run`);
  });
});

test("AC-2 (#107) stops a command Codex started in its own process group when the run times out", async () => {
  await runAndStop(OWN_GROUP_COMMAND, { timeoutSeconds: 1 }, async (outcome, pid) => {
    assert.equal(outcome.timedOut, true);
    assert.notEqual(pid, null);
    await sleep(GRACE_MS + 500);
    assert.equal(isAlive(pid!), false, `command ${pid} outlived the timed-out run`);
  });
});
