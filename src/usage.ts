import * as fs from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { describeFailure } from "./outcome.js";
import type { DelegationResult } from "./types.js";

/**
 * The opt-in local usage log (ADR 22, ADR 24, #29).
 *
 * One JSON line per delegation process, appended to `usage.jsonl` in the user's state directory,
 * rotated to uniquely named archives, and read back by `codex_usage`. Nothing here talks to the
 * Codex CLI.
 */

export const USAGE_SCHEMA_VERSION = 1;

/** The outcome as this server reports it, in the log's precedence order. */
export type UsageOutcome = "success" | "failure" | "timeout" | "cancelled";

export type UsageKind = "delegation" | "follow-up";

export type UsageMode = "blocking" | "background";

/** What `codex_usage` can group by; `model` is the applied model and effort together. */
export type UsageGroupBy = "model" | "label" | "outcome" | "kind";

/** One turn's tokens; `uncached` is input minus cached. */
export interface UsageTokens {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  uncached: number;
}

/** One line of the log, schema version 1. */
export interface UsageEntry {
  schema: 1;
  /** ISO 8601 in UTC. */
  ended_at: string;
  duration_ms: number;
  kind: UsageKind;
  mode: UsageMode;
  thread_id: string | null;
  label: string | null;
  /** As passed to the CLI, after defaults and clamping. */
  requested: { model: string; effort: string; sandbox: string };
  /** As Codex applied them, each the literal "unconfirmed" when not confirmed. */
  applied: { model: string; effort: string; sandbox: string };
  flags: { use_worktree: boolean; target_files: boolean; acceptance_criteria: boolean; output_schema: boolean };
  commands: number;
  tokens: UsageTokens | null;
  outcome: UsageOutcome;
  sandbox_ceiling: string;
  server_version: string;
  cli_version: string | null;
}

/** The file operations the log uses, injectable so that tests can make any one of them fail. */
export interface UsageFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  appendFile(path: string, data: string, options: { mode: number }): Promise<void>;
}

/** The real file system, through `node:fs/promises`. */
export const nodeUsageFileSystem: UsageFileSystem = {
  mkdir: async (path, options) => { await fs.mkdir(path, options); },
  stat: (path) => fs.stat(path),
  readdir: (path) => fs.readdir(path),
  readFile: (path) => fs.readFile(path, "utf8"),
  rename: (from, to) => fs.rename(from, to),
  unlink: (path) => fs.unlink(path),
  appendFile: (path, data, options) => fs.appendFile(path, data, options),
};

export interface UsageWriteOptions {
  fs?: UsageFileSystem;
  /** The time used in an archive's name. */
  now?: () => Date;
  /** The process id used in an archive's name. */
  pid?: number;
  /** The current file's cap, 10 MiB unless a test lowers it. */
  maxBytes?: number;
  /** The archives' total cap, 50 MiB unless a test lowers it. */
  maxArchiveBytes?: number;
}

export interface UsageWriteResult {
  written: boolean;
  /** Why the entry was not written; null when it was. */
  error: string | null;
  /** Why old archives could not be deleted; null when nothing failed. */
  pruneError: string | null;
}

/** Where the log lives, or why it cannot be written on this machine (ADR 22, point 3). */
export function resolveUsageDirectory(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
}): { dir: string } | { error: string } {
  const path = input.platform === "win32" ? win32 : posix;
  const xdg = input.env.XDG_STATE_HOME;
  if (xdg && path.isAbsolute(xdg)) return { dir: path.join(xdg, "codex-subagent-mcp") };
  if (input.platform === "win32") {
    const local = input.env.LOCALAPPDATA;
    return local && path.isAbsolute(local)
      ? { dir: path.join(local, "codex-subagent-mcp") }
      : { error: "Neither XDG_STATE_HOME nor LOCALAPPDATA is an absolute path." };
  }
  return { dir: path.join(input.homedir, ...(
    input.platform === "darwin" ? ["Library", "Application Support"] : [".local", "state"]
  ), "codex-subagent-mcp") };
}

/** Null when the label is acceptable; otherwise the rule it broke. */
export function validateLabel(label: string): string | null {
  if (/\p{Cs}/u.test(label)) return "label must be well-formed Unicode, without unpaired surrogates.";
  if ([...label].length < 1 || [...label].length > 64) return "label must contain 1 to 64 Unicode code points.";
  if (/\p{Cc}/u.test(label)) return "label must not contain control characters (category Cc).";
  if (/\p{Bidi_Control}/u.test(label)) return "label must not contain bidirectional-control characters (Bidi_Control).";
  return null;
}

export function usageOutcome(result: DelegationResult): UsageOutcome {
  if (result.cancelled) return "cancelled";
  if (result.timedOut) return "timeout";
  return describeFailure(result) ? "failure" : "success";
}

const archivePattern = /^usage-(\d{8}T\d{9}Z)-(\d+)\.jsonl$/;
const missing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
let writes: Promise<void> = Promise.resolve();

/** Serialise writes, including rotation, across every registration in this process. */
export function appendUsageEntry(
  dir: string,
  entry: UsageEntry,
  options: UsageWriteOptions = {},
): Promise<UsageWriteResult> {
  const pending = writes.then(async (): Promise<UsageWriteResult> => {
    const fs = options.fs ?? nodeUsageFileSystem;
    let pruneError: string | null = null;
    try {
      const data = `${JSON.stringify(entry)}\n`;
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const current = join(dir, "usage.jsonl");
      let size = 0;
      try { size = (await fs.stat(current)).size; } catch (error) { if (!missing(error)) throw error; }
      if (size > 0 && size + Buffer.byteLength(data) > (options.maxBytes ?? 10 * 1024 * 1024)) {
        let time = (options.now?.() ?? new Date()).getTime();
        let archive: string;
        // Pids separate concurrent processes; checking also preserves archives from a reused pid.
        for (;;) {
          const timestamp = new Date(time++).toISOString().replace(/[-:.]/g, "");
          archive = join(dir, `usage-${timestamp}-${options.pid ?? process.pid}.jsonl`);
          try { await fs.stat(archive); } catch (error) { if (missing(error)) break; throw error; }
        }
        try { await fs.rename(current, archive); } catch (error) {
          // Another writer may already have rotated the current file.
          if (!missing(error)) throw error;
        }
        try {
          const archives = (await fs.readdir(dir)).filter((name) => archivePattern.test(name)).sort();
          const sizes: { name: string; size: number }[] = [];
          for (const name of archives) {
            try { sizes.push({ name, size: (await fs.stat(join(dir, name))).size }); }
            catch (error) { if (!missing(error)) throw error; }
          }
          let total = sizes.reduce((sum, file) => sum + file.size, 0);
          for (const file of sizes) {
            if (total <= (options.maxArchiveBytes ?? 50 * 1024 * 1024)) break;
            try { await fs.unlink(join(dir, file.name)); } catch (error) { if (!missing(error)) throw error; }
            total -= file.size;
          }
        } catch (error) { pruneError = message(error); }
      }
      await fs.appendFile(current, data, { mode: 0o600 });
      return { written: true, error: null, pruneError };
    } catch (error) {
      return { written: false, error: message(error), pruneError };
    }
  });
  writes = pending.then(() => {});
  return pending;
}

/** Resolves once every write already requested in this process has finished. */
export function whenUsageIdle(): Promise<void> {
  return writes;
}

export type UsageGroupKey =
  | { model: string; effort: string }
  | { label: string | null }
  | { outcome: UsageOutcome }
  | { kind: UsageKind };

export interface UsageGroup {
  key: UsageGroupKey;
  count: number;
  outcomes: Record<UsageOutcome, number>;
  commands: number;
  totalDurationMs: number;
  /** The middle value, or the mean of the two middle values for an even count. */
  medianDurationMs: number;
  knownTokens: number;
  unknownTokens: number;
  /** Sums over the entries with known tokens; null when none had them. */
  tokens: UsageTokens | null;
}

export interface UsageSummary {
  groups: UsageGroup[];
  /** Entries inside the window. */
  entries: number;
  /** Lines skipped in every file, whatever the window and the grouping. */
  skipped: number;
  /** Names of files that exist but could not be read. */
  unreadable: string[];
  /** `usage.jsonl` and archives found. */
  filesFound: number;
  /** End time of the oldest valid entry in any file, whatever the window. */
  oldest: string | null;
}

/** Reads `usage.jsonl` and every archive and summarises the entries inside the window. */
export async function summarizeUsage(
  dir: string,
  options: { sinceHours: number; groupBy: UsageGroupBy; now: Date; fs?: UsageFileSystem },
): Promise<UsageSummary> {
  if (!Number.isFinite(options.sinceHours) || options.sinceHours <= 0 || options.sinceHours > 8760) {
    throw new Error("since_hours must be finite, greater than 0 and at most 8,760.");
  }
  const fs = options.fs ?? nodeUsageFileSystem;
  const summary: UsageSummary = { groups: [], entries: 0, skipped: 0, unreadable: [], filesFound: 0, oldest: null };
  let files: string[];
  try { files = await fs.readdir(dir); } catch (error) { if (missing(error)) return summary; throw error; }
  const groups = new Map<string, { group: UsageGroup; durations: number[] }>();
  const cutoff = options.now.getTime() - options.sinceHours * 3600000;
  for (const file of files.filter((name) => name === "usage.jsonl" || archivePattern.test(name)).sort()) {
    let data: string;
    try { data = await fs.readFile(join(dir, file)); } catch (error) {
      if (!missing(error)) { summary.filesFound++; summary.unreadable.push(file); }
      continue;
    }
    summary.filesFound++;
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { summary.skipped++; continue; }
      if (!isSummaryEntry(value)) { summary.skipped++; continue; }
      const ended = Date.parse(value.ended_at);
      if (summary.oldest === null || ended < Date.parse(summary.oldest)) summary.oldest = value.ended_at;
      if (ended < cutoff) continue;
      summary.entries++;
      const key: UsageGroupKey = options.groupBy === "model"
        ? { model: value.applied.model, effort: value.applied.effort }
        : options.groupBy === "label" ? { label: value.label }
        : options.groupBy === "outcome" ? { outcome: value.outcome } : { kind: value.kind };
      const encoded = JSON.stringify(key);
      let bucket = groups.get(encoded);
      if (!bucket) {
        bucket = { group: { key, count: 0, outcomes: { success: 0, failure: 0, timeout: 0, cancelled: 0 },
          commands: 0, totalDurationMs: 0, medianDurationMs: 0, knownTokens: 0, unknownTokens: 0, tokens: null }, durations: [] };
        groups.set(encoded, bucket);
      }
      const group = bucket.group;
      group.count++;
      group.outcomes[value.outcome]++;
      group.commands += value.commands;
      group.totalDurationMs += value.duration_ms;
      bucket.durations.push(value.duration_ms);
      if (value.tokens === null) group.unknownTokens++;
      else {
        group.knownTokens++;
        group.tokens ??= { input: 0, cached: 0, output: 0, reasoning: 0, uncached: 0 };
        for (const field of ["input", "cached", "output", "reasoning"] as const) group.tokens[field] += value.tokens[field];
        group.tokens.uncached += value.tokens.input - value.tokens.cached;
      }
    }
  }
  for (const { group, durations } of groups.values()) {
    durations.sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    group.medianDurationMs = durations.length % 2 ? durations[middle]! : (durations[middle - 1]! + durations[middle]!) / 2;
    summary.groups.push(group);
  }
  return summary;
}

type SummaryEntry = Pick<UsageEntry, "ended_at" | "duration_ms" | "kind" | "outcome" | "commands" | "label"> & {
  applied: { model: string; effort: string };
  tokens: Omit<UsageTokens, "uncached"> | null;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Check the fixed set of reader fields, independent of the grouping requested. */
function isSummaryEntry(value: unknown): value is SummaryEntry {
  if (!record(value) || value.schema !== USAGE_SCHEMA_VERSION) return false;
  if (typeof value.ended_at !== "string" || !Number.isFinite(Date.parse(value.ended_at))) return false;
  if (typeof value.duration_ms !== "number" || !Number.isFinite(value.duration_ms) || value.duration_ms < 0) return false;
  if (value.kind !== "delegation" && value.kind !== "follow-up") return false;
  if (!["success", "failure", "timeout", "cancelled"].includes(value.outcome as string)) return false;
  if (!count(value.commands) || (value.label !== null && typeof value.label !== "string")) return false;
  if (!record(value.applied) || typeof value.applied.model !== "string" || typeof value.applied.effort !== "string") return false;
  const tokens = value.tokens;
  return tokens === null || (record(tokens) && [tokens.input, tokens.cached, tokens.output, tokens.reasoning].every(count));
}
