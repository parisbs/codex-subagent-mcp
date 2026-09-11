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

export function parseUsage(event: CodexEvent): TokenUsage | null {
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

  push(chunk: string): CodexEvent[] {
    this.buffer += chunk;
    const events: CodexEvent[] = [];
    let newlineIndex = this.buffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const event = parseLine(line);
      if (event) events.push(event);
      newlineIndex = this.buffer.indexOf("\n");
    }

    return events;
  }

  /** Flushes whatever is left when the stream ends without a trailing newline. */
  flush(): CodexEvent[] {
    const remaining = this.buffer;
    this.buffer = "";
    const event = parseLine(remaining);
    return event ? [event] : [];
  }
}

function parseLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
      return parsed as CodexEvent;
    }
  } catch {
    // A non-JSON line is informational output, not a failure.
  }
  return null;
}

/** Human-readable one-liner used for MCP progress notifications. */
export function describeEvent(event: CodexEvent): string | null {
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
        return `Codex reported an error: ${truncate(event.item.message ?? "", 200)}`;
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
  if (event.type !== "item.completed") return null;
  if (event.item?.type !== "error") return null;
  const message = event.item.message?.trim();
  return message && message.length > 0 ? message : null;
}
