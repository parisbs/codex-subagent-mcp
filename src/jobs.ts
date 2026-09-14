import { randomUUID } from "node:crypto";

import type { CodexEvent } from "./codex/events.js";
import { describeFailure } from "./outcome.js";
import type {
  DelegationResult,
  JobSnapshot,
  JobState,
  ReasoningEffort,
} from "./types.js";

/** Concurrent background delegations allowed at once. */
const MAX_RUNNING_JOBS = 8;

/** Finished jobs are kept this long so the orchestrator can still read them. */
const RETENTION_MS = 60 * 60 * 1000;

/** Recent progress lines retained per job. */
const ACTIVITY_LOG_SIZE = 30;

/**
 * Finished jobs kept at most. Retention alone does not bound memory: a caller
 * can start and finish far more than eight jobs within the hour, and each keeps
 * its whole result.
 */
const MAX_FINISHED_JOBS = 100;

interface Job {
  id: string;
  state: JobState;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  startedAtMs: number;
  finishedAtMs: number | null;
  threadId: string | null;
  commandCount: number;
  activity: string[];
  result: DelegationResult | null;
  error: string | null;
  controller: AbortController;
}

export interface StartJobInput {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  controller: AbortController;
  /** Resolves when the delegation finishes; rejects when it could not run. */
  run: (job: JobHooks) => Promise<DelegationResult>;
}

export interface JobHooks {
  onEvent: (event: CodexEvent, description: string | null) => void;
}

export interface JobRegistryOptions {
  /** How long a finished job stays readable. */
  retentionMs?: number;
  /** Finished jobs kept at most, oldest dropped first. Running jobs never count. */
  maxFinishedJobs?: number;
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly retentionMs: number;
  private readonly maxFinishedJobs: number;

  constructor(options: JobRegistryOptions = {}) {
    this.retentionMs = options.retentionMs ?? RETENTION_MS;
    this.maxFinishedJobs = options.maxFinishedJobs ?? MAX_FINISHED_JOBS;
  }

  get runningCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.state === "running") count += 1;
    }
    return count;
  }

  start(input: StartJobInput): string {
    this.evictExpired();

    if (this.runningCount >= MAX_RUNNING_JOBS) {
      throw new Error(
        `Too many background delegations already running (limit ${MAX_RUNNING_JOBS}). ` +
          "Wait for one to finish or cancel it with codex_job_cancel.",
      );
    }

    const job: Job = {
      id: randomUUID(),
      state: "running",
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      startedAtMs: Date.now(),
      finishedAtMs: null,
      threadId: null,
      commandCount: 0,
      activity: [],
      result: null,
      error: null,
      controller: input.controller,
    };
    this.jobs.set(job.id, job);

    const hooks: JobHooks = {
      onEvent: (event, description) => {
        if (event.type === "thread.started" && event.thread_id) {
          job.threadId = event.thread_id;
        }
        if (
          event.type === "item.completed" &&
          event.item?.type === "command_execution"
        ) {
          job.commandCount += 1;
        }
        if (description) {
          job.activity.push(description);
          if (job.activity.length > ACTIVITY_LOG_SIZE) job.activity.shift();
        }
      },
    };

    void input
      .run(hooks)
      .then((result) => {
        job.result = result;
        job.threadId = result.threadId ?? job.threadId;
        const failure = describeFailure(result);
        job.state = job.controller.signal.aborted ? "cancelled" : failure ? "failed" : "completed";
        if (job.state === "failed") job.error = failure;
      })
      .catch((error: unknown) => {
        // The runner rejects outright when cancellation arrives before it
        // spawns anything. That is still a cancellation, not a failure.
        job.state = job.controller.signal.aborted ? "cancelled" : "failed";
        job.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        job.finishedAtMs = Date.now();
      });

    return job.id;
  }

  snapshot(jobId: string): JobSnapshot {
    this.evictExpired();
    return this.toSnapshot(this.require(jobId));
  }

  private toSnapshot(job: Job): JobSnapshot {
    const snapshot: JobSnapshot = {
      jobId: job.id,
      state: job.state,
      model: job.model,
      reasoningEffort: job.reasoningEffort,
      startedAt: new Date(job.startedAtMs).toISOString(),
      finishedAt: job.finishedAtMs ? new Date(job.finishedAtMs).toISOString() : null,
      durationMs: (job.finishedAtMs ?? Date.now()) - job.startedAtMs,
      threadId: job.threadId,
      commandCount: job.commandCount,
      lastActivity: job.activity.at(-1) ?? "No activity reported yet.",
    };
    if (job.error) snapshot.error = job.error;
    return snapshot;
  }

  activity(jobId: string): string[] {
    this.evictExpired();
    return [...this.require(jobId).activity];
  }

  result(jobId: string): DelegationResult {
    this.evictExpired();
    const job = this.require(jobId);
    if (job.state === "running") {
      throw new Error(
        `Job ${jobId} is still running. Poll codex_job_status before reading the result.`,
      );
    }
    if (!job.result) {
      throw new Error(
        `Job ${jobId} produced no result: ${job.error ?? "unknown error"}`,
      );
    }
    return job.result;
  }

  cancel(jobId: string): JobSnapshot {
    const job = this.require(jobId);
    if (job.state === "running") {
      job.controller.abort();
      job.state = "cancelled";
    }
    return this.snapshot(jobId);
  }

  list(): JobSnapshot[] {
    this.evictExpired();
    // Snapshot the jobs directly rather than through snapshot(), which evicts
    // again and could drop a job this list already decided to include.
    return [...this.jobs.values()].map((job) => this.toSnapshot(job));
  }

  /** Aborts every running job. Called when the server shuts down. */
  cancelAll(): void {
    for (const job of this.jobs.values()) {
      if (job.state === "running") job.controller.abort();
    }
  }

  private require(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(
        `Unknown job id "${jobId}". It may have expired; jobs are kept for one hour after they finish.`,
      );
    }
    return job;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.retentionMs;
    const finished: Job[] = [];
    for (const [id, job] of this.jobs) {
      if (job.finishedAtMs === null) continue;
      if (job.finishedAtMs < cutoff) this.jobs.delete(id);
      else finished.push(job);
    }
    const excess = finished.length - this.maxFinishedJobs;
    if (excess <= 0) return;
    finished.sort((a, b) => (a.finishedAtMs ?? 0) - (b.finishedAtMs ?? 0));
    for (const job of finished.slice(0, excess)) this.jobs.delete(job.id);
  }
}
