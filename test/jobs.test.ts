import assert from "node:assert/strict";
import { test } from "node:test";

import { JobRegistry } from "../src/jobs.ts";

async function settle(registry: JobRegistry, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      if (registry.snapshot(jobId).state !== "running") return;
    } catch (error) {
      // With a zero retention, a status read evicts the job the moment it
      // finishes — which is the behaviour under test, and also means it settled.
      if (error instanceof Error && /Unknown job id/.test(error.message)) return;
      throw error;
    }
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

async function finishedJob(registry: JobRegistry): Promise<string> {
  const jobId = registry.start({
    model: null,
    reasoningEffort: null,
    controller: new AbortController(),
    run: () => Promise.reject(new Error("done")),
  });
  await settle(registry, jobId);
  return jobId;
}

test("evicts an expired job when its status is read, not only when listing", async () => {
  // Expiry used to be swept only by start() and list(), so a caller that only
  // polled status kept every finished job forever.
  const registry = new JobRegistry({ retentionMs: 0 });
  const jobId = await finishedJob(registry);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.throws(() => registry.snapshot(jobId), /Unknown job id/);
});

test("never evicts a job that is still running, however old", async () => {
  const registry = new JobRegistry({ retentionMs: 0 });
  const jobId = registry.start({
    model: null,
    reasoningEffort: null,
    controller: new AbortController(),
    run: () => new Promise(() => {}),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(registry.snapshot(jobId).state, "running");
});

test("keeps at most the configured number of finished jobs, dropping the oldest", async () => {
  const registry = new JobRegistry({ maxFinishedJobs: 2 });
  const first = await finishedJob(registry);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await finishedJob(registry);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const third = await finishedJob(registry);

  assert.throws(() => registry.snapshot(first), /Unknown job id/);
  assert.equal(registry.snapshot(second).state, "failed");
  assert.equal(registry.snapshot(third).state, "failed");
});

