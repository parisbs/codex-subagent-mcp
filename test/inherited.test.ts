import assert from "node:assert/strict";
import cp from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";

import type { InheritPolicy } from "../src/config.ts";
import { compareVersions, NEWEST_VERIFIED_CODEX_VERSION, parseVersion } from "../src/codex/doctor.ts";
import type { InheritanceReport } from "../src/codex/inherited.ts";

let calls: { file: string; args: string[]; cwd?: string; timeout?: number }[] = [];
let mcpOutput = "[]";
let pluginOutput = '{"installed":[],"available":[]}';
let pluginStderr = "";
let failures: Record<string, Error> = {};
const fakeExecFile = async (file: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
  calls.push({ file, args, ...options });
  if (failures[args[0]!]) throw failures[args[0]!]!;
  assert.ok(["mcp", "plugin"].includes(args[0]!), `unexpected command: ${args}`);
  return { stdout: args[0] === "mcp" ? mcpOutput : pluginOutput, stderr: args[0] === "plugin" ? pluginStderr : "" };
};
cp.execFile = (() => {}) as unknown as typeof cp.execFile;
(cp.execFile as unknown as Record<symbol, unknown>)[promisify.custom] = fakeExecFile;
syncBuiltinESMExports();
const {
  parseMcpInventory, parsePluginInventory, resolveInheritance, formatInheritance, inspectInherited,
  keepsRemotePluginsOutByName,
} = await import("../src/codex/inherited.ts");

const none: InheritPolicy = { kind: "none" };
const all: InheritPolicy = { kind: "all" };
const list = (...names: string[]): InheritPolicy => ({ kind: "list", names });
const input = {
  mcpServers: none, plugins: none, apps: false,
  mcp: { ok: true, names: ["docs", "Docs", "self"] } as const,
  pluginInventory: { ok: true, enabled: ["browser@market", "docs@market"], remote: [] } as const,
  selfNames: ["self"],
  // Amended for #189: the CLI version is a required input (ADR 31).
  cliVersion: NEWEST_VERIFIED_CODEX_VERSION as string | null,
};
// Mutable arrays match the public input signature.
const base = () => ({ ...input, mcp: { ok: true as const, names: [...input.mcp.names] },
  pluginInventory: { ok: true as const, enabled: [...input.pluginInventory.enabled], remote: [] as string[] } });
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
  // Amended for #189: the inventory also says which plugins are remote (ADR 31).
  ], remote: [
    "github@openai-curated-remote", "write-like-me@openai-curated-remote", "openai-templates@openai-curated-remote",
    "sites@openai-curated-remote", "plugin-management@openai-curated-remote", "work-pets@openai-curated-remote",
  ] });
});

test("AC-5 (#64) ignores unavailable and disabled plugins and deduplicates installed enabled ids", () => {
  assert.deepEqual(parsePluginInventory('{"installed":[],"available":[]}'), { ok: true, enabled: [], remote: [] });
  // Amended for #189: the rows are local, so the filtering below does not depend on the CLI version.
  const local = { source: { source: "local" } };
  const pluginInventory = parsePluginInventory(JSON.stringify({ installed: [
    { pluginId: "docs@market", installed: true, enabled: true, ...local },
    { pluginId: "docs@market", installed: true, enabled: true, ...local },
    { pluginId: "Docs@market", installed: true, enabled: true, ...local },
    { pluginId: "disabled@market", installed: true, enabled: false, ...local },
    { pluginId: "uninstalled@market", installed: false, enabled: true, ...local },
  ], available: [{ pluginId: "available@market", installed: true, enabled: true }] }));
  assert.deepEqual(pluginInventory, { ok: true, enabled: ["docs@market", "Docs@market"], remote: [] });
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
      // Amended for #189: a row without a source counts as remote (ADR 31).
      plugins: { ok: true, enabled: [`docs-${index}@market`], remote: [`docs-${index}@market`] }, selfNames: [`self-${index}`],
    });
    const pair = calls.slice(index * 2);
    // Amended on 2026-10-01: the MCP listing runs with plugins off. `codex mcp list` also reports
    // the servers plugins provide, and turning one of those off by name makes Codex refuse to
    // start ("invalid transport", codex-cli 0.159.2); they are governed by the plugin policy.
    assert.deepEqual(pair.map((call) => call.args).sort(), [
      ["mcp", "list", "--json", "--config", "features.plugins=false"],
      ["plugin", "list", "--json"],
    ]);
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

// The shapes Node's execFile gives a failed child: `killed` with the timeout's signal, a numeric
// `code` for an exit status, and `signal` alone for a signal sent from outside.
const execFailure = (fields: Record<string, unknown>, stderr = "") =>
  Object.assign(new Error(`Command failed: codex list --json\n${stderr}`), fields);

test("AC-3 (#135) a failed listing states its cause before the bounded stderr", async () => {
  for (const [label, error, cause] of [
    ["timeout", execFailure({ killed: true, signal: "SIGTERM", code: null }), /timed out after 10 s/],
    ["exit code", execFailure({ killed: false, signal: null, code: 2 }, "error: bad flag"), /exited with code 2/],
    ["signal", execFailure({ killed: false, signal: "SIGKILL", code: null }), /killed by signal SIGKILL/],
    ["long stderr", execFailure({ killed: false, signal: null, code: 1 }, "x".repeat(2000)), /exited with code 1/],
  ] as const) {
    calls = []; failures = { mcp: error, plugin: error };
    try {
      const result = await inspectInherited({ codexPath: process.execPath, cwd: tmpdir() });
      for (const listing of [result.mcp, result.plugins]) {
        assert.equal(listing?.ok, false, label);
        if (listing?.ok !== false) continue;
        assert.match(listing.error, cause, label);
        assert.match(listing.error, /Command failed/, label);
        assert.ok(listing.error.length < 400, `${label}: stderr stays bounded (${listing.error.length})`);
        if (label === "exit code") assert.match(listing.error, /error: bad flag/);
      }
    } finally { failures = {}; }
  }
});

test("AC-1 (#135) inspection skips the plugin listing when no plugin may be listed", async () => {
  calls = []; failures = { plugin: new Error("plugin unavailable") };
  try {
    const result = await inspectInherited({ codexPath: process.execPath, cwd: tmpdir(), listPlugins: false });
    assert.deepEqual(calls.map((call) => call.args[0]), ["mcp"]);
    assert.equal(result.plugins, null);
    const resolved = resolveInheritance({ ...base(), pluginInventory: result.plugins });
    assert.ok(resolved.ok);
    if (resolved.ok) {
      assert.equal(resolved.disableAllPlugins, true);
      assert.equal(resolved.report.listingErrors.plugins, null);
    }
  } finally { failures = {}; }
});

test("AC-2 (#135) a list policy whose plugins were not listed still turns every plugin off", () => {
  for (const plugins of [list("docs@market"), all]) {
    const resolved = resolveInheritance({ ...base(), plugins, pluginInventory: null });
    assert.ok(resolved.ok);
    if (!resolved.ok) continue;
    if (plugins.kind === "list") {
      assert.equal(resolved.disableAllPlugins, true);
      assert.deepEqual(resolved.report.plugins, []);
    }
    assert.notEqual(resolved.report.listingErrors.plugins, null, "an unlisted inventory is reported");
  }
});

// Amended on 2026-10-01: codex-cli 0.159.2 splits a `-c` path on dots and on the first `=`, so a
// server or plugin whose name holds either cannot be turned off for one run. Fail closed.
test("AC-1 AC-2 AC-4 (#64) refuses when an MCP server it must turn off cannot be addressed by name", () => {
  for (const name of ["dot.name", "eq=sign"]) {
    for (const mcpServers of [none, list("docs")]) {
      const result = resolveInheritance({ ...base(), mcpServers, mcp: { ok: true, names: ["docs", name] } });
      assert.equal(result.ok, false, name);
      if (!result.ok) {
        assert.ok(result.reason.includes(JSON.stringify(name)), result.reason);
        assert.match(result.reason, /CODEX_SUBAGENT_MCP_SERVERS/);
      }
    }
    // Kept on, it needs no override at all.
    const allowed = resolved({ mcpServers: list(name), mcp: { ok: true, names: [name] } });
    assert.deepEqual(allowed.disabledMcpServers, []);
    assert.deepEqual(allowed.report.mcpServers, [name]);
  }
});

test("AC-2 AC-3 (#64) reports the recursion guard as unapplied when this server's name cannot be addressed", () => {
  const result = resolved({ mcpServers: all, mcp: { ok: true, names: ["docs", "codex.subagent"] }, selfNames: ["codex.subagent"] });
  assert.deepEqual(result.disabledMcpServers, []);
  assert.deepEqual(result.report.mcpServers, ["docs"]);
  const line = formatInheritance(result.report);
  assert.ok(line.includes(JSON.stringify("codex.subagent")), line);
  assert.match(line, /recursion guard.*(?:not|unapplied|could not)/i);
});

test("AC-5 (#64) turns every plugin off when one it must turn off cannot be addressed by name", () => {
  const result = resolved({ plugins: list("docs@market"),
    pluginInventory: { ok: true, enabled: ["docs@market", "dot.ted@market"], remote: [] } });
  assert.equal(result.disableAllPlugins, true);
  assert.deepEqual(result.disabledPlugins, []);
  assert.deepEqual(result.report.plugins, []);
  const line = formatInheritance(result.report);
  assert.ok(line.includes(JSON.stringify("dot.ted@market")), line);
  // Allowed, it needs no override and nothing changes.
  const allowed = resolved({ plugins: list("docs@market", "dot.ted@market"),
    pluginInventory: { ok: true, enabled: ["docs@market", "dot.ted@market"], remote: [] } });
  assert.equal(allowed.disableAllPlugins, false);
  assert.deepEqual(allowed.report.plugins, ["docs@market", "dot.ted@market"]);
});

for (const [label, state] of [
  ["installed missing", { enabled: true }], ["installed as text", { installed: "true", enabled: true }],
  ["enabled missing", { installed: true }], ["enabled as a number", { installed: true, enabled: 1 }],
  ["enabled null", { installed: true, enabled: null }],
] as const) {
  test(`AC-8 (#129) a plugin entry with ${label} makes the listing unreadable and disables all plugins`, () => {
    const pluginInventory = parsePluginInventory(JSON.stringify({
      installed: [{ pluginId: "docs@market", installed: true, enabled: true }, { pluginId: "other@market", ...state }],
      available: [],
    }));
    assert.equal(pluginInventory.ok, false);
    const result = resolved({ plugins: list("docs@market"), pluginInventory });
    assert.equal(result.disableAllPlugins, true);
    assert.deepEqual(result.report.plugins, []);
    assert.notEqual(result.report.listingErrors.plugins, null);
  });
}

// #189, ADR 31: on codex-cli 0.163.0 `plugins.<id>.enabled=false` keeps a remote plugin out only
// next to `plugins._default.enabled=true`, a key that release introduced. Elsewhere an excluded
// remote plugin turns every plugin off, and the result says what was lost and why.
const windowOpen = compareVersions(NEWEST_VERIFIED_CODEX_VERSION, "0.163.0") >= 0;
const [major, minor, patch] = NEWEST_VERIFIED_CODEX_VERSION.split(".").map(Number);
const newerThanVerified = `${major}.${minor}.${patch! + 1}`;
const remoteInventory = (enabled: string[], remote: string[]) => ({ ok: true as const, enabled, remote });
const lineOf = (result: { report: InheritanceReport }) => formatInheritance(result.report);

test("AC-2 (#189) a remote plugin is kept out by name only on a release from 0.163.0 to the newest verified", () => {
  for (const version of ["0.163.0", "0.164.2", "0.165.0"]) {
    assert.equal(keepsRemotePluginsOutByName(version, "0.165.0"), true, version);
  }
  for (const version of ["0.165.1", "0.166.0", "0.162.1", "0.160.0", "0.159.2", "0.154.0"]) {
    assert.equal(keepsRemotePluginsOutByName(version, "0.165.0"), false, version);
  }
  // Below 0.163.0 the newest verified release opens no window at all.
  assert.equal(keepsRemotePluginsOutByName("0.160.0", "0.160.0"), false);
  assert.equal(keepsRemotePluginsOutByName("0.163.0", "0.160.0"), false);
  // The default bound is the constant the smoke test moves.
  assert.equal(keepsRemotePluginsOutByName(NEWEST_VERIFIED_CODEX_VERSION), windowOpen);
  assert.equal(keepsRemotePluginsOutByName(newerThanVerified), false);
});

test("AC-2 (#189) an unknown or malformed version never counts as verified", () => {
  for (const version of [null, "", "0.163", "0.163.0.1", "0.163.0-alpha", "0.163.bad", "v0.163.0", " 0.163.0", "0.163.0 "]) {
    assert.equal(keepsRemotePluginsOutByName(version, "0.165.0"), false, JSON.stringify(version));
  }
});

test("AC-2 (#189) at the newest verified version the decision follows the window", () => {
  const result = resolved({ plugins: list("a@m"), cliVersion: NEWEST_VERIFIED_CODEX_VERSION,
    pluginInventory: remoteInventory(["a@m", "r@remote"], ["r@remote"]) });
  if (windowOpen) {
    assert.deepEqual(result.disabledPlugins, ["r@remote"]);
    assert.equal(result.disableAllPlugins, false);
    assert.deepEqual(result.report.plugins, ["a@m"]);
    assert.equal(result.report.problems, undefined);
  } else {
    assert.equal(result.disableAllPlugins, true);
    assert.deepEqual(result.disabledPlugins, []);
    assert.deepEqual(result.report.plugins, []);
  }
  assert.equal(result.report.listingErrors.plugins, null);
});

test("AC-5 (#187) codex-cli 0.163.0 keeps an excluded remote plugin out by name and the allowed one in", () => {
  // The default bound, not a stand-in: 0.163.0 is verified, so the window is open on it.
  assert.equal(keepsRemotePluginsOutByName("0.163.0"), true);
  const result = resolved({ plugins: list("a@m"), cliVersion: "0.163.0",
    pluginInventory: remoteInventory(["a@m", "r@remote"], ["r@remote"]) });
  assert.deepEqual(result.disabledPlugins, ["r@remote"]);
  assert.equal(result.disableAllPlugins, false);
  assert.deepEqual(result.report.plugins, ["a@m"]);
  assert.equal(result.report.problems, undefined);
  assert.equal(result.report.listingErrors.plugins, null);
});

test("AC-2 (#189) an excluded remote plugin on an unverified CLI turns every plugin off and says what was lost", () => {
  for (const cliVersion of [newerThanVerified, "0.162.1", "0.159.1", "0.154.0", "0.163.bad", null]) {
    const result = resolved({ plugins: list("a@m", "b@m", "missing@m"), cliVersion,
      pluginInventory: remoteInventory(["a@m", "b@m", "r@remote", "s@remote"], ["r@remote", "s@remote"]) });
    const label = JSON.stringify(cliVersion);
    assert.equal(result.disableAllPlugins, true, label);
    assert.deepEqual(result.disabledPlugins, [], label);
    assert.deepEqual(result.report.plugins, [], label);
    assert.equal(result.report.listingErrors.plugins, null, label);
    assert.ok((result.report.problems ?? []).length > 0, label);
    const line = lineOf(result);
    assert.equal(line.split(/\r?\n/).length, 1, label);
    assert.match(line, /plugins none/, label);
    for (const id of ["a@m", "b@m", "r@remote", "s@remote"]) assert.ok(line.includes(JSON.stringify(id)), `${label}: ${id}`);
    assert.ok(!line.includes("missing@m"), `${label}: names a plugin that is not installed`);
    assert.match(line, /remote/i, label);
    assert.match(line, /every plugin/i, label);
    if (cliVersion === null) assert.match(line, /unknown|not known|could not be read/i, label);
    else assert.ok(line.includes(cliVersion), `${label}: names the version`);
  }
});

test("AC-2 (#189) the fallback note stays on one line with hostile plugin ids", () => {
  const remote = 'quote"d@remote\nnext';
  const result = resolved({ plugins: list("a@m"), cliVersion: null,
    pluginInventory: remoteInventory(["a@m", remote], [remote]) });
  assert.equal(result.disableAllPlugins, true);
  const line = lineOf(result);
  assert.equal(line.split(/\r?\n/).length, 1);
  assert.ok(line.includes(JSON.stringify(remote)), line);
});

test("AC-2 (#189) only an excluded remote plugin triggers the fallback", () => {
  for (const cliVersion of [newerThanVerified, null]) {
    // The remote plugin is allowed; only a local one is excluded.
    const allowedRemote = resolved({ plugins: list("r@remote", "a@m"), cliVersion,
      pluginInventory: remoteInventory(["r@remote", "a@m", "l@m"], ["r@remote"]) });
    assert.deepEqual(allowedRemote.disabledPlugins, ["l@m"]);
    assert.equal(allowedRemote.disableAllPlugins, false);
    assert.deepEqual(allowedRemote.report.plugins, ["r@remote", "a@m"]);
    assert.equal(allowedRemote.report.problems, undefined);
    const noRemote = resolved({ plugins: list("a@m"), cliVersion,
      pluginInventory: remoteInventory(["a@m", "l@m"], []) });
    assert.deepEqual(noRemote.disabledPlugins, ["l@m"]);
    assert.equal(noRemote.disableAllPlugins, false);
    assert.equal(noRemote.report.problems, undefined);
  }
});

test("AC-2 (#189) a fallback with nothing allowed installed names no allowed plugin", () => {
  const result = resolved({ plugins: list("missing@m"), cliVersion: null,
    pluginInventory: remoteInventory(["r@remote"], ["r@remote"]) });
  assert.equal(result.disableAllPlugins, true);
  assert.deepEqual(result.disabledPlugins, []);
  assert.deepEqual(result.report.plugins, []);
  const line = lineOf(result);
  assert.ok(line.includes(JSON.stringify("r@remote")), line);
  assert.ok(!line.includes("missing@m"), line);
});

test("AC-2 AC-3 (#189) all and none ignore the CLI version", () => {
  for (const cliVersion of [newerThanVerified, null]) {
    const pluginInventory = remoteInventory(["a@m", "r@remote"], ["r@remote"]);
    const allowAll = resolved({ plugins: all, cliVersion, pluginInventory });
    assert.equal(allowAll.disableAllPlugins, false);
    assert.deepEqual(allowAll.disabledPlugins, []);
    assert.deepEqual(allowAll.report.plugins, ["a@m", "r@remote"]);
    assert.equal(allowAll.report.problems, undefined);
    for (const inventory of [pluginInventory, null]) {
      const allowNone = resolved({ plugins: none, cliVersion, pluginInventory: inventory });
      assert.equal(allowNone.disableAllPlugins, true);
      assert.deepEqual(allowNone.disabledPlugins, []);
      assert.deepEqual(allowNone.report.plugins, []);
      assert.equal(allowNone.report.problems, undefined);
    }
  }
});

test("AC-2 (#189) a plugin counts as remote unless every row for it is exactly local", () => {
  const row = (pluginId: string, extra: Record<string, unknown>, enabled = true) =>
    ({ pluginId, installed: true, enabled, ...extra });
  const sources: [string, Record<string, unknown>][] = [
    ["remote", { source: { source: "remote" } }], ["absent", {}], ["null", { source: null }],
    ["array", { source: [] }], ["string", { source: "local" }], ["number", { source: 3 }],
    ["empty object", { source: {} }], ["null kind", { source: { source: null } }],
    ["upper case", { source: { source: "LOCAL" } }], ["unknown kind", { source: { source: "future" } }],
  ];
  for (const [label, extra] of sources) {
    const inventory = parsePluginInventory(JSON.stringify({ installed: [
      row("l@m", { source: { source: "local" } }), row("x@m", extra),
    ] }));
    assert.deepEqual(inventory, { ok: true, enabled: ["l@m", "x@m"], remote: ["x@m"] }, label);
  }
  // A local row cannot hide a remote one, in either order.
  for (const rows of [
    [row("r@m", { source: { source: "local" } }), row("r@m", { source: { source: "remote" } })],
    [row("r@m", { source: { source: "remote" } }), row("r@m", { source: { source: "local" } })],
  ]) {
    assert.deepEqual(parsePluginInventory(JSON.stringify({ installed: rows })), { ok: true, enabled: ["r@m"], remote: ["r@m"] });
  }
  // Remote ids are a case-sensitive, deduplicated subset of the enabled ones.
  const inventory = parsePluginInventory(JSON.stringify({ installed: [
    row("Docs@m", {}), row("docs@m", { source: { source: "local" } }), row("Docs@m", {}),
    row("off@m", { source: { source: "remote" } }, false),
    { pluginId: "gone@m", installed: false, enabled: true, source: { source: "remote" } },
  ], available: [{ pluginId: "shop@m", installed: true, enabled: true, source: { source: "remote" } }] }));
  assert.deepEqual(inventory, { ok: true, enabled: ["Docs@m", "docs@m"], remote: ["Docs@m"] });
});

test("AC-2 (#189) a plugin listing that writes to stderr is incomplete and fails closed", async () => {
  calls = []; failures = {};
  pluginOutput = JSON.stringify({ installed: [
    { pluginId: "pdf@m", installed: true, enabled: true, source: { source: "local" } },
  ] });
  pluginStderr = "Warning: failed to list remote marketplace plugins: failed to send remote plugin catalog request\n";
  try {
    const result = await inspectInherited({ codexPath: process.execPath, cwd: tmpdir() });
    assert.equal(result.plugins?.ok, false);
    if (result.plugins?.ok !== false) return;
    assert.match(result.plugins.error, /failed to list remote marketplace plugins/);
    assert.equal(result.plugins.error.split(/\r?\n/).length, 1);
    const decided = resolved({ plugins: list("pdf@m"), pluginInventory: result.plugins });
    assert.equal(decided.disableAllPlugins, true);
    assert.deepEqual(decided.report.plugins, []);
    assert.match(lineOf(decided), /failed to list remote marketplace plugins/);
  } finally { pluginStderr = ""; }
});

test("AC-2 (#189) a plugin whose id is _default cannot be turned off by name", () => {
  const result = resolved({ plugins: list("a@m"), pluginInventory: remoteInventory(["a@m", "_default"], []) });
  assert.equal(result.disableAllPlugins, true);
  assert.deepEqual(result.disabledPlugins, []);
  assert.deepEqual(result.report.plugins, []);
  assert.ok(lineOf(result).includes(JSON.stringify("_default")), lineOf(result));
  // An MCP server may still be called _default.
  const mcp = resolved({ mcpServers: list("docs"), mcp: { ok: true, names: ["docs", "_default"] } });
  assert.deepEqual(mcp.disabledMcpServers, ["_default"]);
});

test("AC-2 (#189) competing fallback reasons both reach the note with every plugin lost", () => {
  const remote = "dot.remote@market";
  const result = resolved({ plugins: list("a@m", "b@m"), cliVersion: newerThanVerified,
    pluginInventory: remoteInventory(["a@m", "b@m", remote], [remote]) });
  assert.equal(result.disableAllPlugins, true);
  assert.deepEqual(result.disabledPlugins, []);
  assert.deepEqual(result.report.plugins, []);
  const line = lineOf(result);
  for (const id of ["a@m", "b@m", remote]) assert.ok(line.includes(JSON.stringify(id)), `${id}: ${line}`);
  assert.match(line, /cannot be turned off by name/);
  assert.ok(line.includes(newerThanVerified), line);
});

test("AC-2 (#189) a prerelease the preflight read never opens the window", () => {
  for (const banner of ["codex-cli 0.163.0-alpha.1", "codex-cli 0.163.0+build.5"]) {
    assert.equal(keepsRemotePluginsOutByName(parseVersion(banner), "0.163.0"), false, banner);
  }
  assert.equal(keepsRemotePluginsOutByName(parseVersion("codex-cli 0.163.0"), "0.163.0"), true);
});
