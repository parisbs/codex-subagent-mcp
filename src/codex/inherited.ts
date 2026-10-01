import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ENV_PREFIX, type InheritPolicy } from "../config.js";
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

export type McpInventory = { ok: true; names: string[] } | { ok: false; error: string };
export type PluginInventory = { ok: true; enabled: string[] } | { ok: false; error: string };

export interface InheritanceReport {
  /** Names allowed from the inventory; "all" when an unrestricted listing failed. */
  mcpServers: string[] | "all";
  plugins: string[] | "all";
  apps: boolean;
  listingErrors: { mcp: string | null; plugins: string | null };
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
    if (entry.installed === true && entry.enabled === true) enabled.push(id);
  }
  return { ok: true, enabled: unique(enabled) };
}

/** Decides what a run turns off, from the user's policies and what is installed. Pure. */
export function resolveInheritance(input: {
  mcpServers: InheritPolicy;
  plugins: InheritPolicy;
  apps: boolean;
  mcp: McpInventory;
  pluginInventory: PluginInventory;
  selfNames: string[];
}): {
  ok: true;
  disabledMcpServers: string[];
  disabledPlugins: string[];
  disableAllPlugins: boolean;
  disableApps: boolean;
  report: InheritanceReport;
} | { ok: false; reason: string } {
  const { mcpServers, plugins, apps, mcp, pluginInventory, selfNames } = input;

  if (!mcp.ok && mcpServers.kind !== "all") {
    return {
      ok: false,
      reason:
        `Codex's MCP servers could not be listed (${mcp.error}), so the ones this delegation must not ` +
        "inherit cannot be turned off by name, and it was not started. Check that `codex mcp list --json` " +
        `works in the delegation's directory, or set ${ENV_PREFIX}MCP_SERVERS=all to allow every server.`,
    };
  }

  // This server is always turned off, whatever the policy: the recursion guard.
  const isSelf = (name: string): boolean => selfNames.includes(name);
  let disabledMcpServers: string[];
  let allowedMcp: string[] | "all";
  if (!mcp.ok) {
    disabledMcpServers = [...selfNames];
    allowedMcp = "all";
  } else {
    const keep = (name: string): boolean =>
      !isSelf(name) && (mcpServers.kind === "all" || (mcpServers.kind === "list" && mcpServers.names.includes(name)));
    disabledMcpServers = mcp.names.filter((name) => !keep(name));
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
    disabledPlugins = pluginInventory.enabled.filter((id) => !plugins.names.includes(id));
    allowedPlugins = pluginInventory.enabled.filter((id) => plugins.names.includes(id));
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
  return (
    `Allowed from Codex: MCP servers ${names(report.mcpServers)}; plugins ${names(report.plugins)}; ` +
    `apps ${report.apps ? "on" : "off"}.` +
    (notes.length > 0 ? ` Note: ${notes.join("; ")}.` : "")
  );
}

/**
 * Lists the MCP servers and plugins a run in `cwd` would inherit. Not cached: both are short local
 * processes, and a stale answer would miss a server or plugin added mid-session (AC-12).
 */
export async function inspectInherited(options: {
  cwd?: string;
  codexPath?: string;
}): Promise<{ mcp: McpInventory; plugins: PluginInventory; selfNames: string[] }> {
  const { codexPath = process.env.CODEX_BIN ?? "codex", cwd } = options;
  const list = async (args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> => {
    try {
      const resolved = resolveCodexExecutable(codexPath);
      const { stdout } = await execFileAsync(resolved.path ?? codexPath, args, {
        timeout: LIST_TIMEOUT_MS,
        ...(cwd ? { cwd } : {}),
      });
      return { ok: true, stdout };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A failed CLI call can carry its whole stderr, and this ends up in a result.
      const bounded = reason.length > 300 ? `${reason.slice(0, 300)}… [truncated]` : reason;
      return { ok: false, error: oneLine(bounded) };
    }
  };

  const [mcpListing, pluginListing] = await Promise.all([
    list(["mcp", "list", "--json"]),
    list(["plugin", "list", "--json"]),
  ]);
  const mcp = mcpListing.ok ? parseMcpInventory(mcpListing.stdout) : mcpListing;
  const plugins = pluginListing.ok ? parsePluginInventory(pluginListing.stdout) : pluginListing;
  const selfNames = mcpListing.ok && mcp.ok ? findSelfReferences(mcpListing.stdout, process.argv[1]) : [];
  return { mcp, plugins, selfNames };
}
