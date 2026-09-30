import type { ActiveRuns } from "./runs.js";

/**
 * How long the host lets this server live once it asks it to stop.
 *
 * Measured on 2026-09-30 against Claude Code 2.1.285: SIGINT, SIGTERM 100 ms
 * later, and SIGKILL 430 to 550 ms after the first signal, with stdin never
 * closed first. Clients built on the MCP SDK's stdio transport allow more (EOF,
 * then SIGTERM after 2 s). Whatever this server has not stopped when it is
 * killed outlives it and keeps spending the user's usage, so the whole sequence
 * fits inside the tightest budget (#40).
 */
export const SHUTDOWN_KILL_MS = 250;
export const SHUTDOWN_DEADLINE_MS = 300;
/**
 * The most a shutdown waits for the process table (#116). Below
 * `SHUTDOWN_KILL_MS`, so a read at its bound cannot delay SIGKILL; above the
 * 130 ms `ps` took on GitHub's macOS runner, so an ordinary read completes.
 */
export const SHUTDOWN_TABLE_TIMEOUT_MS = 200;

export interface ShutdownDeps {
  runs: Pick<ActiveRuns, "stopAll">;
  jobs: { cancelAll: () => void };
  close: () => Promise<void>;
  exit: (code: number) => void;
  log: (message: string) => void;
}

/**
 * Builds the server's shutdown: every Codex process tree gets SIGTERM at once
 * and SIGKILL after `SHUTDOWN_KILL_MS`, and the server exits once they are gone
 * or at `SHUTDOWN_DEADLINE_MS`, whichever comes first. The ordinary five-second
 * cancellation grace does not apply: nobody is left to read the result.
 *
 * The first call wins. A host sends SIGINT and SIGTERM within 100 ms of each
 * other, and the second must neither restart the sequence nor change the code.
 */
export function createShutdown(deps: ShutdownDeps): (code: number) => void {
  let started = false;
  return (code) => {
    if (started) return;
    started = true;
    // Shortens every run's escalation first, so the abort that marks background
    // jobs cancelled cannot arm the longer default grace.
    const stopped = deps.runs.stopAll({
      graceMs: SHUTDOWN_KILL_MS,
      deadlineMs: SHUTDOWN_DEADLINE_MS,
      tableTimeoutMs: SHUTDOWN_TABLE_TIMEOUT_MS,
    });
    deps.jobs.cancelAll();
    void stopped
      .then((unconfirmed) => {
        if (unconfirmed.length > 0) {
          deps.log(
            `codex-subagent: exiting without confirming that these Codex processes stopped: ` +
              `${unconfirmed.join(", ")}`,
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        // Not awaited: closing the transport must not hold the exit past the host's budget.
        void deps.close().catch(() => {});
        deps.exit(code);
      });
  };
}

/** Anything that emits named events, as `process` and `process.stdin` do. */
export interface EventSource {
  on: (event: string, listener: () => void) => unknown;
}

/**
 * Starts the shutdown on SIGINT (130), SIGTERM (143) and the end of stdin (0).
 *
 * The SDK's stdio transport listens only for `data` and `error`, so a host that
 * closes the pipe without a signal used to leave the process running for as
 * long as its delegations did.
 */
export function installShutdownTriggers(
  shutdown: (code: number) => void,
  sources: { process: EventSource; stdin: EventSource },
): void {
  sources.process.on("SIGINT", () => shutdown(130));
  sources.process.on("SIGTERM", () => shutdown(143));
  sources.stdin.on("end", () => shutdown(0));
}
