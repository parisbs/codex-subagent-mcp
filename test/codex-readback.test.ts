import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";

import { checkOverrideReadback, type CliRun, type Report } from "../scripts/check-codex-compat.ts";

/**
 * The override read-back stage of the compatibility check (#129). The real CLI runs in
 * `.github/workflows/codex-compat.yml`; here a simulated CLI stands in for it. The simulation
 * reproduces what codex-cli 0.159.2 did on 2026-10-01 in a scratch CODEX_HOME:
 *
 * - `-c` splits the key on dots and reads quotes literally, so `mcp_servers."a".enabled=false`
 *   names a server called `"a"`, quotes included.
 * - Overriding a server that is not configured adds an entry with no transport, and every command
 *   that loads configuration fails with "invalid transport". A server a plugin provides is not
 *   configured, so turning it off by name fails the same way.
 * - Overriding a plugin that is not installed changes nothing and says nothing.
 * - `features.plugins=false` hides every plugin and the MCP servers they provide.
 * - A project's `.codex/config.toml` counts only when the home trusts the project and the command
 *   runs from it.
 * - A plugin installs from a local marketplace directory with no network or login.
 *
 * Each option breaks one of these, so a stage that does not read its results back fails a test.
 */

interface Simulation {
  /** This server's override for the named MCP server is accepted but changes nothing. */
  ignoreMcpOverride?: (name: string, fromProject: boolean) => boolean;
  /** Every `mcp list` fails to load configuration. */
  mcpListFails?: boolean;
  /** Quoted keys are unquoted, so the quoted form turns the entry off. */
  acceptQuotedKeys?: "mcp" | "plugins";
  /** Per-plugin overrides change nothing. */
  ignorePluginOverride?: boolean;
  /** Installed plugins report as disabled whatever the overrides say. */
  pluginsStartDisabled?: boolean;
  /** `features.plugins=false` no longer hides the servers plugins provide. */
  pluginServersIgnoreFeatureSwitch?: boolean;
  /** Turning a plugin off leaves its servers listed. */
  pluginOverrideKeepsServers?: boolean;
  /** `mcp list` fails to load whenever a plugin is turned off by id. */
  pluginOverrideBreaksMcpList?: boolean;
  /** Plugins install, but the servers they provide are never listed. */
  pluginServersNeverListed?: boolean;
  /** A subcommand this CLI release does not have. */
  missingCommand?: "marketplace" | "add";
  /** `plugin add` fails for a reason other than a missing command. */
  pluginAddFails?: boolean;
  /** The process runner itself throws on this invocation. */
  throwOn?: (args: string[]) => boolean;
  /** A listing with an MCP override also shows a disabled server nobody configured. */
  extraServerWithOverrides?: boolean;
  /** An MCP listing with a plugin turned off by id comes back empty. */
  pluginOverrideEmptiesMcpList?: boolean;
  /** The quoted MCP control fails for a reason other than the quoted key. */
  quotedControlTimesOut?: boolean;
  /** Every MCP listing prints each server twice, the first row with the opposite state. */
  duplicateRows?: boolean;
  /** A plugin turned off is listed as no longer installed. */
  disablingUninstalls?: boolean;
  /** The quoted MCP control exits 0 with a listing that cannot be read. */
  quotedControlUnreadable?: boolean;
}

interface Call {
  args: string[];
  cwd: string;
  home: string | undefined;
  command: string;
  /** The subcommand words and their positional arguments, without options. */
  words: string[];
  status: number | null;
  /** Server names an override turned off, as this CLI read them. */
  mcpDisabled: string[];
  /** Plugin ids an override turned off, as this CLI read them. */
  pluginsDisabled: string[];
  pluginsOff: boolean;
  /** MCP servers that came from a trusted project's config for this call. */
  projectServers: string[];
  /** For `mcp list`: the servers listed and their state. */
  listedServers?: { name: string; enabled: boolean }[];
  /** For `plugin list`: the plugins listed and their state. */
  listedPlugins?: { pluginId: string; enabled: boolean }[];
}

const ok = (stdout = ""): CliRun => ({ status: 0, stdout, stderr: "" });
const fail = (status: number, stderr: string): CliRun => ({ status, stdout: "", stderr });

/** Splits a TOML key path (`a."b c".'d'`) into its keys, or null when it is not valid TOML. */
function parseKeyPath(text: string): string[] | null {
  const keys: string[] = [];
  let i = 0;
  const skip = () => { while (text[i] === " " || text[i] === "\t") i++; };
  while (true) {
    skip();
    if (text[i] === '"') {
      let key = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          const next = text[i + 1];
          const simple: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
          if (next !== undefined && next in simple) { key += simple[next]; i += 2; continue; }
          const width = next === "u" ? 4 : next === "U" ? 8 : 0;
          const hex = text.slice(i + 2, i + 2 + width);
          if (width === 0 || !/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) return null;
          key += String.fromCodePoint(parseInt(hex, 16));
          i += 2 + width;
          continue;
        }
        key += text[i];
        i++;
      }
      if (text[i] !== '"') return null;
      i++;
      keys.push(key);
    } else if (text[i] === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      keys.push(text.slice(i + 1, end));
      i = end + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!match) return null;
      keys.push(match[0]);
      i += match[0].length;
    }
    skip();
    if (i === text.length) return keys;
    if (text[i] !== ".") return null;
    i++;
  }
}

interface Toml { tables: { path: string[]; values: Record<string, string> }[] }

/** Enough TOML for a config file: tables and string or bare values. Null when it does not parse. */
function readToml(file: string): Toml | null {
  if (!existsSync(file)) return { tables: [] };
  const tables: Toml["tables"] = [{ path: [], values: {} }];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      if (line.startsWith("[[") || !line.endsWith("]")) return null;
      const path = parseKeyPath(line.slice(1, -1));
      if (!path) return null;
      tables.push({ path, values: {} });
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) return null;
    const key = parseKeyPath(line.slice(0, eq));
    if (!key || key.length !== 1) return null;
    const value = line.slice(eq + 1).trim();
    const literal = /^'([^']*)'$/.exec(value);
    const basic = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
    const decoded = literal ? literal[1]! : basic ? parseKeyPath(`"${basic[1]}"`)?.[0] : value;
    if (decoded === undefined) return null;
    tables.at(-1)!.values[key[0]!] = decoded;
  }
  return { tables };
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function simulatedCli(sim: Simulation = {}) {
  const calls: Call[] = [];
  const marketplaces = new Map<string, { root: string; plugins: { name: string; path: string }[] }>();
  const installed = new Map<string, { servers: string[] }>();
  const seenPaths = new Set<string>();

  const run = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): CliRun => {
    if (sim.throwOn?.(args)) throw new Error("simulated spawn failure");
    const home = options.env.CODEX_HOME;
    seenPaths.add(options.cwd);
    if (home) seenPaths.add(home);

    // Global options may appear anywhere; everything else is the command.
    const overrides: string[] = [];
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "-c" || arg === "--config") overrides.push(args[++i] ?? "");
      else if (arg === "--disable") overrides.push(`features.${args[++i] ?? ""}=false`);
      else if (arg === "--enable") overrides.push(`features.${args[++i] ?? ""}=true`);
      else positional.push(arg);
    }
    // Words without options; options that take a value consume it.
    const words: string[] = [];
    const valued: Record<string, string> = {};
    for (let i = 0; i < positional.length; i++) {
      const arg = positional[i]!;
      if (["--marketplace", "--ref", "--sparse"].includes(arg)) valued[arg] = positional[++i] ?? "";
      else if (!arg.startsWith("-")) words.push(arg);
    }
    const command = words.slice(0, words[0] === "plugin" && words[1] === "marketplace" ? 3 : 2).join(" ");
    const call: Call = {
      args, cwd: options.cwd, home, command, words, status: null,
      mcpDisabled: [], pluginsDisabled: [], pluginsOff: false, projectServers: [],
    };
    calls.push(call);
    const done = (result: CliRun): CliRun => { call.status = result.status; return result; };

    if (["exec", "e", "review", "resume"].includes(words[0] ?? "")) {
      return done(ok("Usage: codex exec [OPTIONS] [PROMPT]"));
    }
    if (positional.includes("--version")) return done(ok("codex-cli 0.159.2\n"));

    // Configuration: the home, then a trusted project's own file when run from it.
    const homeConfig = home ? readToml(join(home, "config.toml")) : { tables: [] };
    if (!homeConfig) return done(fail(1, "Error loading configuration: TOML parse error in config.toml\n"));
    const servers = new Map<string, { fromProject: boolean; valid: boolean }>();
    for (const table of homeConfig.tables) {
      if (table.path[0] === "mcp_servers" && table.path.length === 2) {
        servers.set(table.path[1]!, { fromProject: false, valid: "command" in table.values || "url" in table.values });
      }
    }
    const trusted = homeConfig.tables.some((table) =>
      table.path[0] === "projects" && table.path.length === 2 && table.values.trust_level === "trusted" &&
      sameDirectory(table.path[1]!, options.cwd));
    if (trusted) {
      seenPaths.add(join(options.cwd, ".codex"));
      const projectConfig = readToml(join(options.cwd, ".codex", "config.toml"));
      if (!projectConfig) return done(fail(1, "Error loading configuration: TOML parse error in .codex/config.toml\n"));
      for (const table of projectConfig.tables) {
        if (table.path[0] === "mcp_servers" && table.path.length === 2) {
          servers.set(table.path[1]!, { fromProject: true, valid: "command" in table.values || "url" in table.values });
          call.projectServers.push(table.path[1]!);
        }
      }
    }

    // Overrides, read the way the CLI reads them: split on dots, quotes kept.
    const unquote = (key: string) => key.replace(/^"(.*)"$/, "$1");
    for (const override of overrides) {
      const eq = override.indexOf("=");
      const path = override.slice(0, eq).split(".");
      const value = override.slice(eq + 1);
      if (path[0] === "features" && path[1] === "plugins" && value === "false") call.pluginsOff = true;
      if (path[0] === "mcp_servers" && path.length >= 3) {
        const name = sim.acceptQuotedKeys === "mcp" ? unquote(path[1]!) : path[1]!;
        const server = servers.get(name);
        if (!server) servers.set(name, { fromProject: false, valid: false });
        else if (path.slice(2).join(".") === "enabled" && value === "false" &&
          !sim.ignoreMcpOverride?.(name, server.fromProject)) {
          call.mcpDisabled.push(name);
        }
      }
      if (path[0] === "plugins" && path.length >= 3 && path.slice(2).join(".") === "enabled" && value === "false") {
        const id = sim.acceptQuotedKeys === "plugins" ? unquote(path[1]!) : path[1]!;
        if (installed.has(id) && !sim.ignorePluginOverride) call.pluginsDisabled.push(id);
      }
    }
    const loads = (): CliRun | null => {
      const broken = [...servers].find(([, server]) => !server.valid);
      return broken
        ? fail(1, `Error: failed to load bootstrap configuration\n\nCaused by:\n    invalid transport\n    in \`mcp_servers.${broken[0]}\`\n`)
        : null;
    };
    const pluginEnabled = (id: string) =>
      !call.pluginsOff && !sim.pluginsStartDisabled && !call.pluginsDisabled.includes(id);

    if (command === "mcp list") {
      if (sim.mcpListFails) return done(fail(1, "Error: failed to load bootstrap configuration\n"));
      if (sim.quotedControlTimesOut && overrides.some((override) => /^mcp_servers\."/.test(override))) {
        return done({ status: null, stdout: "", stderr: "error: spawnSync codex ETIMEDOUT\n" });
      }
      if (sim.quotedControlUnreadable && overrides.some((override) => /^mcp_servers\."/.test(override))) {
        return done(ok(JSON.stringify([{ name: "invalid transport" }])));
      }
      if (sim.pluginOverrideEmptiesMcpList && call.pluginsDisabled.length > 0) {
        call.listedServers = [];
        return done(ok("[]"));
      }
      if (sim.pluginOverrideBreaksMcpList && call.pluginsDisabled.length > 0) {
        return done(fail(1, "Error: failed to load bootstrap configuration\n"));
      }
      const failure = loads();
      if (failure) return done(failure);
      const listed = [...servers].map(([name]) => ({ name, enabled: !call.mcpDisabled.includes(name) }));
      if (!sim.pluginServersNeverListed) {
        for (const [id, plugin] of installed) {
          const hiddenBySwitch = call.pluginsOff && !sim.pluginServersIgnoreFeatureSwitch;
          const hiddenById = call.pluginsDisabled.includes(id) && !sim.pluginOverrideKeepsServers;
          if (hiddenBySwitch || hiddenById) continue;
          for (const name of plugin.servers) listed.push({ name, enabled: true });
        }
      }
      if (sim.extraServerWithOverrides && call.mcpDisabled.length > 0) listed.push({ name: "unconfigured", enabled: false });
      listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      call.listedServers = listed;
      const rows = sim.duplicateRows ? listed.flatMap((row) => [{ ...row, enabled: !row.enabled }, row]) : listed;
      return done(ok(JSON.stringify(rows.map(({ name, enabled }) => ({
        name, enabled, disabled_reason: null, transport: { type: "stdio", command: "x", args: [] },
      })), null, 2)));
    }

    if (command === "plugin list") {
      const failure = loads();
      if (failure) return done(failure);
      const plugins = call.pluginsOff ? [] : [...installed.keys()].map((pluginId) => ({ pluginId, enabled: pluginEnabled(pluginId) }));
      call.listedPlugins = plugins;
      return done(ok(JSON.stringify({
        installed: plugins.map(({ pluginId, enabled }) => ({
          pluginId, name: pluginId.split("@")[0], marketplaceName: pluginId.split("@")[1], version: "0.0.1",
          installed: !(sim.disablingUninstalls && !enabled), enabled, installPolicy: "AVAILABLE", authPolicy: "ON_INSTALL",
        })),
        available: [],
      }, null, 2)));
    }

    if (command === "plugin marketplace add") {
      if (sim.missingCommand === "marketplace") {
        return done(fail(2, "error: unrecognized subcommand 'marketplace'\n\nUsage: codex plugin [OPTIONS] <COMMAND>\n\nFor more information, try '--help'.\n"));
      }
      const source = words[3];
      if (!source) return done(fail(2, "error: the following required arguments were not provided:\n  <SOURCE>\n"));
      const root = isAbsolute(source) ? source : resolve(options.cwd, source);
      seenPaths.add(root);
      const manifestPath = [join(root, ".agents", "plugins", "marketplace.json"), join(root, ".claude-plugin", "marketplace.json")]
        .find((candidate) => existsSync(candidate));
      if (!manifestPath) return done(fail(1, `Error: failed to read marketplace file in ${root}\n`));
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name: string; plugins: { name: string; source: string | { source: string; path: string } }[];
      };
      marketplaces.set(manifest.name, {
        root,
        plugins: manifest.plugins.map((plugin) => ({
          name: plugin.name,
          path: resolve(root, typeof plugin.source === "string" ? plugin.source : plugin.source.path),
        })),
      });
      return done(ok(`Added marketplace \`${manifest.name}\` from ${root}.\n`));
    }

    if (command === "plugin add") {
      if (sim.missingCommand === "add") {
        return done(fail(2, "error: unrecognized subcommand 'add'\n\nUsage: codex plugin [OPTIONS] <COMMAND>\n\nFor more information, try '--help'.\n"));
      }
      const selector = words[2] ?? "";
      const [name, market] = selector.includes("@") ? selector.split("@") : [selector, valued["--marketplace"]];
      if (sim.pluginAddFails) return done(fail(1, `Error: failed to install plugin \`${selector}\`: cache is read-only\n`));
      const plugin = marketplaces.get(market ?? "")?.plugins.find((entry) => entry.name === name);
      if (!plugin) return done(fail(1, `Error: plugin \`${selector}\` was not found\n`));
      const serverNames = new Set<string>();
      const mcpFile = join(plugin.path, ".mcp.json");
      if (existsSync(mcpFile)) {
        for (const server of Object.keys((JSON.parse(readFileSync(mcpFile, "utf8")) as { mcpServers?: object }).mcpServers ?? {})) serverNames.add(server);
      }
      const manifestFile = join(plugin.path, ".codex-plugin", "plugin.json");
      if (existsSync(manifestFile)) {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { mcpServers?: unknown };
        if (manifest.mcpServers && typeof manifest.mcpServers === "object") {
          for (const server of Object.keys(manifest.mcpServers)) serverNames.add(server);
        }
      }
      installed.set(`${name}@${market}`, { servers: [...serverNames] });
      return done(ok(`Added plugin \`${name}\` from marketplace \`${market}\`.\n`));
    }

    return done(ok(""));
  };

  return { run, calls, seenPaths, installed };
}

const VERSION = "0.159.2";
const NAMES = ["plain", "with space", "at@sign", 'quo"te', "back\\slash", "café"];

function readback(sim: Simulation = {}, version = VERSION) {
  const cli = simulatedCli(sim);
  const report: Report = checkOverrideReadback({ version, run: cli.run });
  return { report, ...cli };
}

/** A failure names an entry however it is quoted. */
const names = (failure: string, name: string) =>
  failure.includes(name) || failure.includes(JSON.stringify(name).slice(1, -1));

const mcpLists = (calls: Call[]) => calls.filter((call) => call.command === "mcp list");
const pluginLists = (calls: Call[]) => calls.filter((call) => call.command === "plugin list");

test("AC-1 (#129) a healthy CLI passes, and each of the six servers was turned off on its own", () => {
  const { report, calls } = readback();
  assert.deepEqual(report.failures, []);
  for (const name of NAMES) {
    assert.ok(
      mcpLists(calls).some((call) => call.status === 0 && call.pluginsOff &&
        call.mcpDisabled.length === 1 && call.mcpDisabled[0] === name),
      `no listing with plugins off turned off only ${JSON.stringify(name)} and loaded`,
    );
  }
});

for (const name of NAMES) {
  test(`AC-1 (#129) fails when the override for ${JSON.stringify(name)} turns nothing off`, () => {
    const { report } = readback({ ignoreMcpOverride: (server) => server === name }, "0.160.0");
    assert.ok(report.failures.some((failure) => names(failure, name) && failure.includes("0.160.0")),
      report.failures.join("\n") || "no failure");
  });
}

test("AC-1 (#129) fails with the CLI's error when the MCP listing does not load", () => {
  const { report } = readback({ mcpListFails: true });
  assert.ok(report.failures.some((failure) => /failed to load bootstrap configuration/.test(failure)),
    report.failures.join("\n") || "no failure");
});

test("AC-1 (#129) builds its overrides with the same functions a delegation uses", () => {
  const source = readFileSync(new URL("../scripts/check-codex-compat.ts", import.meta.url), "utf8");
  assert.match(source, /\bresolveInheritance\(/);
  assert.match(source, /\bbuildCodexArgs\(/);
});

test("AC-2 (#129) turns off a trusted project's own MCP server when run from the project", () => {
  const { report, calls } = readback();
  assert.deepEqual(report.failures, []);
  assert.ok(
    mcpLists(calls).some((call) => call.status === 0 && call.projectServers.length > 0 &&
      call.mcpDisabled.length === 1 && call.projectServers.includes(call.mcpDisabled[0]!)),
    "no listing run from a trusted project turned off only its server",
  );
});

test("AC-2 (#129) fails when a trusted project's server ignores its override", () => {
  const { report } = readback({ ignoreMcpOverride: (_name, fromProject) => fromProject });
  assert.ok(report.failures.length > 0, "no failure");
});

test("AC-3 (#129) reads a local-marketplace plugin back as disabled when excluded and enabled when included", () => {
  const { report, calls, installed } = readback();
  assert.deepEqual(report.failures, []);
  assert.ok(installed.size > 0, "no plugin was installed");
  assert.ok(
    pluginLists(calls).some((call) => call.status === 0 && !call.pluginsOff && call.pluginsDisabled.length > 0 &&
      call.listedPlugins!.some((plugin) => call.pluginsDisabled.includes(plugin.pluginId) && !plugin.enabled)),
    "no plugin listing showed a plugin turned off by id",
  );
  assert.ok(
    pluginLists(calls).some((call) => call.status === 0 && !call.pluginsOff &&
      call.listedPlugins!.some((plugin) => plugin.enabled)),
    "no plugin listing showed an allowed plugin enabled",
  );
});

test("AC-3 (#129) fails when turning a plugin off by id changes nothing", () => {
  const { report } = readback({ ignorePluginOverride: true });
  assert.ok(report.failures.some((failure) => /plugin/i.test(failure)), report.failures.join("\n") || "no failure");
});

test("AC-3 (#129) fails when an allowed plugin does not read back as enabled", () => {
  const { report } = readback({ pluginsStartDisabled: true });
  assert.ok(report.failures.some((failure) => /plugin/i.test(failure)), report.failures.join("\n") || "no failure");
});

for (const [label, sim] of [
  ["the server's own MCP listing still shows a plugin's server", { pluginServersIgnoreFeatureSwitch: true }],
  ["turning the plugin off leaves its server listed", { pluginOverrideKeepsServers: true }],
  ["the MCP listing does not load with the plugin turned off", { pluginOverrideBreaksMcpList: true }],
  ["the plugin's server is never listed, so its removal proves nothing", { pluginServersNeverListed: true }],
] as const) {
  test(`AC-4 (#129) fails when ${label}`, () => {
    const { report } = readback(sim);
    assert.ok(report.failures.length > 0, "no failure");
  });
}

test("AC-5 (#129) a healthy run tries the quoted form of both overrides", () => {
  const { report, calls } = readback();
  assert.deepEqual(report.failures, []);
  const quoted = (pattern: RegExp) => calls.some(({ args }) =>
    args.some((arg, i) => pattern.test(arg) && (args[i - 1] === "-c" || args[i - 1] === "--config")));
  assert.ok(quoted(/^mcp_servers\."[^"]*"\.enabled=false$/), "the quoted MCP override was never tried");
  assert.ok(quoted(/^plugins\."[^"]*"\.enabled=false$/), "the quoted plugin override was never tried");
});

for (const kind of ["mcp", "plugins"] as const) {
  test(`AC-5 (#129) fails when the quoted ${kind} key turns its entry off`, () => {
    const { report } = readback({ acceptQuotedKeys: kind });
    assert.ok(report.failures.some((failure) => /quot/i.test(failure)), report.failures.join("\n") || "no failure");
  });
}

for (const missing of ["marketplace", "add"] as const) {
  test(`AC-6 (#129) a CLI without \`plugin ${missing}\` gets a note naming its version, not a failure`, () => {
    const { report, calls } = readback({ missingCommand: missing }, "0.154.0");
    assert.deepEqual(report.failures, []);
    assert.ok(report.notes.some((note) => note.includes("0.154.0") && /plugin/i.test(note)), report.notes.join("\n"));
    assert.ok(mcpLists(calls).some((call) => call.status === 0 && call.mcpDisabled[0] === "plain"),
      "the MCP checks did not run");
  });
}

test("AC-6 (#129) any other failure to install the plugin is a failure", () => {
  const { report } = readback({ pluginAddFails: true }, "0.154.0");
  assert.ok(report.failures.some((failure) => /plugin/i.test(failure) && failure.includes("0.154.0")),
    report.failures.join("\n") || "no failure");
});

test("AC-7 (#129) runs everything in one scratch home under the temp directory and makes no model call", () => {
  const { report, calls } = readback();
  assert.deepEqual(report.failures, []);
  const homes = new Set(calls.map((call) => call.home));
  assert.equal(homes.size, 1);
  const [home] = homes;
  assert.ok(home);
  assert.notEqual(home, process.env.CODEX_HOME);
  const temp = [tmpdir(), realpathSync(tmpdir())];
  for (const path of [home, ...calls.map((call) => call.cwd)]) {
    assert.ok(temp.some((root) => resolve(path).startsWith(root)), `${path} is outside the temp directory`);
  }
  for (const { args, words } of calls) {
    assert.ok(!(["exec", "e", "review", "resume"].includes(words[0] ?? "") && !args.includes("--help")),
      `model call: codex ${args.join(" ")}`);
  }
});

test("AC-7 (#129) removes the scratch home, project and marketplace afterwards", () => {
  const { seenPaths } = readback();
  assert.ok(seenPaths.size > 0);
  for (const path of seenPaths) assert.equal(existsSync(path), false, `${path} was left behind`);
});

test("AC-7 (#129) removes them also when a step throws", () => {
  const cli = simulatedCli({
    throwOn: (args) => args.includes("plugin") && args.includes("add") && !args.includes("marketplace"),
  });
  try {
    checkOverrideReadback({ version: VERSION, run: cli.run });
  } catch {
    // Either a report or an exception is acceptable; leftovers are not.
  }
  assert.ok(cli.seenPaths.size > 0);
  for (const path of cli.seenPaths) assert.equal(existsSync(path), false, `${path} was left behind`);
});

test("AC-7 (#129) the CLI entry point runs the read-back stage", () => {
  const source = readFileSync(new URL("../scripts/check-codex-compat.ts", import.meta.url), "utf8");
  assert.match(source.slice(source.indexOf("function main(")), /checkOverrideReadback\(/);
});

test("AC-1 (#129) fails when a read-back also shows a disabled server the scratch home never defined", () => {
  const { report } = readback({ extraServerWithOverrides: true });
  assert.ok(report.failures.some((failure) => failure.includes("unconfigured")), report.failures.join("\n") || "no failure");
});

test("AC-4 (#129) fails when the MCP listing comes back empty with the plugin turned off", () => {
  const { report } = readback({ pluginOverrideEmptiesMcpList: true });
  assert.ok(report.failures.length > 0, "no failure");
});

test("AC-5 (#129) fails when the quoted MCP control fails for another reason", () => {
  const { report } = readback({ quotedControlTimesOut: true });
  assert.ok(report.failures.some((failure) => /ETIMEDOUT/.test(failure)), report.failures.join("\n") || "no failure");
});

test("AC-1 (#129) fails when a listing repeats a server with contradicting states", () => {
  const { report } = readback({ duplicateRows: true });
  assert.ok(report.failures.some((failure) => /more than once/.test(failure)), report.failures.join("\n") || "no failure");
});

test("AC-3 (#129) fails when turning a plugin off lists it as no longer installed", () => {
  const { report } = readback({ disablingUninstalls: true });
  assert.ok(report.failures.some((failure) => /not installed/.test(failure)), report.failures.join("\n") || "no failure");
});

test("AC-5 (#129) fails when the quoted MCP control prints a listing it cannot read", () => {
  const { report } = readback({ quotedControlUnreadable: true });
  assert.ok(report.failures.some((failure) => /quoted/.test(failure)), report.failures.join("\n") || "no failure");
});
