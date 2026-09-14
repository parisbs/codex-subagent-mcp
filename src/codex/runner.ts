import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  DelegationResult,
  ExecutedCommand,
  FileChange,
  TokenUsage,
} from "../types.js";
import { buildCodexArgs, type CodexInvocation } from "./args.js";
import { resolveCodexExecutable } from "./resolve.js";
import {
  JsonLinesParser,
  describeEvent,
  isNotice,
  parseUsage,
  toErrorMessage,
  toExecutedCommand,
  toFileChanges,
  toStreamError,
  toTurnFailure,
  type CodexEvent,
} from "./events.js";

/** Default wall-clock budget for a delegation. Deliberately generous: a
 * high-effort Codex run on a real repository can take many minutes. */
export const DEFAULT_TIMEOUT_SECONDS = 1800;

/** Grace period between SIGTERM and SIGKILL when a run is cut short. */
const KILL_GRACE_MS = 5000;

/** Cap on retained stderr so a noisy run cannot grow unbounded. */
const STDERR_LIMIT = 64 * 1024;

/**
 * Caps on retained agent messages. Unlike stderr, this output is what the
 * caller actually reads, so the newest messages are kept and the oldest
 * dropped — a run that talks forever must not take the server's memory with it.
 */
const MESSAGE_CHARS_LIMIT = 1024 * 1024;
const MESSAGE_COUNT_LIMIT = 1000;

/**
 * Caps on the other per-run lists, which grow with every tool call a long run
 * makes. Commands keep the newest, like messages, because the latest state of a
 * run is what the caller acts on. File changes keep the first distinct entries:
 * they are a set of touched files, not a timeline. Whatever is dropped is
 * counted and reported, never silently lost.
 */
const COMMAND_COUNT_LIMIT = 500;
const ERROR_DISTINCT_LIMIT = 100;
const ERROR_CHARS_LIMIT = 2000;
const FILE_CHANGE_LIMIT = 1000;

export interface RunOptions {
  invocation: CodexInvocation;
  /** Full prompt; written to the child's stdin, never placed on the argv. */
  prompt: string;
  timeoutSeconds?: number;
  codexPath?: string;
  /** Called for every parsed event, for progress reporting. */
  onEvent?: (event: CodexEvent, description: string | null) => void;
  /** Aborts the run; used by background job cancellation. */
  signal?: AbortSignal;
}

export interface RunHandle {
  result: Promise<DelegationResult>;
  cancel: () => void;
}

/**
 * Runs the Codex CLI and streams its JSONL output into a structured result.
 *
 * The child is spawned with an argv array and `shell: false`, so nothing in the
 * prompt or in any caller-supplied path is ever interpreted by a shell.
 */
export function runCodex(options: RunOptions): RunHandle {
  const {
    invocation,
    prompt,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    codexPath = process.env.CODEX_BIN ?? "codex",
    onEvent,
    signal,
  } = options;

  if (signal?.aborted) {
    return {
      cancel: () => {},
      result: Promise.reject(new Error("Codex delegation was cancelled before it started.")),
    };
  }

  const args = buildCodexArgs(invocation);
  const startedAt = Date.now();

  // Windows `spawn` does not apply PATHEXT, so resolve the executable rather
  // than relying on the platform to guess. See `src/codex/resolve.ts`.
  const resolved = resolveCodexExecutable(codexPath);
  const target = resolved.path ?? codexPath;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(target, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: invocation.workingDir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      cancel: () => {},
      result: Promise.reject(
        new Error(`Could not start the Codex CLI ("${codexPath}"): ${message}`),
      ),
    };
  }

  const parser = new JsonLinesParser();
  const agentMessages: string[] = [];
  const commands: ExecutedCommand[] = [];
  let omittedCommands = 0;
  // Keyed by message, so an error Codex repeats is one entry with a count.
  // Re-inserting on every occurrence keeps the map in last-seen order: the
  // newest error stays last, and the failure summary quotes the last one.
  const errorCounts = new Map<string, number>();
  let omittedErrors = 0;
  // Keyed by kind and path, so a file edited many times is listed once.
  const fileChanges = new Map<string, FileChange>();
  let omittedFileChanges = 0;
  let messageChars = 0;
  let messagesTruncated = false;
  let streamErrorReported = false;
  // Assigned when the result promise is constructed below, which happens before
  // anything can call it: the timeout and the abort listener both fire on later
  // ticks. Keep that ordering if this function is ever rearranged.
  let finish: (code: number | null) => void;
  let threadId: string | null = null;
  let usage: TokenUsage | null = null;
  let stderr = "";
  let timedOut = false;
  let terminating = false;
  let settled = false;
  let killTimer: NodeJS.Timeout | undefined;

  // Notices repeat verbatim (Codex prints configuration warnings twice), so a
  // set is enough; they share the error cap because they come from the same
  // stream and are just as unbounded.
  const warnings = new Set<string>();
  let turnFailure: string | null = null;

  const bound = (raw: string): string =>
    raw.length > ERROR_CHARS_LIMIT ? `${raw.slice(0, ERROR_CHARS_LIMIT)}… [truncated]` : raw;

  const addWarning = (raw: string): void => {
    if (warnings.size < ERROR_DISTINCT_LIMIT) warnings.add(bound(raw));
  };

  const addError = (raw: string): void => {
    const message = bound(raw);
    const count = errorCounts.get(message);
    if (count !== undefined) {
      errorCounts.delete(message);
      errorCounts.set(message, count + 1);
      return;
    }
    if (errorCounts.size >= ERROR_DISTINCT_LIMIT) {
      const oldest = errorCounts.keys().next().value;
      if (oldest !== undefined) errorCounts.delete(oldest);
      omittedErrors += 1;
    }
    errorCounts.set(message, 1);
  };

  const reportStreamError = (error: unknown): void => {
    if (streamErrorReported) return;
    streamErrorReported = true;
    const message = error instanceof Error ? error.message : String(error);
    addError(`Could not interpret Codex output: ${message}`);
  };

  const handleEvents = (events: CodexEvent[]): void => {
    for (const event of events) {
      try {
        if (event.type === "thread.started" && event.thread_id) {
          threadId = event.thread_id;
        }
        if (event.type === "item.completed") {
          const item = event.item;
          if (item?.type === "agent_message" && typeof item.text === "string") {
            const text = item.text.slice(0, MESSAGE_CHARS_LIMIT);
            if (text.length < item.text.length) messagesTruncated = true;
            agentMessages.push(text);
            messageChars += text.length;
            while (messageChars > MESSAGE_CHARS_LIMIT || agentMessages.length > MESSAGE_COUNT_LIMIT) {
              messageChars -= agentMessages.shift()!.length;
              messagesTruncated = true;
            }
          }
          const executed = toExecutedCommand(event);
          if (executed) {
            commands.push(executed);
            if (commands.length > COMMAND_COUNT_LIMIT) {
              commands.shift();
              omittedCommands += 1;
            }
          }
          const reported = toErrorMessage(event);
          if (reported) {
            if (isNotice(reported)) addWarning(reported);
            else addError(reported);
          }
          for (const change of toFileChanges(event)) {
            const key = `${change.kind}\0${change.path}`;
            if (fileChanges.has(key)) continue;
            if (fileChanges.size >= FILE_CHANGE_LIMIT) {
              omittedFileChanges += 1;
              continue;
            }
            fileChanges.set(key, change);
          }
        }
        if (event.type === "turn.completed") {
          usage = parseUsage(event) ?? usage;
        }
        const streamError = toStreamError(event);
        if (streamError) addError(streamError);
        const failure = toTurnFailure(event);
        if (failure) {
          turnFailure = bound(failure);
          // Codex announces a fatal error as an `error` event and then fails the
          // turn with the same text; listing it twice would read as two problems.
          errorCounts.delete(turnFailure);
        }
        onEvent?.(event, describeEvent(event));
      } catch (error) {
        reportStreamError(error);
      }
    }
  };

  const terminate = (markTimeout: boolean): void => {
    if (settled) return;
    if (markTimeout) timedOut = true;
    // Both the timeout and an abort can fire before the child actually exits.
    // Only the first termination request should arm an escalation timer.
    if (!terminating && child.exitCode === null && child.signalCode === null) {
      terminating = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    }
    if (markTimeout) {
      // An exited child can leave descendants holding its pipes open, so close
      // is not a reliable deadline. Stop retaining output and settle now.
      finish(child.exitCode);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  };

  const timeoutTimer = setTimeout(() => terminate(true), timeoutSeconds * 1000);
  timeoutTimer.unref?.();

  const onAbort = (): void => terminate(false);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (settled) return;
    try {
      handleEvents(parser.push(chunk));
    } catch (error) {
      reportStreamError(error);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (!settled && stderr.length < STDERR_LIMIT) {
      stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
    }
  });

  // The CLI reads instructions from stdin when no positional prompt is given.
  child.stdin.on("error", () => {
    // Ignore EPIPE: the child may exit before the prompt is fully written.
  });
  child.stdin.end(prompt, "utf8");

  const result = new Promise<DelegationResult>((resolve, reject) => {
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (killTimer) clearTimeout(killTimer);
      reject(
        new Error(
          `Could not run the Codex CLI ("${codexPath}"): ${error.message}. ` +
            "Check that Codex is installed and on PATH, or set CODEX_BIN.",
        ),
      );
    });

    finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      try {
        handleEvents(parser.flush());
      } catch (error) {
        reportStreamError(error);
      }
      // Notices about what was dropped go first, so the newest error Codex
      // actually reported stays last in the list.
      const notices: string[] = [];
      if (parser.truncatedLines > 0) {
        notices.push(`Truncated Codex output: discarded ${parser.truncatedLines} oversized JSONL line(s).`);
      }
      if (messagesTruncated) {
        notices.push("Truncated Codex agent messages: retained only the newest messages within the output limit.");
      }
      if (omittedCommands > 0) {
        notices.push(`Omitted ${omittedCommands} earlier command(s); only the newest ${COMMAND_COUNT_LIMIT} are listed.`);
      }
      if (omittedErrors > 0) {
        notices.push(`Omitted ${omittedErrors} older distinct error(s); only the newest ${ERROR_DISTINCT_LIMIT} are listed.`);
      }
      if (omittedFileChanges > 0) {
        notices.push(`Omitted ${omittedFileChanges} file change(s) beyond the first ${FILE_CHANGE_LIMIT} distinct files.`);
      }
      const errors = [
        ...notices,
        ...[...errorCounts].map(([message, count]) =>
          count > 1 ? `${message} (repeated ${count} times)` : message,
        ),
      ];
      cleanup();

      resolve({
        finalMessage: agentMessages.at(-1) ?? "",
        threadId,
        model: invocation.model ?? null,
        reasoningEffort: invocation.reasoningEffort ?? null,
        sandbox: invocation.sandbox,
        commands,
        fileChanges: [...fileChanges.values()],
        agentMessages,
        errors,
        warnings: [...warnings],
        turnFailure,
        usage,
        durationMs: Date.now() - startedAt,
        exitCode: code,
        timedOut,
        stderr: stderr.trim(),
      });
    };

    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      finish(code);
    });
  });

  function cleanup(): void {
    clearTimeout(timeoutTimer);
    // Settlement at the deadline must not cancel SIGKILL for a live child.
    signal?.removeEventListener("abort", onAbort);
  }

  return { result, cancel: () => terminate(false) };
}
