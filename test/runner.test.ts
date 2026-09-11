import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runCodex } from "../src/codex/runner.ts";

const STUBBORN_CODEX = fileURLToPath(
  new URL("./fixtures/stubborn-codex.mjs", import.meta.url),
);

const INVOCATION = { kind: "exec" as const, sandbox: "read-only" as const };

test("kills a child that outlives its timeout and reports it", async () => {
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

test("still parses the events emitted before the timeout", async () => {
  const { result } = runCodex({
    invocation: INVOCATION,
    prompt: "irrelevant",
    timeoutSeconds: 1,
    codexPath: STUBBORN_CODEX,
  });

  const outcome = await result;
  assert.equal(outcome.threadId, "stub-thread");
});

test("survives a cancel racing the timeout without hanging", async () => {
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
