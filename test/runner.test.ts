import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runCodex } from "../src/codex/runner.ts";

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

test("still parses the events emitted before the timeout", POSIX_ONLY, async () => {
  const { result } = runCodex({
    invocation: INVOCATION,
    prompt: "irrelevant",
    timeoutSeconds: 1,
    codexPath: STUBBORN_CODEX,
  });

  const outcome = await result;
  assert.equal(outcome.threadId, "stub-thread");
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


test("settles at the timeout when an exited child leaves its pipes open", async () => {
  const fake = createFakeCodex({
    chunks: [jsonl({ type: "thread.started", thread_id: "parent-exited" })],
    descendantHoldMs: 4000,
    exitCode: 0,
  });
  try {
    const handle = runCodex({
      invocation: { ...INVOCATION, workingDir: fake.workingDir },
      prompt: "irrelevant",
      codexPath: fake.codexPath,
      timeoutSeconds: 1,
    });
    const outcome = await handle.result;
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.threadId, "parent-exited");
    assert.ok(outcome.durationMs < 3000, `settled after ${outcome.durationMs} ms`);
    handle.cancel();
    assert.equal(await handle.result, outcome);
  } finally {
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
