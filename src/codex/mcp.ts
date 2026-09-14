import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveCodexExecutable } from "./resolve.js";

const execFileAsync = promisify(execFile);

const LIST_TIMEOUT_MS = 10_000;

/**
 * Finds this server among the MCP servers registered in the user's Codex configuration.
 *
 * If it is registered there, a delegated Codex run could call it and delegate again, and again,
 * each level spending the user's usage. An environment marker cannot prevent that: verified
 * against codex-cli 0.154.0, Codex starts MCP servers with only a handful of variables (`HOME`,
 * `LOGNAME`, `PATH`, `SHELL`, `TMPDIR`, `USER`) unless the entry lists more in `env_vars`. What
 * does work is naming the entry: `-c mcp_servers.<name>.enabled=false` stops it from starting for
 * that run.
 *
 * An entry is this server when its command or an argument names the package, the installed bin,
 * or the entry script this process was started from. Pure, for testing.
 */
export function findSelfReferences(listJson: string, entryScript: string | undefined): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const normalise = (value: string): string => value.replace(/\\/g, "/").toLowerCase();
  const script = entryScript ? normalise(entryScript) : null;
  const refersToSelf = (value: unknown): boolean => {
    if (typeof value !== "string" || value.length === 0) return false;
    const text = normalise(value);
    const base = text.split("/").at(-1) ?? text;
    return (
      text.includes("codex-subagent-mcp") ||
      /^codex-subagent(\.cmd|\.exe)?$/.test(base) ||
      (script !== null && text === script)
    );
  };

  const names: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, transport } = entry as { name?: unknown; transport?: unknown };
    if (typeof name !== "string" || name.length === 0) continue;
    const { command, args } = (typeof transport === "object" && transport !== null ? transport : {}) as {
      command?: unknown;
      args?: unknown;
    };
    const values = [command, ...(Array.isArray(args) ? args : [])];
    if (values.some(refersToSelf)) names.push(name);
  }
  return names;
}

/**
 * Names of the Codex MCP entries that point back at this server, read from `codex mcp list --json`.
 *
 * Not cached: it is one short local process next to a delegation that runs for seconds, and a
 * stale answer would miss an entry added mid-session. Any failure yields no names — this is
 * defence in depth, and must never stop a delegation on its own.
 */
export async function selfRegisteredServers(
  codexPath: string = process.env.CODEX_BIN ?? "codex",
): Promise<string[]> {
  try {
    const resolved = resolveCodexExecutable(codexPath);
    const { stdout } = await execFileAsync(resolved.path ?? codexPath, ["mcp", "list", "--json"], {
      timeout: LIST_TIMEOUT_MS,
    });
    return findSelfReferences(stdout, process.argv[1]);
  } catch {
    return [];
  }
}
