import type { RunHandle } from "./codex/runner.js";

export interface StopOptions {
  /** Grace between SIGTERM and SIGKILL for every run. */
  graceMs: number;
  /** How long to wait for the runs to stop before giving up on confirming it. */
  deadlineMs: number;
}

export class ActiveRuns {
  track(handle: RunHandle): RunHandle {
    return handle;
  }

  get size(): number {
    return 0;
  }

  async stopAll(_options: StopOptions): Promise<number[]> {
    throw new Error("not implemented");
  }
}
