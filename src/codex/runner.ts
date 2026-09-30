import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  DelegationResult,
  ExecutedCommand,
  FileChange,
  TokenUsage,
} from "../types.js";
import { buildCodexArgs, type CodexInvocation } from "./args.js";
import { resolveCodexExecutable } from "./resolve.js";
import { processGroupAlive, signalProcessTree } from "./terminate.js";
import { compareApplied, readTurnContext } from "./rollout.js";
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

/**
 * How long a cancelled run may wait for the CLI to close its pipes after the
 * forced stage. A descendant that left the process tree can hold them open
 * indefinitely, so the result settles at this bound regardless.
 */
const SETTLE_MARGIN_MS = 1000;

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
  /** Where Codex keeps its session files. Defaults to CODEX_HOME, else ~/.codex. */
  codexHome?: string;
  /** Grace between the polite termination request and the forced one. */
  killGraceMs?: number;
}

export interface CancelOptions {
  /** Overrides the run's grace for this request; only ever shortens a pending escalation. */
  graceMs?: number;
}

export interface RunHandle {
  result: Promise<DelegationResult>;
  cancel: (options?: CancelOptions) => void;
  /** The Codex process, when one was started. */
  pid: number | undefined;
  /** Resolves once the Codex process has exited and its pipes have closed. */
  exited: Promise<void>;
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
    codexHome,
    killGraceMs = KILL_GRACE_MS,
  } = options;

  if (signal?.aborted) {
    return {
      cancel: () => {},
      result: Promise.reject(new Error("Codex delegation was cancelled before it started.")),
      pid: undefined,
      exited: Promise.resolve(),
    };
  }

  const args = buildCodexArgs(invocation);
  const startedAt = Date.now();
  const workingDir = invocation.workingDir ?? process.cwd();

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
      // Its own process group on POSIX, so termination can reach every command
      // Codex started, not only Codex. See `src/codex/terminate.ts`.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      cancel: () => {},
      result: Promise.reject(
        new Error(`Could not start the Codex CLI ("${codexPath}"): ${message}`),
      ),
      pid: undefined,
      exited: Promise.resolve(),
    };
  }

  const parser = new JsonLinesParser();
  const agentMessages: string[] = [];
  const commands: ExecutedCommand[] = [];
  let commandCount = 0;
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
  let cancelled = false;
  let terminating = false;
  let settled = false;
  let killTimer: NodeJS.Timeout | undefined;
  /** When the pending SIGKILL is due; null when none is pending (never armed, sent or cleared). */
  let killDueAt: number | null = null;
  let settleTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let markExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });

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
            commandCount += 1;
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

  const signalTree = (signal: NodeJS.Signals): void =>
    signalProcessTree(
      { pid: child.pid, alive: child.exitCode === null && child.signalCode === null },
      signal,
    );

  /**
   * Settles with what has been read so far. An exited child can leave
   * descendants holding its pipes open, so close is not a reliable deadline.
   */
  const settleNow = (): void => {
    finish(child.exitCode);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  };

  /**
   * Schedules the forced stage. A later request can only bring it forward: the
   * server's shutdown has a fraction of a second where a cancellation has five.
   */
  const armKill = (graceMs: number): void => {
    const dueAt = Date.now() + graceMs;
    if (killDueAt !== null && killDueAt <= dueAt) return;
    clearTimeout(killTimer);
    killDueAt = dueAt;
    killTimer = setTimeout(() => {
      killDueAt = null;
      signalTree("SIGKILL");
      reportExitedIfDone();
    }, graceMs);
    killTimer.unref?.();
  };

  /**
   * `exited` means nothing is left to stop: the pipes have closed and no forced
   * stage is still owed to a group member that ignored SIGTERM. A shutdown that
   * exits on it must not skip that SIGKILL.
   */
  const reportExitedIfDone = (): void => {
    if (closed && killDueAt === null) markExited();
  };

  const clearKill = (): void => {
    clearTimeout(killTimer);
    killDueAt = null;
  };

  const terminate = (reason: "timeout" | "cancel", graceMs = killGraceMs): void => {
    // Once the pipes have closed there is nothing left to stop. A result that
    // settled earlier, at its timeout, can still have processes to bring down.
    if (closed) return;
    // The first reason is the one reported: a timeout reached while a
    // cancellation is winding down does not turn it into a timeout.
    if (!settled && reason === "timeout" && !cancelled) timedOut = true;
    if (!settled && reason === "cancel" && !timedOut) cancelled = true;
    // Both the timeout and an abort can fire before the child actually exits.
    // Only the first termination request sends SIGTERM. The group is signalled
    // even when Codex itself has already exited: what it started may not have.
    if (!terminating) {
      terminating = true;
      signalTree("SIGTERM");
      if (reason === "cancel" && !settled) {
        // A cancelled run waits for the CLI's last words, but not forever.
        settleTimer = setTimeout(settleNow, graceMs + SETTLE_MARGIN_MS);
        settleTimer.unref?.();
      }
    }
    armKill(graceMs);
    if (reason === "timeout") settleNow();
  };

  const timeoutTimer = setTimeout(() => terminate("timeout"), timeoutSeconds * 1000);
  timeoutTimer.unref?.();

  const onAbort = (): void => terminate("cancel");
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
      closed = true;
      markExited();
      if (settled) return;
      settled = true;
      cleanup();
      clearKill();
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

      const base = {
        finalMessage: agentMessages.at(-1) ?? "",
        threadId,
        model: invocation.model ?? null,
        reasoningEffort: invocation.reasoningEffort ?? null,
        sandbox: invocation.sandbox,
        workingDir,
        commandCount,
        commands,
        fileChanges: [...fileChanges.values()],
        agentMessages,
        errors,
        warnings: [...warnings],
        turnFailure,
        // `turn.completed` is cumulative on resume. The server can derive this
        // turn only when its thread registry supplies the preceding total.
        turnUsage: invocation.kind === "exec" ? usage : null,
        threadUsage: usage,
        durationMs: Date.now() - startedAt,
        exitCode: code,
        timedOut,
        cancelled,
        stderr: stderr.trim(),
      };

      // What Codex applied is read from its own session file, after the child
      // has written it. The delegation never depends on that read succeeding:
      // every failure comes back as "unconfirmed" and the result is unchanged.
      void confirmApplied(base);
    };

    const confirmApplied = async (
      base: Omit<DelegationResult, "applied">,
    ): Promise<void> => {
      const requested = {
        model: base.model,
        reasoningEffort: base.reasoningEffort,
        sandbox: base.sandbox,
        workingDir: base.workingDir,
      };
      try {
        const lookup = await readTurnContext({ threadId: base.threadId, codexHome });
        resolve({ ...base, applied: await compareApplied(requested, lookup) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolve({
          ...base,
          applied: await compareApplied(requested, {
            context: null,
            reason: `the applied settings could not be checked: ${message}`,
          }),
        });
      }
    };

    child.on("close", (code) => {
      closed = true;
      // A member of the group that ignored SIGTERM still gets SIGKILL when the
      // grace runs out; an empty group's id may be reused and is left alone.
      if (!(terminating && processGroupAlive(child.pid))) clearKill();
      finish(code);
      reportExitedIfDone();
    });
  });

  function cleanup(): void {
    clearTimeout(timeoutTimer);
    clearTimeout(settleTimer);
    // Settlement at the deadline must not cancel SIGKILL for a live child.
    signal?.removeEventListener("abort", onAbort);
  }

  return {
    result,
    cancel: (options = {}) => terminate("cancel", options.graceMs ?? killGraceMs),
    pid: child.pid,
    exited,
  };
}
