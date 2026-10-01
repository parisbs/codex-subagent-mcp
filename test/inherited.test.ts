import assert from "node:assert/strict";
import cp from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";

import type { InheritPolicy } from "../src/config.ts";
import type { InheritanceReport } from "../src/codex/inherited.ts";

let calls: { file: string; args: string[]; cwd?: string; timeout?: number }[] = [];
let mcpOutput = "[]";
let pluginOutput = '{"installed":[],"available":[]}';
let failures: Record<string, Error> = {};
const fakeExecFile = async (file: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
  calls.push({ file, args, ...options });
  if (failures[args[0]!]) throw failures[args[0]!]!;
  assert.ok(["mcp", "plugin"].includes(args[0]!), `unexpected command: ${args}`);
  return { stdout: args[0] === "mcp" ? mcpOutput : pluginOutput, stderr: "" };
};
cp.execFile = (() => {}) as unknown as typeof cp.execFile;
(cp.execFile as unknown as Record<symbol, unknown>)[promisify.custom] = fakeExecFile;
syncBuiltinESMExports();
const { parseMcpInventory, parsePluginInventory, resolveInheritance, formatInheritance, inspectInherited } =
  await import("../src/codex/inherited.ts");

const none: InheritPolicy = { kind: "none" };
const all: InheritPolicy = { kind: "all" };
const list = (...names: string[]): InheritPolicy => ({ kind: "list", names });
const input = {
  mcpServers: none, plugins: none, apps: false,
  mcp: { ok: true, names: ["docs", "Docs", "self"] } as const,
  pluginInventory: { ok: true, enabled: ["browser@market", "docs@market"] } as const,
  selfNames: ["self"],
};
// Mutable arrays match the public input signature.
const base = () => ({ ...input, mcp: { ok: true as const, names: [...input.mcp.names] },
  pluginInventory: { ok: true as const, enabled: [...input.pluginInventory.enabled] } });
const cleanErrors = { mcp: null, plugins: null };

function resolved(overrides: Partial<Parameters<typeof resolveInheritance>[0]> = {}) {
  const result = resolveInheritance({ ...base(), ...overrides });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

test("AC-1 (#64) resolves none to every MCP server and global plugin and app switches", () => {
  assert.deepEqual(resolved(), {
    ok: true, disabledMcpServers: ["docs", "Docs", "self"], disabledPlugins: [],
    disableAllPlugins: true, disableApps: true,
    report: { mcpServers: [], plugins: [], apps: false, listingErrors: cleanErrors },
  });
});

test("AC-2 (#64) keeps exactly existing case-sensitive MCP names and always excludes self", () => {
  assert.deepEqual(resolved({ mcpServers: list("docs", "self", "missing") }), {
    ok: true, disabledMcpServers: ["Docs", "self"], disabledPlugins: [],
    disableAllPlugins: true, disableApps: true,
    report: { mcpServers: ["docs"], plugins: [], apps: false, listingErrors: cleanErrors },
  });
});

test("AC-3 AC-5 AC-6 (#64) all and apps on add only the recursion guard", () => {
  assert.deepEqual(resolved({ mcpServers: all, plugins: all, apps: true }), {
    ok: true, disabledMcpServers: ["self"], disabledPlugins: [],
    disableAllPlugins: false, disableApps: false,
    report: { mcpServers: ["docs", "Docs"], plugins: ["browser@market", "docs@market"], apps: true, listingErrors: cleanErrors },
  });
});

test("AC-3 (#64) permits all MCP servers on listing failure and reports the cause", () => {
  const result = resolved({ mcpServers: all, mcp: { ok: false, error: "listing unavailable" }, selfNames: [] });
  assert.deepEqual(result.disabledMcpServers, []);
  assert.deepEqual(result.report, { mcpServers: "all", plugins: [], apps: false,
    listingErrors: { mcp: "listing unavailable", plugins: null } });
});

for (const cause of ["listing unavailable", "listing timed out after 10000ms"]) {
  test(`AC-4 (#64) refuses restricted MCP inheritance after ${cause}`, () => {
    for (const mcpServers of [none, list("docs")]) {
      const result = resolveInheritance({ ...base(), mcpServers, mcp: { ok: false, error: cause } });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.ok(result.reason.includes(cause));
      assert.match(result.reason, /codex mcp list --json/);
      assert.match(result.reason, /CODEX_SUBAGENT_MCP_SERVERS/);
      assert.match(result.reason, /all/);
    }
  });
}

for (const [label, json] of [
  ["invalid JSON", "not json"], ["non-array", '{}'], ["null entry", '[null]'],
  ["missing name", '[{"name":"docs"},{}]'], ["non-string name", '[{"name":3}]'],
  ["empty name", '[{"name":""}]'],
]) {
  test(`AC-4 (#64) refuses MCP ${label} without retaining a partial inventory`, () => {
    const mcp = parseMcpInventory(json!);
    assert.equal(mcp.ok, false);
    if (mcp.ok) return;
    assert.ok(mcp.error.length > 0);
    for (const mcpServers of [none, list("docs")]) {
      const result = resolveInheritance({ ...base(), mcpServers, mcp });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.reason.includes(mcp.error));
        assert.match(result.reason, /codex mcp list --json/);
        assert.match(result.reason, /CODEX_SUBAGENT_MCP_SERVERS/);
        assert.match(result.reason, /all/);
      }
    }
  });
}

test("AC-1 AC-2 (#64) parses empty and duplicate MCP inventories without folding case", () => {
  assert.deepEqual(parseMcpInventory("[]"), { ok: true, names: [] });
  assert.deepEqual(parseMcpInventory(JSON.stringify([{ name: "docs" }, { name: "docs" }, { name: "Docs" }])),
    { ok: true, names: ["docs", "Docs"] });
});

test("AC-5 (#64) parses the captured 0.159.2 plugin inventory", () => {
  const json = readFileSync(new URL("./fixtures/codex-plugin-list-0.159.2.json", import.meta.url), "utf8");
  assert.deepEqual(parsePluginInventory(json), { ok: true, enabled: [
    "documents@openai-primary-runtime", "pdf@openai-primary-runtime", "spreadsheets@openai-primary-runtime",
    "presentations@openai-primary-runtime", "template-creator@openai-primary-runtime", "codex-app-tools@openai-bundled",
    "browser@openai-bundled", "unified-computer-use@openai-bundled", "visualize@openai-bundled",
    "github@openai-curated-remote", "write-like-me@openai-curated-remote", "openai-templates@openai-curated-remote",
    "sites@openai-curated-remote", "plugin-management@openai-curated-remote", "work-pets@openai-curated-remote",
  ] });
});

test("AC-5 (#64) ignores unavailable and disabled plugins and deduplicates installed enabled ids", () => {
  assert.deepEqual(parsePluginInventory('{"installed":[],"available":[]}'), { ok: true, enabled: [] });
  const pluginInventory = parsePluginInventory(JSON.stringify({ installed: [
    { pluginId: "docs@market", installed: true, enabled: true },
    { pluginId: "docs@market", installed: true, enabled: true },
    { pluginId: "Docs@market", installed: true, enabled: true },
    { pluginId: "disabled@market", installed: true, enabled: false },
    { pluginId: "uninstalled@market", installed: false, enabled: true },
  ], available: [{ pluginId: "available@market", installed: true, enabled: true }] }));
  assert.deepEqual(pluginInventory, { ok: true, enabled: ["docs@market", "Docs@market"] });
  const result = resolved({ pluginInventory, plugins: list("docs@market", "disabled@market", "uninstalled@market", "missing@market") });
  assert.deepEqual(result.disabledPlugins, ["Docs@market"]);
  assert.equal(result.disableAllPlugins, false);
  assert.deepEqual(result.report.plugins, ["docs@market"]);
});

for (const [label, json] of [
  ["invalid JSON", "bad"], ["missing installed", '{}'], ["non-array installed", '{"installed":{}}'],
  ["null entry", '{"installed":[null]}'],
  ...[undefined, null, 3, ""].map((pluginId) => [`bad id ${JSON.stringify(pluginId)}`, JSON.stringify({ installed: [{ pluginId, installed: true, enabled: true }] })]),
]) {
  test(`AC-5 (#64) malformed plugin inventory ${label} disables all plugins`, () => {
    const pluginInventory = parsePluginInventory(json!);
    assert.equal(pluginInventory.ok, false);
    if (pluginInventory.ok) return;
    assert.ok(pluginInventory.error.length > 0);
    const result = resolved({ plugins: list("docs@market"), pluginInventory });
    assert.equal(result.disableAllPlugins, true);
    assert.deepEqual(result.disabledPlugins, []);
    assert.deepEqual(result.report.plugins, []);
    assert.equal(result.report.listingErrors.plugins, pluginInventory.error);
  });
}

test("AC-5 (#64) plugin listing errors fail closed for a list but all stays unrestricted", () => {
  for (const plugins of [none, list("docs@market"), all]) {
    const result = resolved({ plugins, pluginInventory: { ok: false, error: "plugin listing timed out" } });
    assert.equal(result.disableAllPlugins, plugins.kind !== "all");
    assert.deepEqual(result.disabledPlugins, []);
    assert.deepEqual(result.report.plugins, plugins.kind === "all" ? "all" : []);
    assert.equal(result.report.listingErrors.plugins, "plugin listing timed out");
  }
});

test("AC-2 AC-5 (#64) nonexistent allow-list names widen nothing", () => {
  const result = resolved({ mcpServers: list("missing"), plugins: list("missing@market") });
  assert.deepEqual(result.disabledMcpServers, ["docs", "Docs", "self"]);
  assert.deepEqual(result.disabledPlugins, ["browser@market", "docs@market"]);
  assert.equal(result.disableAllPlugins, false);
  assert.deepEqual(result.report.mcpServers, []);
  assert.deepEqual(result.report.plugins, []);
});

test("AC-9 (#64) formats allowed names as quoted names on one line including listing failures", () => {
  const report: InheritanceReport = { mcpServers: ['docs space', 'quote"name', 'line\nname'], plugins: ["docs@market"], apps: true,
    listingErrors: { mcp: null, plugins: "listing unavailable\nretry" } };
  const line = formatInheritance(report);
  assert.equal(line.split(/\r?\n/).length, 1);
  for (const name of [...report.mcpServers, "docs@market"]) assert.ok(line.includes(JSON.stringify(name)), line);
  assert.match(line, /MCP/i);
  assert.match(line, /plugins/i);
  assert.match(line, /apps.*(?:on|all|allowed)/i);
  assert.match(line, /listing unavailable/);
  const failed = formatInheritance({ mcpServers: "all", plugins: [], apps: false,
    listingErrors: { mcp: "MCP unavailable", plugins: null } });
  assert.match(failed, /MCP unavailable/);
  assert.match(failed, /recursion guard.*(?:not|unapplied|could not)/i);
});

test("AC-12 (#64) inspects both commands in each run directory without caching", async () => {
  calls = []; failures = {};
  for (const [index, cwd] of [tmpdir(), tmpdir(), process.cwd()].entries()) {
    mcpOutput = JSON.stringify([{ name: `docs-${index}` },
      { name: `self-${index}`, transport: { command: "codex-subagent" } }]);
    pluginOutput = JSON.stringify({ installed: [{ pluginId: `docs-${index}@market`, installed: true, enabled: true }] });
    assert.deepEqual(await inspectInherited({ codexPath: process.execPath, cwd }), {
      mcp: { ok: true, names: [`docs-${index}`, `self-${index}`] },
      plugins: { ok: true, enabled: [`docs-${index}@market`] }, selfNames: [`self-${index}`],
    });
    const pair = calls.slice(index * 2);
    assert.deepEqual(pair.map((call) => call.args).sort(), [["mcp", "list", "--json"], ["plugin", "list", "--json"]]);
    for (const call of pair) {
      assert.equal(call.file, process.execPath);
      assert.equal(call.cwd, cwd);
      assert.ok(call.timeout! > 0, "listings need a bounded timeout");
    }
  }
  assert.equal(calls.length, 6);
});

test("AC-4 AC-5 (#64) inspection preserves both listing failures without throwing", async () => {
  calls = []; failures = { mcp: new Error("MCP timed out"), plugin: new Error("plugin unavailable") };
  try {
    const result = await inspectInherited({ codexPath: process.execPath, cwd: tmpdir() });
    assert.deepEqual(result.mcp, { ok: false, error: "MCP timed out" });
    assert.deepEqual(result.plugins, { ok: false, error: "plugin unavailable" });
    assert.deepEqual(result.selfNames, []);
    assert.equal(calls.length, 2);
  } finally { failures = {}; }
});
