import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { DelegationResult, ExecutedCommand, TokenUsage } from "../types.js";
import { buildCodexArgs, type CodexInvocation } from "./args.js";
import { resolveCodexExecutable } from "./resolve.js";
import {
  JsonLinesParser,
  describeEvent,
  parseUsage,
  toErrorMessage,
  toExecutedCommand,
  type CodexEvent,
} from "./events.js";

/** Default wall-clock budget for a delegation. Deliberately generous: a
 * high-effort Codex run on a real repository can take many minutes. */
export const DEFAULT_TIMEOUT_SECONDS = 1800;

/** Grace period between SIGTERM and SIGKILL when a run is cut short. */
const KILL_GRACE_MS = 5000;

/** Cap on retained stderr so a noisy run cannot grow unbounded. */
const STDERR_LIMIT = 64 * 1024;

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
  const errors: string[] = [];
  let threadId: string | null = null;
  let usage: TokenUsage | null = null;
  let stderr = "";
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;

  const handleEvents = (events: CodexEvent[]): void => {
    for (const event of events) {
      if (event.type === "thread.started" && event.thread_id) {
        threadId = event.thread_id;
      }
      if (event.type === "item.completed") {
        const item = event.item;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          agentMessages.push(item.text);
        }
        const executed = toExecutedCommand(event);
        if (executed) commands.push(executed);
        const reported = toErrorMessage(event);
        if (reported) errors.push(reported);
      }
      if (event.type === "turn.completed") {
        usage = parseUsage(event) ?? usage;
      }
      onEvent?.(event, describeEvent(event));
    }
  };

  const terminate = (markTimeout: boolean): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (markTimeout) timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    killTimer.unref?.();
  };

  const timeoutTimer = setTimeout(() => terminate(true), timeoutSeconds * 1000);
  timeoutTimer.unref?.();

  const onAbort = (): void => terminate(false);
  signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => handleEvents(parser.push(chunk)));

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < STDERR_LIMIT) {
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
      cleanup();
      reject(
        new Error(
          `Could not run the Codex CLI ("${codexPath}"): ${error.message}. ` +
            "Check that Codex is installed and on PATH, or set CODEX_BIN.",
        ),
      );
    });

    child.on("close", (code) => {
      handleEvents(parser.flush());
      cleanup();

      resolve({
        finalMessage: agentMessages.at(-1) ?? "",
        threadId,
        model: invocation.model ?? null,
        reasoningEffort: invocation.reasoningEffort ?? null,
        sandbox: invocation.sandbox,
        commands,
        agentMessages,
        errors,
        usage,
        durationMs: Date.now() - startedAt,
        exitCode: code,
        timedOut,
        stderr: stderr.trim(),
      });
    });
  });

  function cleanup(): void {
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener("abort", onAbort);
  }

  return { result, cancel: () => terminate(false) };
}
