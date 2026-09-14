import type { DelegationResult } from "./types.js";

/**
 * Decides whether a finished delegation failed, and why.
 *
 * Codex signals failure in two independent ways. The obvious one is the process
 * itself: a non-zero exit, or a run killed for exceeding its budget (which
 * leaves `exitCode` null, so the timeout has to be checked on its own). The
 * other is in-band: an `error` item in the event stream while the process still
 * exits 0. Checking only the first reported those runs to the orchestrator as
 * successes.
 *
 * An in-band error counts only when the run also produced no final answer.
 * `errors` is not exclusively fatal: it also carries truncation notices and
 * errors Codex recovered from before answering. A run that reports one of those
 * and still answers did its job, and flagging it would teach the orchestrator to
 * ignore `isError`.
 *
 * Returns null for a successful run. Kept in one place because the blocking
 * tools and the background job registry must never disagree about this.
 */
export function describeFailure(result: DelegationResult): string | null {
  if (result.timedOut) {
    return "The delegation exceeded its timeout and was terminated.";
  }
  if (result.exitCode !== 0) {
    return `Codex exited with code ${result.exitCode}.` + (result.stderr ? ` ${result.stderr}` : "");
  }
  if (result.errors.length > 0 && result.finalMessage.trim().length === 0) {
    return `Codex reported an error and produced no answer: ${result.errors.at(-1)}`;
  }
  return null;
}
