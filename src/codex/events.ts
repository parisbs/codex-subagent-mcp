import type { ExecutedCommand, FileChange, TokenUsage } from "../types.js";

/**
 * The JSONL event stream emitted by `codex exec --json`.
 *
 * Only the fields this server consumes are modelled; unknown event types are
 * ignored rather than treated as errors, so a newer CLI does not break parsing.
 */
export interface CodexEvent {
  type: string;
  thread_id?: string;
  /** Present on top-level `error` events: reconnect progress or a stream failure. */
  message?: string;
  /** Present on `turn.failed`: why Codex gave up on the turn. */
  error?: { message?: string };
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    /** Present on `error` items, e.g. a model mismatch when resuming. */
    message?: string;
    /** Present on `file_change` items: what Codex added, edited or deleted. */
    changes?: { path?: string; kind?: string }[];
    /** Present on `web_search` items; empty until the search has been issued. */
    query?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

/** How much of a command's output is kept in the summary handed back. */
const OUTPUT_PREVIEW_CHARS = 2000;

/** Limit retained partial lines even when the CLI never writes a newline. */
const LINE_LIMIT = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodexEvent(value: unknown): value is CodexEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.thread_id !== undefined && typeof value.thread_id !== "string") return false;
  if (value.message !== undefined && typeof value.message !== "string") return false;
  if (value.error !== undefined) {
    if (!isRecord(value.error)) return false;
    if (value.error.message !== undefined && typeof value.error.message !== "string") return false;
  }
  if (value.item !== undefined) {
    const item = value.item;
    if (!isRecord(item)) return false;
    for (const field of ["id", "type", "text", "command", "aggregated_output", "status", "message", "query"]) {
      if (item[field] !== undefined && typeof item[field] !== "string") return false;
    }
    if (
      item.exit_code !== undefined && item.exit_code !== null &&
      (typeof item.exit_code !== "number" || !Number.isFinite(item.exit_code))
    ) return false;
    if (item.changes !== undefined) {
      if (!Array.isArray(item.changes)) return false;
      for (const change of item.changes) {
        if (!isRecord(change)) return false;
        if (change.path !== undefined && typeof change.path !== "string") return false;
        if (change.kind !== undefined && typeof change.kind !== "string") return false;
      }
    }
  }
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) return false;
    for (const field of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]) {
      const count = value.usage[field];
      if (count !== undefined && (typeof count !== "number" || !Number.isFinite(count))) return false;
    }
  }
  return true;
}

export function parseUsage(event: CodexEvent): TokenUsage | null {
  if (!isCodexEvent(event)) return null;
  const usage = event.usage;
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningOutputTokens: usage.reasoning_output_tokens ?? 0,
  };
}

export function toExecutedCommand(event: CodexEvent): ExecutedCommand | null {
  if (!isCodexEvent(event)) return null;
  const item = event.item;
  if (!item || item.type !== "command_execution" || typeof item.command !== "string") {
    return null;
  }
  const output = item.aggregated_output ?? "";
  return {
    command: item.command,
    exitCode: item.exit_code ?? null,
    status: item.status ?? "unknown",
    outputPreview:
      output.length > OUTPUT_PREVIEW_CHARS
        ? `${output.slice(0, OUTPUT_PREVIEW_CHARS)}\n… [truncated, ${output.length} chars total]`
        : output,
  };
}

/**
 * Extracts the files a completed `file_change` item touched.
 *
 * Without this a write-enabled delegation reports the commands it ran but not
 * the edits it made, which is the part that actually matters to the caller.
 */
export function toFileChanges(event: CodexEvent): FileChange[] {
  if (!isCodexEvent(event)) return [];
  if (event.type !== "item.completed") return [];
  if (event.item?.type !== "file_change") return [];
  return (event.item.changes ?? [])
    .filter((change): change is { path: string; kind?: string } =>
      typeof change.path === "string" && change.path.length > 0,
    )
    .map((change) => ({ path: change.path, kind: change.kind ?? "change" }));
}

/**
 * Incremental JSONL reader.
 *
 * Codex writes one JSON object per line, but chunk boundaries fall anywhere, so
 * partial lines are buffered until a newline arrives. Lines that are not valid
 * JSON (the CLI also prints plain-text notices to stdout in some modes) are
 * skipped.
 */
export class JsonLinesParser {
  private buffer = "";
  private discarding = false;
  private discardedLines = 0;

  get truncatedLines(): number {
    return this.discardedLines;
  }

  push(chunk: string): CodexEvent[] {
    const events: CodexEvent[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newlineIndex = chunk.indexOf("\n", offset);
      const end = newlineIndex === -1 ? chunk.length : newlineIndex;
      if (!this.discarding) {
        if (this.buffer.length + end - offset > LINE_LIMIT) {
          this.buffer = "";
          this.discarding = true;
          this.discardedLines++;
        } else {
          this.buffer += chunk.slice(offset, end);
        }
      }
      if (newlineIndex === -1) break;
      if (!this.discarding) {
        const event = parseLine(this.buffer);
        if (event) events.push(event);
      }
      this.buffer = "";
      this.discarding = false;
      offset = newlineIndex + 1;
    }
    return events;
  }

  /** Flushes whatever is left when the stream ends without a trailing newline. */
  flush(): CodexEvent[] {
    const remaining = this.buffer;
    this.buffer = "";
    this.discarding = false;
    const event = parseLine(remaining);
    return event ? [event] : [];
  }
}

function parseLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isCodexEvent(parsed)) {
      return parsed;
    }
  } catch {
    // A non-JSON line is informational output, not a failure.
  }
  return null;
}

/** Human-readable one-liner used for MCP progress notifications. */
export function describeEvent(event: CodexEvent): string | null {
  if (!isCodexEvent(event)) return null;
  switch (event.type) {
    case "thread.started":
      return `Codex session started (${event.thread_id ?? "unknown thread"})`;
    case "turn.started":
      return "Codex is working…";
    case "item.started":
      if (event.item?.type === "command_execution") {
        return `Running: ${truncate(event.item.command ?? "", 120)}`;
      }
      return null;
    case "item.completed":
      if (event.item?.type === "command_execution") {
        return `Finished (exit ${event.item.exit_code ?? "?"}): ${truncate(event.item.command ?? "", 120)}`;
      }
      if (event.item?.type === "agent_message") {
        return truncate(event.item.text ?? "", 160);
      }
      if (event.item?.type === "error") {
        const message = event.item.message ?? "";
        return isNotice(message)
          ? `Codex notice: ${truncate(message, 200)}`
          : `Codex reported an error: ${truncate(message, 200)}`;
      }
      if (event.item?.type === "web_search" && event.item.query) {
        return `Searched the web: ${truncate(event.item.query, 160)}`;
      }
      if (event.item?.type === "file_change") {
        const changes = toFileChanges(event);
        if (changes.length > 0) {
          return `Changed ${changes.length} file(s): ${changes.map((c) => `${c.kind} ${c.path}`).join(", ")}`;
        }
      }
      return null;
    case "turn.completed":
      return "Codex finished the turn.";
    case "turn.failed":
      return `Codex turn failed: ${truncate(event.error?.message ?? "no reason given", 200)}`;
    case "error":
      if (!event.message) return null;
      return RECONNECT_PATTERN.test(event.message)
        ? `Codex is reconnecting: ${truncate(event.message, 160)}`
        : `Codex reported an error: ${truncate(event.message, 200)}`;
    default:
      return null;
  }
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * Extracts a Codex-reported error item.
 *
 * These are in-band warnings and failures (a model mismatch on resume, a tool
 * failure) that do not change the process exit code, so they have to be
 * surfaced explicitly or they are lost.
 */
export function toErrorMessage(event: CodexEvent): string | null {
  if (!isCodexEvent(event)) return null;
  if (event.type !== "item.completed") return null;
  if (event.item?.type !== "error") return null;
  const message = event.item.message?.trim();
  return message && message.length > 0 ? message : null;
}

/**
 * Error items that do not report a failure.
 *
 * Verified against codex-cli 0.154.0: configuration warnings arrive as
 * `item.completed` items of type `error` — emitted twice, before the turn
 * starts — and so do a model switch on resume and a transport fallback. Listing
 * them as errors buried real failures among warnings about a project's
 * `.codex/config.toml`. Only known shapes are downgraded: anything unrecognised
 * stays an error, so a new failure is never hidden by this list.
 */
const NOTICE_PATTERNS: readonly RegExp[] = [
  /^Ignored unsupported project-local config keys\b/,
  /^This session was recorded with model\b/,
  /\boverridden by requirements\b/,
  /^Falling back from WebSockets to HTTPS transport\b/,
];

export function isNotice(message: string): boolean {
  return NOTICE_PATTERNS.some((pattern) => pattern.test(message));
}

/** Top-level progress while the CLI retries its connection: "Reconnecting... 2/5 (...)". */
const RECONNECT_PATTERN = /^Reconnecting\.\.\. \d+\/\d+/;

/**
 * Extracts a top-level `error` event that is not reconnect progress.
 *
 * These carry failures the process exit code does not explain on its own — a
 * usage limit, an authentication failure — and were previously ignored.
 * Reconnect notices are left out: they describe a retry, and if the retries run
 * out the turn fails with its own reason.
 */
export function toStreamError(event: CodexEvent): string | null {
  if (!isCodexEvent(event)) return null;
  if (event.type !== "error") return null;
  const message = event.message?.trim();
  if (!message || RECONNECT_PATTERN.test(message)) return null;
  return message;
}

/**
 * Extracts why Codex gave up on a turn.
 *
 * A `turn.failed` is fatal even when the process exits 0 or earlier commentary
 * reads like an answer, so it is kept apart from the recoverable errors.
 */
export function toTurnFailure(event: CodexEvent): string | null {
  if (!isCodexEvent(event)) return null;
  if (event.type !== "turn.failed") return null;
  const message = event.error?.message?.trim();
  return message && message.length > 0 ? message : "Codex reported the turn as failed without a reason.";
}
