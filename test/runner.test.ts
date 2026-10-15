import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runCodex, type RunHandle } from "../src/codex/runner.ts";

import { createFakeCodex, jsonl } from "./fixtures/fake-codex.ts";

const STUBBORN_CODEX = fileURLToPath(
  new URL("./fixtures/stubborn-codex.mjs", import.meta.url),
);

const INVOCATION = { kind: "exec" as const, sandbox: "read-only" as const };

/**
 * The termination tests are POSIX-only, for two independent reasons:
 *
 * 1. The fixture is a shebang script, and Windows does not honour shebangs —
 *    `spawn` fails with UNKNOWN rather than running it under Node.
 * 2. Windows has no POSIX signals. `child.kill("SIGTERM")` terminates the
 *    process outright, so a child that *ignores* SIGTERM — the whole premise of
 *    the escalation test — cannot exist there.
 *
 * The behaviour under test is therefore not merely untested on Windows; it is
 * different by platform. Verifying it properly there would need a separate
 * fixture and separate expectations.
 */
const POSIX_ONLY = {
  skip: process.platform === "win32" ? "POSIX signals and shebangs only" : false,
};

// Captured before any test mocks the clock (#169), so the helpers below keep
// waiting in real time while a test drives the runner's timers.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Fails instead of hanging the suite when `promise` never settles. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = realSetTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    realClearTimeout(timer);
  }
}

/**
 * Whether `pid` still exists. The runner's child stops existing when it is
 * reaped, in the same libuv callback that records its exit code, so once this
 * is false for it the runner knows it has exited.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Resolves once `condition` holds, checking in real time. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => realSetTimeout(resolve, 10));
}

/** The grace of the mocked-clock tests below; ticked, never waited for. */
const GRACE_MS = 300;

test("kills a child that outlives its timeout and reports it", POSIX_ONLY, async () => {
  const started = Date.now();
  const { result } = runCodex({
    invocation: INVOCATION,
    prompt: "irrelevant",
    timeoutSeconds: 1,
    codexPath: STUBBORN_CODEX,
  });

  const outcome = await result;

  assert.equal(outcome.timedOut, true);
  // The fixture ignores SIGTERM, so only the SIGKILL escalation can end it.
  assert.equal(outcome.exitCode, null);
  assert.ok(Date.now() - started < 20_000, "the run should not hang past the grace period");
});

/**
 * The cross-platform stand-in, but still POSIX-only: it ignores SIGTERM and
 * SIGINT, which Windows cannot send.
 */
test("AC-2 (#169) still parses the events emitted before the timeout", POSIX_ONLY, async (t) => {
  const fake = createFakeCodex({
    chunks: [jsonl({ type: "thread.started", thread_id: "stub-thread" }), jsonl({ type: "turn.started" })],
    stayRunning: true,
    ignoreSigterm: true,
    // Starting after the 1 s timeout, as on a loaded machine (#169).
    startDelayMs: 1200,
  });
  // The runner arms its deadline as the run starts. On a mocked clock it passes
  // only once the stand-in has written its events, however late it started.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let handle: RunHandle | undefined;
  try {
    let seen!: () => void;
    const written = new Promise<void>((resolve) => { seen = resolve; });
    handle = runCodex({
      invocation: { ...INVOCATION, workingDir: fake.workingDir },
      prompt: "irrelevant",
      timeoutSeconds: 1,
      killGraceMs: GRACE_MS,
      codexPath: fake.codexPath,
      onEvent: (event) => { if (event.type === "turn.started") seen(); },
    });
    await within(written, 10_000, "the stand-in's events");
    t.mock.timers.tick(1000);

    const outcome = await within(handle.result, 5000, "the timeout");
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.threadId, "stub-thread");
    // It ignores SIGINT: only the forced stage ends it.
    t.mock.timers.tick(GRACE_MS);
  } finally {
    // Real time again, so a failure above can still stop the stand-in.
    t.mock.timers.reset();
    handle?.cancel({ graceMs: 0 });
    await within(handle?.exited ?? Promise.resolve(), 5000, "exit").catch(() => {});
    fake.dispose();
  }
});

test("survives a cancel racing the timeout without hanging", POSIX_ONLY, async () => {
  // Both paths call terminate() before the child exits. Without a guard each
  // arms its own kill timer and only the last one is ever cleared.
  const handle = runCodex({
    invocation: INVOCATION,
    prompt: "irrelevant",
    timeoutSeconds: 1,
    codexPath: STUBBORN_CODEX,
  });

  handle.cancel();
  handle.cancel();
  setTimeout(() => handle.cancel(), 1100).unref();

  const outcome = await handle.result;
  assert.equal(outcome.exitCode, null);
});

test("reports a codex binary that cannot be started", async () => {
  const { result } = runCodex({
    invocation: INVOCATION,
    prompt: "irrelevant",
    codexPath: "/nonexistent/codex-binary",
  });

  await assert.rejects(result, /Could not (run|start) the Codex CLI/);
});


/**
 * Windows does not reproduce the premise. On CI this run settled in 89 ms with
 * `timedOut: false`, meaning `close` arrived as soon as the parent exited even
 * though a descendant had inherited its stdout and stderr — so there is no
 * stuck pipe to defeat the deadline, and nothing for this test to observe.
 *
 * As with the signal tests above, the behaviour differs by platform rather than
 * being merely unverified there. The fix itself is platform-independent: what
 * cannot be exercised on Windows is the situation it protects against.
 */
test("AC-2 (#169) settles at the timeout when an exited child leaves its pipes open", POSIX_ONLY, async (t) => {
  const fake = createFakeCodex({
    chunks: [jsonl({ type: "thread.started", thread_id: "parent-exited" })],
    // It ignores the polite request, so its pipes stay open past the deadline
    // and only the forced stage ends it.
    descendant: { holdMs: 20_000, holdPipes: true, ignoreSigterm: true },
    exitCode: 0,
    // Starting after the 1 s timeout, as on a loaded machine (#169).
    startDelayMs: 1200,
  });
  // The runner arms its deadline as the run starts.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let handle: RunHandle | undefined;
  try {
    let seen!: () => void;
    const started = new Promise<void>((resolve) => { seen = resolve; });
    handle = runCodex({
      invocation: { ...INVOCATION, workingDir: fake.workingDir },
      prompt: "irrelevant",
      codexPath: fake.codexPath,
      timeoutSeconds: 1,
      killGraceMs: GRACE_MS,
      onEvent: (event) => { if (event.type === "thread.started") seen(); },
    });
    let settled = false;
    handle.result.then(() => { settled = true; }, () => {});
    const pid = handle.pid!;
    await within(started, 10_000, "the start");
    await within(until(fake.descendantReady), 10_000, "the descendant's start");
    await within(until(() => !alive(pid)), 5000, "the stand-in's exit");

    // The premise: the stand-in has exited, its descendant holds the pipes,
    // and nothing but the deadline can settle the run.
    assert.equal(alive(fake.descendantPid()!), true, "the descendant no longer holds the pipes");
    assert.equal(settled, false, "settled before the timeout");

    t.mock.timers.tick(1000);
    const outcome = await within(handle.result, 5000, "the settlement at the timeout");
    // A run counts as timed out only if it was still unsettled at the deadline.
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.threadId, "parent-exited");
    // It settled while the descendant, ignoring SIGINT, still held the pipes.
    assert.equal(alive(fake.descendantPid()!), true, "the descendant was gone before the settlement");
    handle.cancel();
    assert.equal(await handle.result, outcome);
    t.mock.timers.tick(GRACE_MS);
  } finally {
    // Real time again, so a failure above can still stop the descendant.
    t.mock.timers.reset();
    handle?.cancel({ graceMs: 0 });
    await within(handle?.exited ?? Promise.resolve(), 5000, "exit").catch(() => {});
    fake.dispose();
  }
});

test("does not spawn a child when cancellation happened before the run", async () => {
  const fake = createFakeCodex({ chunks: [] });
  const controller = new AbortController();
  controller.abort();
  try {
    const handle = runCodex({
      invocation: { ...INVOCATION, workingDir: fake.workingDir },
      prompt: "irrelevant",
      codexPath: fake.codexPath,
      signal: controller.signal,
    });
    await assert.rejects(handle.result, /abort|cancel/i);
    handle.cancel();
    assert.equal(existsSync(join(fake.workingDir, "received.json")), false);
  } finally {
    fake.dispose();
  }
});

test("contains progress callback failures without losing later events", async () => {
  const fake = createFakeCodex({ chunks: [jsonl(
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "Still running." } },
  )] });
  try {
    const { result } = runCodex({
      invocation: { ...INVOCATION, workingDir: fake.workingDir },
      prompt: "irrelevant",
      codexPath: fake.codexPath,
      onEvent: () => { throw new Error("progress failed"); },
    });
    const outcome = await result;
    assert.equal(outcome.finalMessage, "Still running.");
    assert.ok(outcome.errors.some((message) => message.includes("progress failed")));
  } finally {
    fake.dispose();
  }
});
