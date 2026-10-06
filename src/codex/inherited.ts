import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ENV_PREFIX, type InheritPolicy } from "../config.js";
import { addressableInConfigPath } from "./args.js";
import { findSelfReferences } from "./mcp.js";
import { resolveCodexExecutable } from "./resolve.js";

/**
 * What a delegation inherits from the user's Codex setup, and what it is allowed to keep (ADR 16).
 *
 * Codex's sandbox confines shell commands, not MCP or plugin tools: a tool that declares itself
 * read-only runs unsandboxed and without approval even under `read-only`. So a run keeps only the
 * MCP servers, plugins and apps the user allowed in the server environment, and the control fails
 * closed: an MCP server can only be turned off by name, so a listing that cannot be read refuses a
 * restricted run instead of letting unvetted servers through.
 */

const execFileAsync = promisify(execFile);

const LIST_TIMEOUT_MS = 10_000;

/**
 * The MCP servers a run's configuration defines, without the ones plugins provide.
 *
 * Verified against codex-cli 0.159.2: `codex mcp list` also reports plugin servers, and
 * `-c mcp_servers.<name>.enabled=false` on one of those creates an entry with no transport, so
 * Codex refuses to start ("invalid transport"). With plugins off the listing holds only the
 * servers that can be turned off by name; a plugin's servers follow the plugin policy.
 */
export const MCP_LIST_ARGS = ["mcp", "list", "--json", "--config", "features.plugins=false"];

export type McpInventory = { ok: true; names: string[] } | { ok: false; error: string };
export type PluginInventory = { ok: true; enabled: string[] } | { ok: false; error: string };

export interface InheritanceReport {
  /** Names allowed from the inventory; "all" when an unrestricted listing failed. */
  mcpServers: string[] | "all";
  plugins: string[] | "all";
  apps: boolean;
  listingErrors: { mcp: string | null; plugins: string | null };
  /** What could not be applied as configured, and what was done instead. Present only when not empty. */
  problems?: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unique = (values: string[]): string[] => [...new Set(values)];

/**
 * Reads `codex mcp list --json`. Any entry whose name cannot be read makes the whole listing
 * unreadable: a partial inventory would leave the unnamed server running.
 */
export function parseMcpInventory(json: string): McpInventory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "codex mcp list --json did not print valid JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "codex mcp list --json did not print a JSON array" };
  }
  const names: string[] = [];
  for (const [index, entry] of parsed.entries()) {
    const name = isRecord(entry) ? entry.name : undefined;
    if (typeof name !== "string" || name.length === 0) {
      return { ok: false, error: `codex mcp list --json listed an entry without a readable name (entry ${index})` };
    }
    names.push(name);
  }
  return { ok: true, names: unique(names) };
}

/**
 * Reads `codex plugin list --json` (codex-cli 0.159.2: `{ installed: [...], available: [...] }`).
 * Only plugins that are installed and enabled can run, so only they are listed; `available`
 * describes the marketplace, not this machine.
 */
export function parsePluginInventory(json: string): PluginInventory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "codex plugin list --json did not print valid JSON" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.installed)) {
    return { ok: false, error: "codex plugin list --json did not list installed plugins" };
  }
  const enabled: string[] = [];
  for (const [index, entry] of parsed.installed.entries()) {
    const id = isRecord(entry) ? entry.pluginId : undefined;
    if (!isRecord(entry) || typeof id !== "string" || id.length === 0) {
      return { ok: false, error: `codex plugin list --json listed a plugin without a readable id (entry ${index})` };
    }
    // A plugin whose state cannot be read might be running; the listing is unreadable instead.
    if (typeof entry.installed !== "boolean" || typeof entry.enabled !== "boolean") {
      return { ok: false, error: `codex plugin list --json listed ${JSON.stringify(id)} without a readable state` };
    }
    if (entry.installed && entry.enabled) enabled.push(id);
  }
  return { ok: true, enabled: unique(enabled) };
}

/** Decides what a run turns off, from the user's policies and what is installed. Pure. */
export function resolveInheritance(input: {
  mcpServers: InheritPolicy;
  plugins: InheritPolicy;
  apps: boolean;
  mcp: McpInventory;
  /** Null when plugins were not listed because the policy turns every one off (#135). */
  pluginInventory: PluginInventory | null;
  selfNames: string[];
}): {
  ok: true;
  disabledMcpServers: string[];
  disabledPlugins: string[];
  disableAllPlugins: boolean;
  disableApps: boolean;
  report: InheritanceReport;
} | { ok: false; reason: string } {
  const { mcpServers, plugins, apps, mcp, selfNames } = input;
  // Only `none` may skip the listing; anywhere else a missing one is a failure, and fails closed.
  const pluginInventory: PluginInventory =
    input.pluginInventory ?? (plugins.kind === "none"
      ? { ok: true, enabled: [] }
      : { ok: false, error: "codex plugin list --json was not run" });

  if (!mcp.ok && mcpServers.kind !== "all") {
    return {
      ok: false,
      reason:
        `Codex's MCP servers could not be listed (${mcp.error}), so the ones this delegation must not ` +
        "inherit cannot be turned off by name, and it was not started. Check that `codex mcp list --json` " +
        `works in the delegation's directory, or set ${ENV_PREFIX}MCP_SERVERS=all to allow every server.`,
    };
  }

  const problems: string[] = [];

  // This server is always turned off, whatever the policy: the recursion guard.
  const isSelf = (name: string): boolean => selfNames.includes(name);
  let disabledMcpServers: string[];
  let allowedMcp: string[] | "all";
  if (!mcp.ok) {
    disabledMcpServers = selfNames.filter(addressableInConfigPath);
    allowedMcp = "all";
  } else {
    const keep = (name: string): boolean =>
      !isSelf(name) && (mcpServers.kind === "all" || (mcpServers.kind === "list" && mcpServers.names.includes(name)));
    const toDisable = mcp.names.filter((name) => !keep(name));
    const unaddressable = toDisable.filter((name) => !addressableInConfigPath(name) && !isSelf(name));
    if (unaddressable.length > 0) {
      return {
        ok: false,
        reason:
          `Codex's MCP configuration has ${unaddressable.map((name) => JSON.stringify(name)).join(", ")}, ` +
          "which this delegation must not inherit but which cannot be turned off for one run: Codex cannot " +
          'address a name with a dot or "=" in a config override. The delegation was not started. Rename ' +
          `the server, or allow it by name in ${ENV_PREFIX}MCP_SERVERS (or set it to all).`,
      };
    }
    disabledMcpServers = toDisable.filter(addressableInConfigPath);
    for (const name of toDisable.filter((name) => !addressableInConfigPath(name))) {
      problems.push(
        `this server's own Codex entry ${JSON.stringify(name)} cannot be turned off for one run (a dot or "=" ` +
          "in its name), so the recursion guard was not applied",
      );
    }
    allowedMcp = mcp.names.filter(keep);
  }

  let disabledPlugins: string[] = [];
  let disableAllPlugins = false;
  let allowedPlugins: string[] | "all";
  if (plugins.kind === "all") {
    allowedPlugins = pluginInventory.ok ? pluginInventory.enabled : "all";
  } else if (plugins.kind === "none" || !pluginInventory.ok) {
    // Turning every plugin off needs no inventory; a list that cannot be checked fails closed.
    disableAllPlugins = true;
    allowedPlugins = [];
  } else {
    const toDisable = pluginInventory.enabled.filter((id) => !plugins.names.includes(id));
    const unaddressable = toDisable.filter((id) => !addressableInConfigPath(id));
    if (unaddressable.length > 0) {
      // One plugin cannot be singled out, so none is kept: fail closed.
      disableAllPlugins = true;
      allowedPlugins = [];
      problems.push(
        `plugin ${unaddressable.map((id) => JSON.stringify(id)).join(", ")} cannot be turned off by name ` +
          '(a dot or "=" in its id), so every plugin was turned off',
      );
    } else {
      disabledPlugins = toDisable;
      allowedPlugins = pluginInventory.enabled.filter((id) => plugins.names.includes(id));
    }
  }

  return {
    ok: true,
    disabledMcpServers,
    disabledPlugins,
    disableAllPlugins,
    disableApps: !apps,
    report: {
      mcpServers: allowedMcp,
      plugins: allowedPlugins,
      apps,
      listingErrors: { mcp: mcp.ok ? null : mcp.error, plugins: pluginInventory.ok ? null : pluginInventory.error },
      ...(problems.length > 0 ? { problems } : {}),
    },
  };
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const names = (allowed: string[] | "all"): string =>
  allowed === "all" ? "all" : allowed.length === 0 ? "none" : allowed.map((name) => JSON.stringify(name)).join(", ");

/** One line stating what a run was allowed, with each name quoted so no name can blur the format. */
export function formatInheritance(report: InheritanceReport): string {
  const notes: string[] = [];
  if (report.listingErrors.mcp !== null) {
    notes.push(
      `the MCP listing failed (${oneLine(report.listingErrors.mcp)}), so the recursion guard was not applied`,
    );
  }
  if (report.listingErrors.plugins !== null) {
    notes.push(`the plugin listing failed (${oneLine(report.listingErrors.plugins)})`);
  }
  for (const problem of report.problems ?? []) notes.push(oneLine(problem));
  return (
    `Allowed from Codex: MCP servers ${names(report.mcpServers)}; plugins ${names(report.plugins)}; ` +
    `apps ${report.apps ? "on" : "off"}.` +
    (notes.length > 0 ? ` Note: ${notes.join("; ")}.` : "")
  );
}

/**
 * Why a listing failed, ahead of the message so truncation cannot cut it: Node's execFile reports
 * a timeout, an exit status and an outside signal all as "Command failed" (#135).
 */
function failureCause(error: unknown): string | null {
  if (!isRecord(error)) return null;
  if (error.killed === true) return `timed out after ${LIST_TIMEOUT_MS / 1000} s`;
  if (typeof error.code === "number") return `exited with code ${error.code}`;
  if (typeof error.signal === "string") return `killed by signal ${error.signal}`;
  return null;
}

/**
 * Lists the MCP servers and plugins a run in `cwd` would inherit. Not cached: both are short local
 * processes, and a stale answer would miss a server or plugin added mid-session (AC-12).
 *
 * `listPlugins: false` skips `codex plugin list`, which can take seconds and reach remote
 * marketplaces, when the policy turns every plugin off and needs no inventory (#135, ADR 16).
 */
export async function inspectInherited(options: {
  cwd?: string;
  codexPath?: string;
  listPlugins?: boolean;
}): Promise<{ mcp: McpInventory; plugins: PluginInventory | null; selfNames: string[] }> {
  const { codexPath = process.env.CODEX_BIN ?? "codex", cwd, listPlugins = true } = options;
  const list = async (args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> => {
    try {
      const resolved = resolveCodexExecutable(codexPath);
      const { stdout } = await execFileAsync(resolved.path ?? codexPath, args, {
        timeout: LIST_TIMEOUT_MS,
        ...(cwd ? { cwd } : {}),
      });
      return { ok: true, stdout };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cause = failureCause(error);
      const reason = cause ? `${cause}: ${message}` : message;
      // A failed CLI call can carry its whole stderr, and this ends up in a result.
      const bounded = reason.length > 300 ? `${reason.slice(0, 300)}… [truncated]` : reason;
      return { ok: false, error: oneLine(bounded) };
    }
  };

  const [mcpListing, pluginListing] = await Promise.all([
    list(MCP_LIST_ARGS),
    listPlugins ? list(["plugin", "list", "--json"]) : null,
  ]);
  const mcp = mcpListing.ok ? parseMcpInventory(mcpListing.stdout) : mcpListing;
  const plugins =
    pluginListing === null ? null : pluginListing.ok ? parsePluginInventory(pluginListing.stdout) : pluginListing;
  const selfNames = mcpListing.ok && mcp.ok ? findSelfReferences(mcpListing.stdout, process.argv[1]) : [];
  return { mcp, plugins, selfNames };
}
