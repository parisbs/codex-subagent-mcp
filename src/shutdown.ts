import type { ActiveRuns } from "./runs.js";

export interface ShutdownDeps {
  runs: Pick<ActiveRuns, "stopAll">;
  jobs: { cancelAll: () => void };
  close: () => Promise<void>;
  exit: (code: number) => void;
  log: (message: string) => void;
}

export function createShutdown(_deps: ShutdownDeps): (code: number) => void {
  throw new Error("not implemented");
}

/** Anything that emits named events, as `process` and `process.stdin` do. */
export interface EventSource {
  on: (event: string, listener: () => void) => unknown;
}

export function installShutdownTriggers(
  _shutdown: (code: number) => void,
  _sources: { process: EventSource; stdin: EventSource },
): void {
  throw new Error("not implemented");
}
