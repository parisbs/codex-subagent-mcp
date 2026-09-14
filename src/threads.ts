import type { ReasoningEffort } from "./types.js";

/** What a thread last ran with, as this server passed it to Codex. */
export interface ThreadSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
  workingDir?: string;
  skipGitRepoCheck: boolean;
}

/** Threads remembered at most; the least recently used is forgotten first. */
const MAX_THREADS = 500;

/**
 * Remembers the settings each thread ran with, so a follow-up can state them again.
 *
 * A resumed session does not keep its model. Verified against codex-cli 0.154.0:
 * `codex exec resume` without `--model` takes the model from the configuration of
 * the directory it is resumed in, reports "This session was recorded with model
 * `X` but is resuming with `Y`", and compacts the thread. An effort left off the
 * argv is likewise taken from configuration, even one the model does not support.
 * So a follow-up has to restate model, effort and directory, and this is where
 * they come from.
 *
 * In memory only: after a restart, or for a thread started elsewhere, there is no
 * record and the caller has to say which model to use. Reading the rollout Codex
 * writes per session would cover that case, and is left to the work on reporting
 * applied settings (#55) so the format is parsed in one place.
 */
export class ThreadRegistry {
  private readonly threads = new Map<string, ThreadSettings>();

  constructor(private readonly maxThreads = MAX_THREADS) {}

  record(threadId: string, settings: ThreadSettings): void {
    // Re-inserting keeps the map in last-used order, so eviction drops the
    // thread nobody has touched for longest.
    this.threads.delete(threadId);
    this.threads.set(threadId, settings);
    while (this.threads.size > this.maxThreads) {
      const oldest = this.threads.keys().next().value;
      if (oldest === undefined) break;
      this.threads.delete(oldest);
    }
  }

  get(threadId: string): ThreadSettings | undefined {
    return this.threads.get(threadId);
  }
}
