import { createReadStream } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AppliedSetting, AppliedSettings, SandboxMode } from "../types.js";
import { SANDBOX_MODES } from "../types.js";

/**
 * Reads what Codex actually applied to a run, from the session file it writes.
 *
 * The server passes the model, effort and sandbox on every invocation, but the
 * command line is not the only thing that decides them: a managed requirement
 * can lower a value and notify, a model may not support the effort asked for,
 * and a resumed session takes what it is not given from the configuration of
 * the directory it runs in. Reporting the request as if it were the outcome
 * hides all of that.
 *
 * Verified against codex-cli 0.154.0: every turn writes a `turn_context` line
 * into `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl`,
 * carrying `cwd`, `model`, `effort` (null when Codex defaulted it),
 * `sandbox_policy.type` and `approval_policy`. The file is written even when the
 * turn later fails, and is not written at all for `--ephemeral`.
 *
 * The format is internal and undocumented, so every failure here is reported as
 * "unconfirmed" rather than guessed at, and nothing in the delegation depends on
 * it succeeding. See ADR 13.
 */

/** Stop reading a session file after this much: a long run's file is unbounded. */
const READ_LIMIT_BYTES = 16 * 1024 * 1024;

/** Give up on the lookup after this long rather than hold a finished delegation. */
const LOOKUP_TIMEOUT_MS = 2000;

/** How far back to search for a resumed thread's file, which was created on the day the thread started. */
const MAX_DAY_DIRECTORIES = 400;

/** The fields of a `turn_context` line this server reads. Everything else is ignored. */
export interface TurnContext {
  cwd: string | null;
  model: string | null;
  /** Null when Codex recorded no effort, which means the model's own default. */
  effort: string | null;
  sandbox: string | null;
  approvalPolicy: string | null;
}

export interface TurnContextLookup {
  context: TurnContext | null;
  /** Why nothing could be read. Null when `context` is set. */
  reason: string | null;
}

/** What the invocation asked Codex for, as the comparison sees it. */
export interface RequestedSettings {
  model: string | null;
  reasoningEffort: string | null;
  sandbox: SandboxMode;
  workingDir: string;
}

export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), ".codex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Extracts a turn context from one JSONL line.
 *
 * Tolerant by design: the payload is read defensively and an unknown shape
 * yields null instead of throwing, so a format change degrades to "unconfirmed".
 */
export function parseTurnContextLine(line: string): TurnContext | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.includes("turn_context")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const envelope = asRecord(parsed);
  if (!envelope || envelope.type !== "turn_context") return null;

  // 0.154.0 nests the fields under `payload`; read the envelope itself as a
  // fallback so a flattened line would still be understood.
  const payload = asRecord(envelope.payload) ?? envelope;
  const sandboxPolicy = asRecord(payload.sandbox_policy);

  const context: TurnContext = {
    cwd: asString(payload.cwd),
    model: asString(payload.model),
    effort: asString(payload.effort),
    sandbox: asString(sandboxPolicy?.type),
    approvalPolicy: asString(payload.approval_policy),
  };

  // A line whose shape is right but carries none of these fields says nothing.
  // Returning it would let a malformed tail overwrite a context already read.
  return Object.values(context).some((value) => value !== null) ? context : null;
}

/** Reads a session file from the start, keeping the last turn context it contains. */
async function readLastTurnContext(file: string): Promise<TurnContext | null> {
  let last: TurnContext | null = null;
  let buffer = "";
  let read = 0;

  const stream = createReadStream(file, { encoding: "utf8" });
  try {
    for await (const chunk of stream) {
      read += (chunk as string).length;
      buffer += chunk as string;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        last = parseTurnContextLine(buffer.slice(0, newline)) ?? last;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      // A session file grows with everything the run printed. Stop rather than
      // hold it all in memory; whatever was found so far still stands.
      if (read >= READ_LIMIT_BYTES) break;
    }
  } finally {
    stream.destroy();
  }

  return parseTurnContextLine(buffer) ?? last;
}

async function listDirectory(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Date-named directories under `sessions/`, newest first. */
async function dayDirectories(sessionsDir: string): Promise<string[]> {
  const days: string[] = [];
  const isDatePart = (name: string): boolean => /^\d{2,4}$/.test(name);

  for (const year of (await listDirectory(sessionsDir)).filter(isDatePart).sort().reverse()) {
    const yearDir = join(sessionsDir, year);
    for (const month of (await listDirectory(yearDir)).filter(isDatePart).sort().reverse()) {
      const monthDir = join(yearDir, month);
      for (const day of (await listDirectory(monthDir)).filter(isDatePart).sort().reverse()) {
        days.push(join(monthDir, day));
        if (days.length >= MAX_DAY_DIRECTORIES) return days;
      }
    }
  }

  return days;
}

/**
 * Finds the session file of a thread.
 *
 * The file is named after the day the thread *started*, not the day this turn
 * ran, so a follow-up on an old thread is found by walking the date directories
 * newest first. The thread id is only ever compared against directory entries,
 * never joined into a path.
 */
async function findRolloutFile(sessionsDir: string, threadId: string): Promise<string | null> {
  const suffix = `-${threadId}.jsonl`;
  for (const dayDir of await dayDirectories(sessionsDir)) {
    for (const entry of await listDirectory(dayDir)) {
      if (entry.startsWith("rollout-") && entry.endsWith(suffix)) {
        return join(dayDir, entry);
      }
    }
  }
  return null;
}

async function lookup(threadId: string | null, codexHome: string): Promise<TurnContextLookup> {
  if (!threadId) {
    return {
      context: null,
      reason:
        "Codex reported no thread id, so its session file could not be located (an --ephemeral run writes none)",
    };
  }

  const sessionsDir = join(codexHome, "sessions");
  const file = await findRolloutFile(sessionsDir, threadId);
  if (!file) {
    return { context: null, reason: `no session file for this thread was found under ${sessionsDir}` };
  }

  try {
    const context = await readLastTurnContext(file);
    return context
      ? { context, reason: null }
      : { context: null, reason: "the session file recorded no turn context" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { context: null, reason: `the session file could not be read: ${message}` };
  }
}

/**
 * Reads the turn context of a finished run, or explains why it could not.
 *
 * Never rejects and never runs long: a delegation's result must not depend on
 * an internal file format being where and what this server expects.
 */
export async function readTurnContext(options: {
  threadId: string | null;
  codexHome?: string;
  timeoutMs?: number;
}): Promise<TurnContextLookup> {
  const codexHome = options.codexHome ?? codexHomeDir();
  const timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<TurnContextLookup>((resolve) => {
    timer = setTimeout(
      () => resolve({ context: null, reason: `reading the session file took longer than ${timeoutMs}ms` }),
      timeoutMs,
    );
    timer.unref?.();
  });

  try {
    return await Promise.race([
      lookup(options.threadId, codexHome).catch((error: unknown) => ({
        context: null,
        reason: `the session file could not be read: ${error instanceof Error ? error.message : String(error)}`,
      })),
      expiry,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Compares two directories the way the filesystem would, symlinks and case included. */
async function sameDirectory(a: string, b: string): Promise<boolean> {
  const normalise = (value: string): string =>
    process.platform === "win32" ? value.replace(/[\\/]+$/, "").toLowerCase() : value.replace(/\/+$/, "");

  if (normalise(a) === normalise(b)) return true;

  // macOS resolves temporary directories through a symlink (/var -> /private/var),
  // so the path Codex records is not always the string that was passed to it.
  try {
    return normalise(await realpath(a)) === normalise(await realpath(b));
  } catch {
    return false;
  }
}

function setting(requested: string | null, applied: string | null, matches: boolean): AppliedSetting {
  if (applied === null) {
    // Nothing recorded: for effort this means Codex used the model's default,
    // which is only a difference when something specific was asked for.
    return requested === null
      ? { requested, applied, state: "confirmed" }
      : { requested, applied, state: "differs" };
  }
  return { requested, applied, state: matches ? "confirmed" : "differs" };
}

const UNCONFIRMED = (requested: string | null): AppliedSetting => ({
  requested,
  applied: null,
  state: "unconfirmed",
});

function unconfirmedSettings(requested: RequestedSettings, reason: string): AppliedSettings {
  return {
    source: null,
    reason,
    model: UNCONFIRMED(requested.model),
    reasoningEffort: UNCONFIRMED(requested.reasoningEffort),
    sandbox: UNCONFIRMED(requested.sandbox),
    workingDir: UNCONFIRMED(requested.workingDir),
    approvalPolicy: null,
  };
}

/**
 * Turns an observed turn context into the per-field comparison the caller reads.
 *
 * A sandbox value this server does not recognise is reported as unconfirmed
 * rather than as a difference: an unknown name says nothing about how permissive
 * it is, and treating it as a mismatch would turn a CLI rename into a fleet of
 * failed delegations. What it must never do is read as confirmation.
 */
export async function compareApplied(
  requested: RequestedSettings,
  lookupResult: TurnContextLookup,
): Promise<AppliedSettings> {
  const { context, reason } = lookupResult;
  if (!context) return unconfirmedSettings(requested, reason ?? "no turn context was available");

  const known = (value: string | null): boolean =>
    value !== null && (SANDBOX_MODES as readonly string[]).includes(value);

  return {
    source: "rollout",
    reason: null,
    model: setting(requested.model, context.model, context.model === requested.model),
    reasoningEffort: setting(
      requested.reasoningEffort,
      context.effort,
      context.effort === requested.reasoningEffort,
    ),
    sandbox: known(context.sandbox)
      ? setting(requested.sandbox, context.sandbox, context.sandbox === requested.sandbox)
      : {
          requested: requested.sandbox,
          applied: context.sandbox,
          state: "unconfirmed",
        },
    workingDir: context.cwd
      ? setting(requested.workingDir, context.cwd, await sameDirectory(requested.workingDir, context.cwd))
      : UNCONFIRMED(requested.workingDir),
    approvalPolicy: context.approvalPolicy,
  };
}
