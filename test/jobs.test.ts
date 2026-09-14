import assert from "node:assert/strict";
import { test } from "node:test";

import { JobRegistry } from "../src/jobs.ts";

async function settle(registry: JobRegistry, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && registry.snapshot(jobId).state === "running"; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("records a job cancelled before its run started as cancelled, not failed", async () => {
  // The runner rejects outright when the signal is already aborted, so the
  // rejection path has to recognise a cancellation too.
  const registry = new JobRegistry();
  const controller = new AbortController();
  let rejectRun: (error: Error) => void = () => {};

  const jobId = registry.start({
    model: null,
    reasoningEffort: null,
    controller,
    run: () => new Promise((_resolve, reject) => (rejectRun = reject)),
  });

  controller.abort();
  rejectRun(new Error("Codex delegation was cancelled before it started."));
  await settle(registry, jobId);
  // `cancel()` marks the state immediately; bypassing it here is the point, so
  // the assertion is about what the rejection handler decided on its own.
  assert.equal(registry.snapshot(jobId).state, "cancelled");
});

test("still records a run that could not start for another reason as failed", async () => {
  const registry = new JobRegistry();
  const jobId = registry.start({
    model: null,
    reasoningEffort: null,
    controller: new AbortController(),
    run: () => Promise.reject(new Error("spawn ENOENT")),
  });

  await settle(registry, jobId);
  assert.equal(registry.snapshot(jobId).state, "failed");
  assert.match(registry.snapshot(jobId).error ?? "", /ENOENT/);
});
