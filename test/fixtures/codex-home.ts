import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway `CODEX_HOME` holding session files shaped like the real ones.
 *
 * `codex exec` writes one JSONL file per thread under
 * `sessions/YYYY/MM/DD/rollout-<local timestamp>-<thread id>.jsonl`, named after
 * the day the thread started. Tests write the file the CLI would have written,
 * which is also what lets the delegation stand-in stay a plain stdout script.
 */
export interface CodexHome {
  path: string;
  write: (options: { threadId: string; day: string; lines: string[] }) => void;
  dispose: () => void;
}

export function createCodexHome(): CodexHome {
  const path = mkdtempSync(join(tmpdir(), "codex-subagent-home-"));
  return {
    path,
    write: ({ threadId, day, lines }) => {
      const dir = join(path, "sessions", ...day.split("-"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `rollout-${day}T19-12-00-${threadId}.jsonl`),
        `${lines.join("\n")}\n`,
        "utf8",
      );
    },
    dispose: () => rmSync(path, { recursive: true, force: true }),
  };
}

/** One `turn_context` line, with the fields a test cares about overridden. */
export function turnContextLine(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: "2026-09-17T19:12:03.849Z",
    type: "turn_context",
    payload: {
      cwd: "/workspace/project",
      approval_policy: "never",
      sandbox_policy: { type: "read-only" },
      model: "gpt-5.6-luna",
      effort: "low",
      ...fields,
    },
  });
}

/** The first line of every session file; carries no turn context. */
export const SESSION_META_LINE = JSON.stringify({
  timestamp: "2026-09-17T19:12:00.627Z",
  ordinal: 0,
  type: "session_meta",
  payload: { cwd: "/workspace/project", originator: "codex_exec", cli_version: "0.154.0", source: "exec" },
});
