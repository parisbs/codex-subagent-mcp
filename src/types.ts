/**
 * Shared types for the codex-subagent MCP server.
 *
 * The vocabulary here mirrors the Codex CLI itself rather than inventing a new
 * one: a delegation is a `codex exec` run, a model is a catalog slug, and a
 * reasoning effort is the value of the `model_reasoning_effort` config key.
 */

/**
 * Every reasoning effort the Codex CLI recognises, ordered from cheapest to
 * most expensive. Which subset a given model accepts is declared per-model in
 * the catalog, so this list is only used for ordering and validation.
 */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Sandbox policies accepted by `codex exec --sandbox`. */
export const SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** A model as this server exposes it, normalised from the raw Codex catalog. */
export interface CodexModel {
  slug: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
  contextWindow: number | null;
  maxContextWindow: number | null;
  priority: number;
  supportsImages: boolean;
  supportsWebSearch: boolean;
}

export interface CodexCatalog {
  models: CodexModel[];
  /** True when the catalog came from a static fallback instead of the CLI. */
  stale: boolean;
  /** Populated when `codex debug models` failed and the fallback was used. */
  warning?: string;
  fetchedAt: string;
}

/** One shell command Codex ran during a delegation. */
export interface ExecutedCommand {
  command: string;
  exitCode: number | null;
  status: string;
  outputPreview: string;
}

/** One file Codex added, edited or deleted during a delegation. */
export interface FileChange {
  path: string;
  kind: string;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/**
 * Whether one setting Codex recorded matches what this server asked for.
 *
 * `unconfirmed` is not a soft `confirmed`: it means nothing was observed, or
 * that what was observed cannot be interpreted.
 */
export type AppliedState = "confirmed" | "differs" | "unconfirmed";

export interface AppliedSetting {
  requested: string | null;
  /** What Codex recorded. Null when it recorded nothing for this field. */
  applied: string | null;
  state: AppliedState;
}

/**
 * What Codex actually applied to a run, read back from its own session file.
 *
 * The command line is not the last word on a delegation: managed requirements
 * can lower a value, a model may not support the effort requested, and a
 * resumed session takes whatever it is not given from configuration. See
 * `src/codex/rollout.ts` and ADR 13.
 */
export interface AppliedSettings {
  /** Where the observation came from; null when nothing could be observed. */
  source: "rollout" | null;
  /** Why nothing could be observed. Null when `source` is set. */
  reason: string | null;
  model: AppliedSetting;
  reasoningEffort: AppliedSetting;
  sandbox: AppliedSetting;
  workingDir: AppliedSetting;
  /** Recorded for the reader; `exec` always records "never". */
  approvalPolicy: string | null;
}

export interface DelegationResult {
  finalMessage: string;
  threadId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  sandbox: SandboxMode;
  /** Effective directory inherited or explicitly passed to the Codex process. */
  workingDir: string;
  /** What Codex recorded as applied, compared against the requested fields. */
  applied: AppliedSettings;
  /** Every completed command observed, including commands omitted from `commands`. */
  commandCount: number;
  commands: ExecutedCommand[];
  fileChanges: FileChange[];
  agentMessages: string[];
  /** In-band errors Codex reported without failing the process. */
  errors: string[];
  /**
   * Error items that report no failure, such as ignored project config keys or a
   * model switch on resume. De-duplicated: Codex emits some of them twice.
   */
  warnings: string[];
  /** Why Codex reported the turn as failed, when it did. */
  turnFailure: string | null;
  /** Tokens for this invocation alone; null when unavailable or a resume baseline is unknown. */
  turnUsage: TokenUsage | null;
  /** Cumulative tokens Codex reported for the thread after this invocation. */
  threadUsage: TokenUsage | null;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
}

export type JobState = "running" | "completed" | "failed" | "cancelled";

export interface JobSnapshot {
  jobId: string;
  state: JobState;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  threadId: string | null;
  commandCount: number;
  lastActivity: string;
  error?: string;
}
