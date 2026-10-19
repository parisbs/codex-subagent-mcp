/**
 * Whether the tests that need the real process table can run here (#159).
 *
 * Codex's workspace-write sandbox on macOS refuses to execute `ps`, so the
 * tests whose assertion depends on the table's content fail there for a reason
 * that has nothing to do with the code. Only a refusal to execute counts:
 * any other failure of `ps` means the server would leave descendants running,
 * and the tests must run and show it. CI never skips them.
 */

/** What launching `ps` produced: the spawn error's code, if any, and the exit status. */
export interface ProbeOutcome {
  errorCode?: string;
  status: number | null;
}

export interface GateInput {
  platform: NodeJS.Platform;
  /** Launches `ps`; called only where the table is read with it. */
  probe: () => ProbeOutcome;
  env: NodeJS.ProcessEnv;
}

export type GateDecision =
  | { action: "run" }
  | { action: "skip"; reason: string }
  | { action: "fail"; message: string };

/** Decides from the platform, the outcome of launching `ps` and the environment. */
export function decideProcessTableGate(_input: GateInput): GateDecision {
  throw new Error("not implemented");
}

/** The decision for this process, with the listing the server runs; probed once. */
export function processTableDecision(): GateDecision {
  throw new Error("not implemented");
}
