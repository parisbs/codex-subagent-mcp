import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Diagnosis } from "./doctor.js";
import type { CancelOptions } from "./runner.js";
import type { ActiveRun } from "../runs.js";
import { descendantGroups, processGroupAlive, signalGroups, signalProcessTree } from "./terminate.js";

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
  return diagnosis.status !== "missing" && diagnosis.status !== "unsupported-shim" && diagnosis.version !== null;
}

/**
 * Classifies a finished run, in this order: stopped before completion; a usable
 * report whatever the exit code; another integer schemaVersion; no usable
 * report, by exit code; and within a usable report, a missing or invalid
 * `config.load` check.
 */
export function classifyDoctorRun(outcome: DoctorRunOutcome): ExtendedDiagnosis {
  if (outcome.stopped) {
    return { kind: "stopped", reason: outcome.stopped, detail: outcome.spawnError ?? null };
  }
  if (outcome.signal) return { kind: "stopped", reason: "signal", detail: outcome.signal };
  let report: unknown;
  try {
    report = JSON.parse(outcome.stdout);
  } catch {
    // Classification below uses the exit code when there is no usable report.
  }
  if (isObject(report)) {
    if (report.schemaVersion === 1 && isObject(report.checks)) {
      if (!Object.hasOwn(report.checks, "config.load")) return { kind: "no-config-load" };
      const summary = summariseConfigLoad(report.checks["config.load"]);
      return summary ? { kind: "summary", exitCode: outcome.exitCode, summary } : { kind: "invalid-config-load" };
    }
    if (typeof report.schemaVersion === "number" && Number.isInteger(report.schemaVersion) && report.schemaVersion !== 1) {
      return { kind: "unsupported-schema", schemaVersion: report.schemaVersion };
    }
  }
  if (outcome.exitCode === 2) {
    return { kind: /unexpected argument '--json'/.test(outcome.stderr) ? "json-unsupported" : "usage-error" };
  }
  return outcome.exitCode !== null && outcome.exitCode !== 0
    ? { kind: "no-report", exitCode: outcome.exitCode }
    : { kind: "unparseable" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const DETAIL_FIELDS = {
  configurationScope: "configuration scope",
  model: "model",
  modelProvider: "model provider",
  featureFlagsEnabled: "feature flags enabled",
  enabledFeatureFlags: "enabled feature flags",
  featureFlagOverrides: "feature flag overrides",
  startupWarningCount: "startup warnings",
  error: "error",
  line: "line",
  column: "column",
} as const;

/**
 * The whitelisted fields of a `config.load` check, or null when the value is not
 * a non-array object whose `id` is `config.load`.
 */
export function summariseConfigLoad(check: unknown): ConfigLoadSummary | null {
  if (!isObject(check) || check.id !== "config.load") return null;
  const status: ConfigLoadStatus = check.status === "ok" || check.status === "warning" || check.status === "fail"
    ? { kind: "known", value: check.status }
    : typeof check.status === "string" ? { kind: "unrecognised", value: check.status } : { kind: "unavailable" };
  const summary: ConfigLoadSummary = { status };
  for (const key of ["summary", "remediation"] as const) {
    if (typeof check[key] === "string") summary[key] = check[key];
  }
  if (!isObject(check.details)) return summary;
  for (const [field, key] of Object.entries(DETAIL_FIELDS)) {
    const value = check.details[key];
    if (typeof value !== "string") continue;
    if ((field === "line" || field === "column") && !/^\d+$/.test(value)) continue;
    summary[field as keyof typeof DETAIL_FIELDS] = value;
  }
  const warnings = check.details["startup warning"];
  if (typeof warnings === "string") summary.startupWarnings = [warnings];
  else if (Array.isArray(warnings) && warnings.every((value) => typeof value === "string")) {
    summary.startupWarnings = warnings;
  }
  const parse = check.details["config.toml parse"];
  if (typeof parse === "string") summary.configTomlParse = parse === "ok" ? "ok" : "error";
  return summary;
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
  const lines = [
    // The directory is the caller's own, shown as the cheap diagnosis shows it. Quoting it as a JSON
    // literal would double every backslash of a Windows path.
    `Codex's own config.load check from codex doctor --json in ${context.directory}; other doctor checks are not summarised.`,
  ];
  switch (diagnosis.kind) {
    case "skipped":
      lines.push(`skipped: ${ {
        "cli-unavailable": "the Codex CLI is unavailable",
        cancelled: "the request was cancelled",
        "shutting-down": "the server is shutting down",
      }[diagnosis.reason]}`);
      break;
    case "stopped":
      lines.push({
        "timed-out": "timed out after 60 s; slow network or MCP probes can cause this.",
        cancelled: "the request was cancelled",
        "stdout-too-large": "stdout was too large to read as a doctor report",
        signal: `stopped by signal ${quote(diagnosis.detail ?? "unknown")}`,
        "spawn-failed": `could not start: ${quote(diagnosis.detail ?? "unknown spawn failure")}`,
      }[diagnosis.reason]);
      break;
    case "unsupported-schema": lines.push(`unsupported schemaVersion ${diagnosis.schemaVersion}`); break;
    case "json-unsupported": lines.push("this CLI does not support doctor --json"); break;
    case "usage-error": lines.push("doctor --json returned a usage error"); break;
    case "no-report": lines.push(`exit code ${diagnosis.exitCode} with no usable report`); break;
    case "unparseable": lines.push("output that could not be read as a doctor report"); break;
    case "no-config-load": lines.push("no config.load check"); break;
    case "invalid-config-load": lines.push("invalid config.load check"); break;
    case "summary": {
      const summary = diagnosis.summary;
      const status = summary.status;
      lines.push(`status: ${status.kind === "unavailable" ? "unavailable" :
        `${status.kind === "unrecognised" ? "unrecognised " : ""}${quote(status.value)}`}`);
      for (const key of ["summary", "remediation"] as const) {
        if (summary[key] !== undefined) lines.push(`${key}: ${quote(summary[key])}`);
      }
      for (const [field, key] of Object.entries(DETAIL_FIELDS)) {
        const value = summary[field as keyof typeof DETAIL_FIELDS];
        if (value !== undefined) lines.push(`${key === "model" ? "configured model" : key}: ${quote(value)}`);
      }
      if (summary.startupWarnings !== undefined) {
        if (summary.startupWarningCount === undefined) lines.push("startup warnings: not reported");
        for (const warning of summary.startupWarnings.slice(0, SUMMARY_WARNING_LIMIT)) {
          lines.push(`startup warning: ${quote(warning)}`);
        }
        if (summary.startupWarnings.length > SUMMARY_WARNING_LIMIT) {
          lines.push(`(${summary.startupWarnings.length - SUMMARY_WARNING_LIMIT} more startup warnings omitted)`);
        }
      }
      if (summary.configTomlParse !== undefined) lines.push(`config.toml parse: ${summary.configTomlParse}`);
      break;
    }
  }
  const section = lines.join("\n");
  const points = [...section];
  const marker = `\n(section cut at ${SECTION_LIMIT} code points)`;
  return points.length <= SECTION_LIMIT ? section : points.slice(0, SECTION_LIMIT - marker.length).join("") + marker;
}

function quote(value: string): string {
  const points = [...value];
  const literal = JSON.stringify(points.slice(0, SUMMARY_STRING_LIMIT).join(""))
    .replace(/[\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return literal + (points.length > SUMMARY_STRING_LIMIT ? ` (${points.length - SUMMARY_STRING_LIMIT} code points omitted)` : "");
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
  const empty: DoctorRunOutcome = { stdout: "", stderr: "", exitCode: null, signal: null, stopped: null };
  const finished = (outcome: DoctorRunOutcome): DoctorReportHandle => ({
    pid: undefined, cancel: () => {}, exited: Promise.resolve(), result: Promise.resolve(outcome),
  });
  if (options.signal?.aborted) return finished({ ...empty, stopped: "cancelled" });

  let child;
  try {
    child = spawn(options.executable, [...DOCTOR_REPORT_ARGS], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: options.cwd ?? process.cwd(),
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (error) {
    return finished({ ...empty, stopped: "spawn-failed", spawnError: error instanceof Error ? error.message : String(error) });
  }

  const startedAt = Date.now();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stopped: DoctorRunStop | null = null;
  let settled = false;
  let closed = false;
  let groups: number[] = [];
  let killDueAt: number | null = null;
  let killTimer: NodeJS.Timeout | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  let resolveResult!: (outcome: DoctorRunOutcome) => void;
  let markExited!: () => void;
  const result = new Promise<DoctorRunOutcome>((resolve) => { resolveResult = resolve; });
  const exited = new Promise<void>((resolve) => { markExited = resolve; });
  const alive = (): boolean => child.exitCode === null && child.signalCode === null;
  const signalTree = (signal: NodeJS.Signals): void =>
    signalProcessTree({ pid: child.pid, alive: alive() }, signal);
  const anythingLeft = (): boolean =>
    processGroupAlive(child.pid) || groups.some((group) => processGroupAlive(group));
  const reportExit = (): void => {
    if (closed && killDueAt === null) {
      clearTimeout(settleTimer);
      markExited();
    }
  };
  const finish = (spawnError?: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    options.signal?.removeEventListener("abort", onAbort);
    resolveResult({
      stdout: decode(stdout, DOCTOR_STDOUT_LIMIT_BYTES),
      stderr: decode(stderr, DOCTOR_STDERR_LIMIT_BYTES),
      exitCode: child.exitCode,
      signal: child.signalCode,
      stopped,
      ...(spawnError === undefined ? {} : { spawnError }),
    });
  };
  const stop = (reason: DoctorRunStop, cancel: CancelOptions = {}): void => {
    if (closed && killDueAt === null) return;
    const dueAt = cancel.killAt ?? Date.now() + (cancel.graceMs ?? options.killGraceMs ?? 5000);
    if (stopped === null) {
      stopped = reason;
      if (alive()) groups = descendantGroups(child.pid, { listProcesses: cancel.processTables?.polite });
      signalTree("SIGINT");
    }
    // A shutdown can shorten a cancellation already in progress, even when
    // the leader has exited. All runs share its forced instant and table read.
    if (killDueAt === null || dueAt < killDueAt) {
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      killDueAt = dueAt;
      killTimer = setTimeout(() => {
        killDueAt = null;
        if (cancel.processTables?.forced !== null && alive()) {
          groups = [...new Set([...groups, ...descendantGroups(child.pid, {
            listProcesses: cancel.processTables?.forced,
          })])];
        }
        signalTree("SIGKILL");
        signalGroups(groups, "SIGKILL");
        reportExit();
      }, Math.max(0, dueAt - Date.now()));
      killTimer.unref?.();
      // A descendant outside the tree must not keep inherited pipes open forever.
      settleTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, Math.max(0, dueAt - Date.now()) + 1000);
      settleTimer.unref?.();
    }
    finish();
  };
  const onAbort = (): void => stop("cancelled");
  const timeoutTimer = setTimeout(() => stop("timed-out"),
    Math.max(0, startedAt + (options.timeoutMs ?? DOCTOR_REPORT_TIMEOUT_MS) - Date.now()));
  timeoutTimer.unref?.();

  child.stdout.on("data", (chunk: Buffer) => {
    if (settled) return;
    const remaining = DOCTOR_STDOUT_LIMIT_BYTES - stdoutBytes;
    stdout.push(chunk.subarray(0, remaining));
    stdoutBytes += Math.min(chunk.length, remaining);
    if (chunk.length > remaining) stop("stdout-too-large");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (settled || stderrBytes === DOCTOR_STDERR_LIMIT_BYTES) return;
    const kept = chunk.subarray(0, DOCTOR_STDERR_LIMIT_BYTES - stderrBytes);
    stderr.push(kept);
    stderrBytes += kept.length;
  });
  child.on("error", (error) => {
    stopped ??= "spawn-failed";
    finish(error.message);
  });
  child.on("close", () => {
    closed = true;
    if (!(stopped !== null && anythingLeft())) {
      clearTimeout(killTimer);
      killDueAt = null;
    }
    finish();
    reportExit();
  });
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  return { pid: child.pid, result, exited, cancel: (cancel) => stop("cancelled", cancel) };
}

/** Discard an incomplete UTF-8 tail, including at a capture boundary. */
function decode(chunks: Buffer[], limit: number): string {
  const text = new StringDecoder("utf8").write(Buffer.concat(chunks));
  return new StringDecoder("utf8").write(Buffer.from(text).subarray(0, limit));
}
