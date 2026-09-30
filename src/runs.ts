import type { RunHandle } from "./codex/runner.js";

export interface StopOptions {
  /** Grace between SIGTERM and SIGKILL for every run. */
  graceMs: number;
  /** How long to wait for the runs to stop before giving up on confirming it. */
  deadlineMs: number;
}

/**
 * Every Codex process this server has started and not yet seen stop.
 *
 * Blocking delegations and follow-ups are tracked alongside background jobs:
 * shutdown has to stop all of them, and only background jobs had a registry
 * before (#40). A run leaves when its process has exited, not when its result
 * settles: a timed-out run settles at once and can still be bringing its
 * processes down.
 */
export class ActiveRuns {
  private readonly runs = new Set<RunHandle>();

  track(handle: RunHandle): RunHandle {
    this.runs.add(handle);
    void handle.exited.then(() => this.runs.delete(handle));
    return handle;
  }

  get size(): number {
    return this.runs.size;
  }

  /**
   * Stops every run with the given grace and waits for them, up to the deadline.
   * Resolves with the process ids that could not be confirmed stopped in time.
   */
  async stopAll({ graceMs, deadlineMs }: StopOptions): Promise<number[]> {
    const pending = [...this.runs];
    if (pending.length === 0) return [];

    // The deadline counts from the request, not from after the cancels: on
    // Windows each cancel spawns taskkill, which blocks for tens of
    // milliseconds, and CI measured an exit at 373 ms with two runs when the
    // clock started late.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
    });
    for (const handle of pending) handle.cancel({ graceMs });

    const stopped = new Set<RunHandle>();
    await Promise.race([
      Promise.all(pending.map((handle) => handle.exited.then(() => stopped.add(handle)))),
      deadline,
    ]);
    clearTimeout(timer);

    return pending
      .filter((handle) => !stopped.has(handle))
      .map((handle) => handle.pid)
      .filter((pid): pid is number => pid !== undefined);
  }
}
