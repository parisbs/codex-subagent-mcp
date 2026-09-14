import type { DelegationResult } from "./types.js";

/**
 * Decides whether a finished delegation failed, and why.
 *
 * Codex signals failure in several independent ways. The obvious one is the
 * process itself: a non-zero exit, or a run killed for exceeding its budget
 * (which leaves `exitCode` null, so the timeout has to be checked on its own).
 * The others are in-band: a `turn.failed` event, or an `error` item while the
 * process still exits 0. Checking only the exit code reported those runs to the
 * orchestrator as successes — and hid the reason when the exit code was set, as
 * with a usage limit.
 *
 * A `turn.failed` is fatal on its own, whatever the exit code and even after
 * commentary that reads like an answer. An in-band error counts only when the
 * run also produced no final answer: `errors` also carries truncation notices
 * and errors Codex recovered from before answering. A run that reports one of
 * those and still answers did its job, and flagging it would teach the
 * orchestrator to ignore `isError`. A clean exit with no answer at all is a
 * failure too: there is nothing for the caller to use.
 *
 * Returns null for a successful run. Kept in one place because the blocking
 * tools and the background job registry must never disagree about this.
 */
export function describeFailure(result: DelegationResult): string | null {
  if (result.timedOut) {
    return "The delegation exceeded its timeout and was terminated.";
  }
  if (result.turnFailure) {
    const exit = result.exitCode !== 0 && result.exitCode !== null ? ` (exit code ${result.exitCode})` : "";
    return `Codex reported the turn as failed${exit}: ${result.turnFailure}`;
  }
  if (result.exitCode !== 0) {
    return `Codex exited with code ${result.exitCode}.` + (result.stderr ? ` ${result.stderr}` : "");
  }
  const answered = result.finalMessage.trim().length > 0;
  if (result.errors.length > 0 && !answered) {
    return `Codex reported an error and produced no answer: ${result.errors.at(-1)}`;
  }
  if (!answered) {
    return "Codex exited without producing an answer.";
  }
  return null;
}
