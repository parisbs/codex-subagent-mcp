import type { Diagnosis } from "./doctor.js";
import type { CancelOptions } from "./runner.js";
import type { ActiveRun } from "../runs.js";

/**
 * The extended diagnosis: `codex doctor --json`, run only when `codex_doctor` is
 * called with `extended: true` (#69). It is slow and reaches the network, so it
 * never runs from the preflight, at startup, or on its own.
 *
 * Only the `config.load` check is summarised, and only from a whitelist: the
 * report is an internal CLI format whose details change within schemaVersion 1.
 */

/** The argv after the executable. `scripts/check-codex-compat.ts` checks it against every release. */
export const DOCTOR_REPORT_ARGS: readonly string[] = ["doctor", "--json"];

/** Counted from spawn. A policy cap: the CLI's own runtime grows with its configuration. */
export const DOCTOR_REPORT_TIMEOUT_MS = 60_000;

/** Beyond this the run is stopped and reported as too large; a truncated report is never parsed. */
export const DOCTOR_STDOUT_LIMIT_BYTES = 1024 * 1024;

/** stderr is drained in full but only this much is kept. */
export const DOCTOR_STDERR_LIMIT_BYTES = 64 * 1024;

/** Each string shown from the report is cut at this many code points. */
export const SUMMARY_STRING_LIMIT = 2_000;

/** At most this many startup warning texts are shown. */
export const SUMMARY_WARNING_LIMIT = 10;

/** The whole extended section stays within this many code points. */
export const SECTION_LIMIT = 16 * 1024;

/** Why a run ended before the process finished on its own. */
export type DoctorRunStop = "cancelled" | "timed-out" | "spawn-failed" | "stdout-too-large";

/** What one `codex doctor --json` process left behind. */
export interface DoctorRunOutcome {
  /** At most `DOCTOR_STDOUT_LIMIT_BYTES`, decoded as UTF-8. */
  stdout: string;
  /** At most `DOCTOR_STDERR_LIMIT_BYTES`, decoded as UTF-8. */
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Null when the process exited on its own, whatever its exit code. */
  stopped: DoctorRunStop | null;
  /** The spawn error's message, when `stopped` is `spawn-failed`. */
  spawnError?: string;
}

export type ConfigLoadStatus =
  | { kind: "known"; value: "ok" | "warning" | "fail" }
  /** A string that is none of the three; never read as healthy. */
  | { kind: "unrecognised"; value: string }
  /** Absent, or not a string. */
  | { kind: "unavailable" };

/**
 * The whitelisted part of `checks["config.load"]`. A field is present only when
 * the report carried it with the expected type: a string, or for
 * `startupWarnings` a string or an array of strings. `line` and `column` are
 * kept only as decimal strings. Values are as reported, before any display cut.
 */
export interface ConfigLoadSummary {
  status: ConfigLoadStatus;
  summary?: string;
  remediation?: string;
  configurationScope?: string;
  model?: string;
  modelProvider?: string;
  featureFlagsEnabled?: string;
  enabledFeatureFlags?: string;
  featureFlagOverrides?: string;
  /** The CLI's own `startup warnings` count, as reported. */
  startupWarningCount?: string;
  /** `startup warning`, a single string normalised to a one-element list. */
  startupWarnings?: string[];
  error?: string;
  line?: string;
  column?: string;
  /** `ok` only for exactly "ok"; any other string is `error`, and its message is dropped. */
  configTomlParse?: "ok" | "error";
}

/** The outcome of the extended diagnosis, as `codex_doctor` reports it. */
export type ExtendedDiagnosis =
  | { kind: "skipped"; reason: "cli-unavailable" | "cancelled" | "shutting-down" }
  | { kind: "stopped"; reason: DoctorRunStop | "signal"; detail: string | null }
  | { kind: "unsupported-schema"; schemaVersion: number }
  /** Exit 2 naming `--json` as an unexpected argument, with no usable report. */
  | { kind: "json-unsupported" }
  /** Any other exit 2 with no usable report. */
  | { kind: "usage-error" }
  /** Any other non-zero exit with no usable report. */
  | { kind: "no-report"; exitCode: number }
  /** Exit 0 with output that is not a usable report. */
  | { kind: "unparseable" }
  | { kind: "no-config-load" }
  | { kind: "invalid-config-load" }
  | { kind: "summary"; exitCode: number | null; summary: ConfigLoadSummary };

/**
 * Whether the cheap diagnosis allows the extended run: an executable was
 * resolved and its version parsed. Every status but `missing` and
 * `unsupported-shim` qualifies, including the failing ones.
 */
export function canRunDoctorReport(diagnosis: Diagnosis): boolean {
  void diagnosis;
  throw new Error("not implemented");
}

/**
 * Classifies a finished run, in this order: stopped before completion; a usable
 * report whatever the exit code; another integer schemaVersion; no usable
 * report, by exit code; and within a usable report, a missing or invalid
 * `config.load` check.
 */
export function classifyDoctorRun(outcome: DoctorRunOutcome): ExtendedDiagnosis {
  void outcome;
  throw new Error("not implemented");
}

/**
 * The whitelisted fields of a `config.load` check, or null when the value is not
 * a non-array object whose `id` is `config.load`.
 */
export function summariseConfigLoad(check: unknown): ConfigLoadSummary | null {
  void check;
  throw new Error("not implemented");
}

export interface ExtendedDiagnosisContext {
  /** The directory the subcommand ran in, named in the section's header. */
  directory: string;
}

/**
 * The extended section as shown to the caller, the second text item of the
 * result. The header names the directory and says it is Codex's own
 * `config.load` check, with the other doctor checks not summarised. Each field
 * is a `label: value` line, labelled by the report's own key except `model`,
 * shown as `configured model`. Codex strings are JSON string literals, with
 * C1 controls, U+2028, U+2029 and bidirectional controls also escaped; each is
 * cut at `SUMMARY_STRING_LIMIT` code points and followed by
 * `(N code points omitted)`; warnings beyond `SUMMARY_WARNING_LIMIT` are
 * reported as `(N more startup warnings omitted)`; and a section that would
 * exceed `SECTION_LIMIT` ends with `(section cut at 16384 code points)`.
 */
export function formatExtendedDiagnosis(diagnosis: ExtendedDiagnosis, context: ExtendedDiagnosisContext): string {
  void diagnosis;
  void context;
  throw new Error("not implemented");
}

export interface DoctorReportOptions {
  /** What `executableFor(diagnosis)` returned. */
  executable: string;
  /** Defaults to this process's own. */
  cwd?: string;
  /** Cancels the run: before spawn nothing starts, after spawn the process tree is stopped. */
  signal?: AbortSignal;
  /** Defaults to `DOCTOR_REPORT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Grace between the polite stop and the forced one. */
  killGraceMs?: number;
}

/** An `ActiveRun`, so that shutdown stops it with the delegations. */
export interface DoctorReportHandle extends ActiveRun {
  /** Never rejects: every failure is an outcome. */
  result: Promise<DoctorRunOutcome>;
  /** Honours `killAt` and `processTables` as a delegation's cancel does. */
  cancel: (options?: CancelOptions) => void;
  /** Undefined when no process was started. */
  pid: number | undefined;
  /** Resolves once the process tree has been brought down and the pipes have closed. */
  exited: Promise<void>;
}

/**
 * Spawns `executable doctor --json` with `shell: false` and stdin ignored, as
 * the leader of its own process group on POSIX, and terminates the process tree
 * on the deadline, on cancellation, or when stdout exceeds its limit.
 */
export function runDoctorReport(options: DoctorReportOptions): DoctorReportHandle {
  void options;
  throw new Error("not implemented");
}
