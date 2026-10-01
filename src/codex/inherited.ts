import type { InheritPolicy } from "../config.js";

export type McpInventory = { ok: true; names: string[] } | { ok: false; error: string };
export type PluginInventory = { ok: true; enabled: string[] } | { ok: false; error: string };

export interface InheritanceReport {
  /** Names allowed from the inventory; "all" when an unrestricted listing failed. */
  mcpServers: string[] | "all";
  plugins: string[] | "all";
  apps: boolean;
  listingErrors: { mcp: string | null; plugins: string | null };
}

export function parseMcpInventory(json: string): McpInventory {
  throw new Error("not implemented");
}

export function parsePluginInventory(json: string): PluginInventory {
  throw new Error("not implemented");
}

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
  throw new Error("not implemented");
}

export function formatInheritance(report: InheritanceReport): string {
  throw new Error("not implemented");
}

export function inspectInherited(options: {
  cwd?: string;
  codexPath?: string;
}): Promise<{ mcp: McpInventory; plugins: PluginInventory; selfNames: string[] }> {
  throw new Error("not implemented");
}
