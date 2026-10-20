import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ENV_PREFIX, type InheritPolicy } from "../config.js";
import { addressableInConfigPath, addressablePluginId } from "./args.js";
import { NEWEST_VERIFIED_CODEX_VERSION, compareVersions } from "./doctor.js";
import { findSelfReferences } from "./mcp.js";
import { resolveCodexExecutable } from "./resolve.js";

/**
 * What a delegation inherits from the user's Codex setup, and what it is allowed to keep (ADR 16).
 *
 * Codex's sandbox confines shell commands, not MCP or plugin tools: a tool that declares itself
 * read-only runs unsandboxed and without approval even under `read-only`. So a run keeps only the
 * MCP servers, plugins and apps the user allowed in the server environment, and the control fails
 * closed: an MCP server can only be turned off by name, so a listing that cannot be read refuses a
 * restricted run instead of letting unvetted servers through. An excluded remote plugin is turned
 * off by name only on a CLI known to honour it; elsewhere every plugin is turned off (ADR 31).
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
export type PluginInventory =
  /** `remote`: the enabled ids with any listed row whose `source.source` is not exactly `local` (ADR 31). */
  | { ok: true; enabled: string[]; remote: string[] }
  | { ok: false; error: string };

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

const quoted = (values: string[]): string => values.map((value) => JSON.stringify(value)).join(", ");

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
 *
 * A plugin is remote when any installed row for its id has a `source.source` other than exactly
 * `local`, a missing or unreadable one included, so a local row cannot hide a remote one (ADR 31).
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
  const remote = new Set<string>();
  for (const [index, entry] of parsed.installed.entries()) {
    const id = isRecord(entry) ? entry.pluginId : undefined;
    if (!isRecord(entry) || typeof id !== "string" || id.length === 0) {
      return { ok: false, error: `codex plugin list --json listed a plugin without a readable id (entry ${index})` };
    }
    // A plugin whose state cannot be read might be running; the listing is unreadable instead.
    if (typeof entry.installed !== "boolean" || typeof entry.enabled !== "boolean") {
      return { ok: false, error: `codex plugin list --json listed ${JSON.stringify(id)} without a readable state` };
    }
    const source = isRecord(entry.source) ? entry.source.source : undefined;
    if (source !== "local") remote.add(id);
    if (entry.installed && entry.enabled) enabled.push(id);
  }
  const ids = unique(enabled);
  return { ok: true, enabled: ids, remote: ids.filter((id) => remote.has(id)) };
}

/** The first release with `plugins._default`, which a remote plugin's override needs (ADR 31). */
const FIRST_PLUGIN_DEFAULT_VERSION = "0.163.0";

/** A plain release version: three dot-separated integers, nothing around them. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Whether this CLI is known to keep an excluded remote plugin out by name (ADR 31): a plain release
 * version from 0.163.0, the first with `plugins._default`, to the newest verified one.
 */
export function keepsRemotePluginsOutByName(
  cliVersion: string | null,
  newestVerified: string = NEWEST_VERIFIED_CODEX_VERSION,
): boolean {
  // `compareVersions` reads "0.163.bad" as 0.163.0, so the shape is checked strictly first.
  if (cliVersion === null || !RELEASE_VERSION.test(cliVersion)) return false;
  return (
    compareVersions(cliVersion, FIRST_PLUGIN_DEFAULT_VERSION) >= 0 && compareVersions(cliVersion, newestVerified) <= 0
  );
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
  /** The CLI version the preflight read for this call; null when it could not be read (ADR 31). */
  cliVersion: string | null;
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
      ? { ok: true, enabled: [], remote: [] }
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
    const allowed = pluginInventory.enabled.filter((id) => plugins.names.includes(id));
    const toDisable = pluginInventory.enabled.filter((id) => !plugins.names.includes(id));
    const unaddressable = toDisable.filter((id) => !addressablePluginId(id));
    // ADR 31: a remote plugin's override holds only where the CLI is known to honour it.
    const remoteKept = keepsRemotePluginsOutByName(input.cliVersion)
      ? []
      : toDisable.filter((id) => pluginInventory.remote.includes(id));
    if (unaddressable.length > 0 || remoteKept.length > 0) {
      // One plugin cannot be singled out, so none is kept: fail closed.
      disableAllPlugins = true;
      allowedPlugins = [];
      if (unaddressable.length > 0) {
        problems.push(
          `plugin ${quoted(unaddressable)} cannot be turned off by name ` +
            '(a dot or "=" in its id, or the reserved id "_default"), so every plugin was turned off',
        );
      }
      if (remoteKept.length > 0) {
        const version =
          input.cliVersion === null
            ? "this Codex CLI, whose version could not be read"
            : `Codex CLI ${JSON.stringify(input.cliVersion)}`;
        problems.push(
          `remote plugin ${quoted(remoteKept)} cannot be kept out by name on ${version}, which is not a release ` +
            `from ${FIRST_PLUGIN_DEFAULT_VERSION} to the newest verified ${NEWEST_VERIFIED_CODEX_VERSION}, so every ` +
            "plugin was turned off",
        );
      }
      if (allowed.length > 0) problems.push(`allowed plugin ${quoted(allowed)} was turned off too`);
    } else {
      disabledPlugins = toDisable;
      allowedPlugins = allowed;
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
 *
 * A plugin listing that prints anything on stderr counts as unreadable (ADR 31): codex-cli 0.163.0
 * exits 0 without network, lists only the local plugins, and says so on stderr alone.
 */
export async function inspectInherited(options: {
  cwd?: string;
  codexPath?: string;
  listPlugins?: boolean;
}): Promise<{ mcp: McpInventory; plugins: PluginInventory | null; selfNames: string[] }> {
  const { codexPath = process.env.CODEX_BIN ?? "codex", cwd, listPlugins = true } = options;
  // A failed CLI call can carry its whole stderr, and this ends up in a result.
  const bounded = (reason: string): string =>
    oneLine(reason.length > 300 ? `${reason.slice(0, 300)}… [truncated]` : reason);
  type Listing = { ok: true; stdout: string; stderr: string } | { ok: false; error: string };
  const list = async (args: string[]): Promise<Listing> => {
    try {
      const resolved = resolveCodexExecutable(codexPath);
      const { stdout, stderr } = await execFileAsync(resolved.path ?? codexPath, args, {
        timeout: LIST_TIMEOUT_MS,
        ...(cwd ? { cwd } : {}),
      });
      return { ok: true, stdout, stderr: String(stderr ?? "") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cause = failureCause(error);
      return { ok: false, error: bounded(cause ? `${cause}: ${message}` : message) };
    }
  };
  const readPlugins = (listing: Listing): PluginInventory => {
    if (!listing.ok) return listing;
    if (listing.stderr.length > 0) {
      const printed = oneLine(listing.stderr).length > 0 ? listing.stderr : "only whitespace";
      return { ok: false, error: bounded(`codex plugin list --json printed on stderr, so it may be incomplete: ${printed}`) };
    }
    return parsePluginInventory(listing.stdout);
  };

  const [mcpListing, pluginListing] = await Promise.all([
    list(MCP_LIST_ARGS),
    listPlugins ? list(["plugin", "list", "--json"]) : null,
  ]);
  const mcp = mcpListing.ok ? parseMcpInventory(mcpListing.stdout) : mcpListing;
  const plugins = pluginListing === null ? null : readPlugins(pluginListing);
  const selfNames = mcpListing.ok && mcp.ok ? findSelfReferences(mcpListing.stdout, process.argv[1]) : [];
  return { mcp, plugins, selfNames };
}
