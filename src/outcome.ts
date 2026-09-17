import { sandboxRank } from "./config.js";
import { SANDBOX_MODES, type DelegationResult, type SandboxMode } from "./types.js";

/**
 * Reports a run Codex recorded as running under a wider sandbox than it was given.
 *
 * This is the one difference between requested and applied settings that is a
 * security finding rather than a surprise: the sandbox is what bounds an
 * untrusted prompt, and by the time it is read back the run is over. The
 * wording says so, because "sandbox mismatch" reads like a configuration note.
 *
 * A value this server does not recognise is reported as unconfirmed elsewhere,
 * not here: an unknown name carries no ordering, and guessing one would be the
 * same mistake in the other direction.
 */
export function describeSandboxBreach(result: DelegationResult): string | null {
  const { requested, applied, state } = result.applied.sandbox;
  if (state !== "differs" || applied === null) return null;

  const isMode = (value: string): value is SandboxMode =>
    (SANDBOX_MODES as readonly string[]).includes(value);
  if (!isMode(applied) || requested === null || !isMode(requested)) return null;
  if (sandboxRank(applied) <= sandboxRank(requested)) return null;

  return (
    `Codex ran under a more permissive sandbox than this server requested: requested ` +
    `"${requested}", applied "${applied}". The run is already over, so any command it ran ` +
    "did so under that sandbox. Check what it changed before acting on its report."
  );
}

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
  const breach = describeSandboxBreach(result);
  if (breach) return breach;
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
