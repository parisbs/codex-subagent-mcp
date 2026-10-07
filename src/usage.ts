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
  mkdir: () => {
    throw new Error("not implemented");
  },
  stat: () => {
    throw new Error("not implemented");
  },
  readdir: () => {
    throw new Error("not implemented");
  },
  readFile: () => {
    throw new Error("not implemented");
  },
  rename: () => {
    throw new Error("not implemented");
  },
  unlink: () => {
    throw new Error("not implemented");
  },
  appendFile: () => {
    throw new Error("not implemented");
  },
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
export function resolveUsageDirectory(_input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
}): { dir: string } | { error: string } {
  throw new Error("not implemented");
}

/** Null when the label is acceptable; otherwise a message naming the rule it broke (ADR 24, point 1). */
export function validateLabel(_label: string): string | null {
  throw new Error("not implemented");
}

/** The outcome to record: the first of cancelled, timeout, failure, success that applies. */
export function usageOutcome(_result: DelegationResult): UsageOutcome {
  throw new Error("not implemented");
}

/**
 * Appends one entry, rotating first when it would take `usage.jsonl` past its cap. Writes within
 * this process are serialised: a call starts only after the previous one finished.
 */
export function appendUsageEntry(
  _dir: string,
  _entry: UsageEntry,
  _options?: UsageWriteOptions,
): Promise<UsageWriteResult> {
  throw new Error("not implemented");
}

/** Resolves once every write already requested in this process has finished. */
export function whenUsageIdle(): Promise<void> {
  // Placeholder that lets the acceptance tests reach their own assertions.
  return Promise.resolve();
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
export function summarizeUsage(
  _dir: string,
  _options: { sinceHours: number; groupBy: UsageGroupBy; now: Date; fs?: UsageFileSystem },
): Promise<UsageSummary> {
  throw new Error("not implemented");
}
