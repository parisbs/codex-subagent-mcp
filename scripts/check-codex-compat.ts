/**
 * Checks a Codex CLI release against what this server builds and parses, with no
 * credentials and no quota (#99).
 *
 * Usage: node --import tsx scripts/check-codex-compat.ts <npm-prefix>
 *
 * The prefix is a directory where `@openai/codex` was installed with npm. The
 * check runs the platform package's native binary, never the `bin/codex.js`
 * wrapper or a `.cmd` shim, which is how this server resolves the CLI too
 * (ADR 11).
 *
 * What it relies on: appending `--help` makes the CLI parse every argument before
 * it and print help instead of running, so an argv it would reject exits 2 with
 * no model call and no login. A negative control — a flag the CLI has removed —
 * guards that assumption: if the CLI ever stops rejecting it, every other result
 * is untrustworthy and the check fails. Not covered, because they need an
 * authenticated run: the JSONL event stream, the session file and the
 * `login status` output. Those stay with `/smoke-test` (#98).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCodexArgs, type CodexInvocation } from "../src/codex/args.ts";
import { parseCatalog } from "../src/codex/catalog.ts";
import { DOCTOR_REPORT_ARGS } from "../src/codex/doctor-report.ts";
import { MCP_LIST_ARGS, parseMcpInventory, parsePluginInventory, resolveInheritance } from "../src/codex/inherited.ts";
import type { InheritPolicy } from "../src/config.ts";
import { NEWEST_VERIFIED_CODEX_VERSION, compareVersions, parseVersion } from "../src/codex/doctor.ts";
import { SANDBOX_MODES } from "../src/types.ts";

/** One argv the server can build, named for the report. */
export interface Shape {
  name: string;
  argv: string[];
}

/** What running the CLI once produced. */
export interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Report {
  version: string;
  failures: string[];
  notes: string[];
}

/**
 * An argv the CLI must reject. `--full-auto` was removed from `codex exec`
 * before 0.159.2 and is the flag that broke `codex-mcp-server` 1.4.10.
 */
export const NEGATIVE_CONTROL: string[] = ["exec", "--full-auto"];

/** Any id shaped like the ones Codex issues; `--help` never looks it up. */
const THREAD_ID = "01a0f348-1725-76c3-8bd5-a5f93ff09662";

/**
 * Every argv shape `buildCodexArgs` can produce, one option at a time plus the
 * combinations a caller actually sends. `test/codex-compat.test.ts` fails when
 * `src/codex/args.ts` gains an option none of these exercise.
 */
export function argvShapes(model: string, dir: string): Shape[] {
  const exec = (name: string, extra: Partial<CodexInvocation>): Shape => ({
    name: `exec ${name}`,
    argv: buildCodexArgs({ kind: "exec", sandbox: "read-only", ...extra }),
  });
  const resume = (name: string, extra: Partial<CodexInvocation>): Shape => ({
    name: `resume ${name}`,
    argv: buildCodexArgs({ kind: "resume", threadId: THREAD_ID, sandbox: "read-only", ...extra }),
  });
  // `--help` stops before the CLI reads the file, so the path need not exist.
  const outputSchemaPath = join(dir, "schema.json");
  const full: Partial<CodexInvocation> = {
    model,
    reasoningEffort: "low",
    workingDir: dir,
    addDirs: [dir],
    skipGitRepoCheck: true,
    disabledMcpServers: ["codex-subagent", "name with spaces"],
  };
  // What ADR 16 turns off: one plugin by id, every plugin, and apps.
  const inheritance: Partial<CodexInvocation> = {
    disabledPlugins: ["browser@openai-bundled"],
    disableAllPlugins: true,
    disableApps: true,
  };

  return [
    { name: "doctor report", argv: [...DOCTOR_REPORT_ARGS] },
    ...SANDBOX_MODES.map((sandbox) => exec(`sandbox ${sandbox}`, { sandbox })),
    exec("approve-for-me", { sandbox: "workspace-write", autoApprove: true }),
    exec("model and effort", { model, reasoningEffort: "low" }),
    exec("working dir and extra dir", { workingDir: dir, addDirs: [dir] }),
    exec("worktree", { useWorktree: true }),
    exec("web search", { webSearch: true }),
    exec("skip git repo check", { skipGitRepoCheck: true }),
    exec("ephemeral", { ephemeral: true }),
    exec("recursion guard", { disabledMcpServers: ["codex-subagent", "name with spaces"] }),
    exec("inherited tools off", { disabledMcpServers: ["docs"], ...inheritance }),
    exec("output schema", { outputSchemaPath }),
    exec("everything a delegation can combine", {
      ...full,
      ...inheritance,
      sandbox: "workspace-write",
      useWorktree: true,
      webSearch: true,
      outputSchemaPath,
    }),
    exec("everything with approve-for-me", { ...full, sandbox: "workspace-write", autoApprove: true }),
    resume("minimal", {}),
    resume("model and effort", { model, reasoningEffort: "low" }),
    resume("worktree", { useWorktree: true }),
    resume("output schema", { outputSchemaPath }),
    resume("inherited tools off", { disabledMcpServers: ["docs"], ...inheritance }),
    resume("everything a follow-up can combine", {
      model,
      reasoningEffort: "low",
      sandbox: "workspace-write",
      skipGitRepoCheck: true,
      disabledMcpServers: ["codex-subagent"],
      ...inheritance,
      outputSchemaPath,
    }),
  ];
}

/** The line a clap-based CLI prints to say what it rejected. */
function errorLine(run: CliRun): string {
  const text = `${run.stderr}\n${run.stdout}`;
  return (
    text.split(/\r?\n/).find((line) => /^\s*error:/i.test(line))?.trim() ??
    text.trim().split(/\r?\n/)[0] ??
    `exit ${run.status}`
  );
}

/**
 * Runs every check against one CLI. `run` executes the CLI with an empty
 * `CODEX_HOME`; the workflow passes a real process, the tests a stand-in.
 */
export function checkCompatibility(input: {
  version: string;
  newestVerified: string;
  dir: string;
  run: (args: string[]) => CliRun;
}): Report {
  const { version, newestVerified, dir, run } = input;
  const failures: string[] = [];
  const notes: string[] = [];

  // The catalog comes first: a real slug from it makes the argv realistic.
  let model = "catalog-model";
  const catalogRun = run(["debug", "models"]);
  try {
    if (catalogRun.status !== 0) throw new Error(errorLine(catalogRun));
    const models = parseCatalog(catalogRun.stdout);
    if (models.length === 0) throw new Error("it parsed to no models");
    model = models[0]!.slug;
    notes.push(`Catalog: ${models.length} models parsed from an empty CODEX_HOME.`);
  } catch (error) {
    failures.push(
      `Codex CLI ${version}: the catalog from \`codex debug models\` is unusable: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const shape of argvShapes(model, dir)) {
    const argv = [...shape.argv, "--help"];
    const result = run(argv);
    if (result.status !== 0) {
      failures.push(
        `Codex CLI ${version} rejects the ${shape.name} argv.\n` +
          `  argv: codex ${argv.join(" ")}\n  CLI: ${errorLine(result)}`,
      );
    }
  }

  const control = run([...NEGATIVE_CONTROL, "--help"]);
  if (control.status === 0) {
    failures.push(
      `Codex CLI ${version} accepted the negative control \`codex ${NEGATIVE_CONTROL.join(" ")} --help\`, ` +
        "so it no longer validates arguments before printing help and none of the argv results above can be trusted.",
    );
  } else if (control.status !== 2 || !control.stderr.includes(NEGATIVE_CONTROL.at(-1)!)) {
    // Only the CLI's own usage error (exit 2, naming the flag) proves it validated the argv; a
    // timeout or a crash proves nothing either way.
    failures.push(
      `Codex CLI ${version} did not reject the negative control \`codex ${NEGATIVE_CONTROL.join(" ")} --help\` ` +
        `as a usage error (exit ${control.status}: ${errorLine(control)}), so the argv results above are unconfirmed.`,
    );
  }

  const mcpRun = run(["mcp", "list", "--json"]);
  try {
    if (mcpRun.status !== 0) throw new Error(errorLine(mcpRun));
    const inventory = parseMcpInventory(mcpRun.stdout);
    if (!inventory.ok) throw new Error(inventory.error);
  } catch (error) {
    failures.push(
      `Codex CLI ${version}: \`codex mcp list --json\` is unusable for the recursion guard: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The listing ADR 16 relies on runs with plugins off; the CLI must accept that override there.
  const configServersRun = run(MCP_LIST_ARGS);
  try {
    if (configServersRun.status !== 0) throw new Error(errorLine(configServersRun));
    const inventory = parseMcpInventory(configServersRun.stdout);
    if (!inventory.ok) throw new Error(inventory.error);
  } catch (error) {
    failures.push(
      `Codex CLI ${version}: \`codex ${MCP_LIST_ARGS.join(" ")}\` is unusable for turning MCP servers off: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // ADR 16 turns plugins off by id, so the listing has to keep its shape.
  const pluginRun = run(["plugin", "list", "--json"]);
  try {
    if (pluginRun.status !== 0) throw new Error(errorLine(pluginRun));
    const inventory = parsePluginInventory(pluginRun.stdout);
    if (!inventory.ok) throw new Error(inventory.error);
  } catch (error) {
    failures.push(
      `Codex CLI ${version}: \`codex plugin list --json\` is unusable for turning plugins off: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const features = run(["features", "list"]);
  const worktrees = features.stdout.split(/\r?\n/).find((line) => /^worktrees\s/.test(line));
  notes.push(worktrees ? `Feature: ${worktrees.replace(/\s+/g, " ").trim()}.` : "Feature: `worktrees` is not listed.");

  if (compareVersions(version, newestVerified) > 0) {
    notes.push(
      `Codex CLI ${version} is newer than ${newestVerified}, the newest version verified with a real run. ` +
        "Run /smoke-test against it and record the result (see #98).",
    );
  }

  return { version, failures, notes };
}

/** MCP server names the read-back turns off one by one: each shape that once broke a key (#64). */
export const READBACK_SERVERS = ["plain", "with space", "at@sign", 'quo"te', "back\\slash", "café"];
const PROJECT_SERVER = "project server";
const MARKETPLACE = "readback";
/** A plugin with nothing in it, and one that provides an MCP server. */
const PLAIN_PLUGIN = `plain@${MARKETPLACE}`;
const PROVIDER_PLUGIN = `provider@${MARKETPLACE}`;
const PLUGIN_SERVER = "plugin server";
/** Listing never starts a server, so the command only has to be present. */
const UNUSED_COMMAND = "codex-readback-unused";

/** A TOML key for any string: a JSON string is a valid TOML basic string for these names and paths. */
const tomlKey = (key: string) => JSON.stringify(key);

/**
 * The overrides a delegation with these policies would pass, built by the server's own code from
 * an inventory, and kept to the ones that turn inherited tools off.
 */
function inheritanceOverrides(
  mcpServers: InheritPolicy,
  plugins: InheritPolicy,
  mcpNames: string[],
  pluginIds: string[],
): string[] {
  const resolved = resolveInheritance({
    mcpServers,
    plugins,
    apps: false,
    mcp: { ok: true, names: mcpNames },
    pluginInventory: { ok: true, enabled: pluginIds },
    selfNames: [],
  });
  if (!resolved.ok) throw new Error(resolved.reason);
  const argv = buildCodexArgs({
    kind: "exec",
    sandbox: "read-only",
    disabledMcpServers: resolved.disabledMcpServers,
    disabledPlugins: resolved.disabledPlugins,
    disableAllPlugins: resolved.disableAllPlugins,
    disableApps: resolved.disableApps,
  });
  const overrides: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    const value = argv[i + 1]!;
    if (argv[i] === "--config" && /^(mcp_servers|plugins|features)\./.test(value)) overrides.push("--config", value);
  }
  return overrides;
}

/**
 * Why a command that loads configuration failed. The CLI puts the reason under "Caused by:", after a
 * generic first line ("failed to load bootstrap configuration"), so the cause is kept with it.
 */
function loadError(result: CliRun): string {
  const lines = result.stderr.split(/\r?\n/);
  const caused = lines.findIndex((line) => line.trim() === "Caused by:");
  const cause = caused < 0 ? [] : lines.slice(caused + 1).map((line) => line.trim()).filter((line) => line.length > 0);
  return cause.length > 0 ? `${errorLine(result)} (${cause.join(" ")})` : errorLine(result);
}

/** Every server an MCP listing printed, and whether it is enabled; or why it could not be read. */
function serverStates(result: CliRun): Map<string, boolean> | string {
  if (result.status !== 0) return loadError(result);
  const inventory = parseMcpInventory(result.stdout);
  if (!inventory.ok) return inventory.error;
  const states = new Map<string, boolean>();
  for (const entry of JSON.parse(result.stdout) as { name: string; enabled?: unknown }[]) {
    if (typeof entry.enabled !== "boolean") return `it listed ${JSON.stringify(entry.name)} without a readable enabled state`;
    // A second row could contradict the first, and a map would keep only one of them.
    if (states.has(entry.name)) return `it listed ${JSON.stringify(entry.name)} more than once`;
    states.set(entry.name, entry.enabled);
  }
  return states;
}

/** Every installed plugin a plugin listing printed, and whether it is enabled; or why it could not be read. */
function pluginStates(result: CliRun): Map<string, boolean> | string {
  if (result.status !== 0) return loadError(result);
  const inventory = parsePluginInventory(result.stdout);
  if (!inventory.ok) return inventory.error;
  const states = new Map<string, boolean>();
  const listing = JSON.parse(result.stdout) as { installed: { pluginId: string; installed: boolean; enabled: boolean }[] };
  for (const entry of listing.installed) {
    if (states.has(entry.pluginId)) return `it listed ${JSON.stringify(entry.pluginId)} more than once`;
    // Turning a plugin off must leave it installed; one that disappeared is not "disabled".
    if (!entry.installed) return `it listed ${JSON.stringify(entry.pluginId)} as not installed`;
    states.set(entry.pluginId, entry.enabled);
  }
  return states;
}

/**
 * How a listing differs from what it should show, or null when it matches. The comparison is exact:
 * an entry the scratch home never defined is a difference too, so an override that turns off one
 * entry too many, or a listing that comes back empty, cannot pass.
 */
function mismatch(states: Map<string, boolean>, expected: [string, boolean | "absent"][]): string | null {
  const wrong = expected
    .filter(([name, want]) => (want === "absent" ? states.has(name) : states.get(name) !== want))
    .map(([name, want]) => {
      const actual = states.has(name) ? (states.get(name) ? "enabled" : "disabled") : "not listed";
      return `${JSON.stringify(name)} is ${actual}, expected ${want === "absent" ? "not listed" : want ? "enabled" : "disabled"}`;
    });
  const known = new Set(expected.map(([name]) => name));
  for (const [name, enabled] of states) {
    if (!known.has(name)) wrong.push(`${JSON.stringify(name)} is listed (${enabled ? "enabled" : "disabled"}), expected not listed`);
  }
  return wrong.length === 0 ? null : wrong.join("; ");
}

/**
 * Applies the inheritance overrides this server builds in a scratch CODEX_HOME that defines MCP
 * servers, a trusted project and a plugin from a local marketplace, and reads the result back
 * through the CLI's own listings (#129). `--help` proves an override is accepted, not that it loads
 * or turns off the entry it names.
 */
export function checkOverrideReadback(input: {
  version: string;
  run: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => CliRun;
}): Report {
  const { version } = input;
  const failures: string[] = [];
  const notes: string[] = [];
  const fail = (what: string, detail: string) => failures.push(`Codex CLI ${version}: ${what}: ${detail}`);

  const scratch = mkdtempSync(join(tmpdir(), "codex-readback-"));
  // Everything after the directory exists runs inside the try, resolving its path included, so a
  // failure at any step still removes it (AC-7). No test can make realpath fail without injecting
  // the file system, which this one line does not justify.
  try {
    // The real path: the CLI matches a trusted project against the resolved working directory.
    const root = realpathSync(scratch);
    const home = join(root, "home");
    const work = join(root, "work");
    const project = join(root, "project");
    const marketplace = join(root, "marketplace");
    for (const directory of [home, work, join(project, ".codex"), join(marketplace, ".agents", "plugins")]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(
      join(home, "config.toml"),
      [
        ...READBACK_SERVERS.map((name) => `[mcp_servers.${tomlKey(name)}]\ncommand = ${tomlKey(UNUSED_COMMAND)}\n`),
        `[projects.${tomlKey(project)}]\ntrust_level = "trusted"\n`,
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(project, ".codex", "config.toml"),
      `[mcp_servers.${tomlKey(PROJECT_SERVER)}]\ncommand = ${tomlKey(UNUSED_COMMAND)}\n`,
      "utf8",
    );
    const pluginNames = [PLAIN_PLUGIN, PROVIDER_PLUGIN].map((id) => id.split("@")[0]!);
    for (const name of pluginNames) {
      const directory = join(marketplace, "plugins", name);
      mkdirSync(join(directory, ".codex-plugin"), { recursive: true });
      writeFileSync(
        join(directory, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name, version: "0.0.1", description: "Compatibility check fixture." }),
        "utf8",
      );
    }
    writeFileSync(
      join(marketplace, "plugins", PROVIDER_PLUGIN.split("@")[0]!, ".mcp.json"),
      JSON.stringify({ mcpServers: { [PLUGIN_SERVER]: { command: UNUSED_COMMAND } } }),
      "utf8",
    );
    writeFileSync(
      join(marketplace, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: MARKETPLACE,
        plugins: pluginNames.map((name) => ({ name, source: { source: "local", path: `./plugins/${name}` } })),
      }),
      "utf8",
    );

    const env = { ...process.env, CODEX_HOME: home };
    const cli = (args: string[], cwd = work) => input.run(args, { cwd, env });
    const mcpList = (overrides: string[], cwd = work) => cli(["mcp", "list", "--json", ...overrides], cwd);
    const pluginList = (overrides: string[]) => cli(["plugin", "list", "--json", ...overrides]);
    const pluginsOff = MCP_LIST_ARGS.slice(3);
    const homeServers = READBACK_SERVERS.map((name): [string, boolean] => [name, true]);

    // Plugins first, so the MCP listings below show whether plugin servers leak into them.
    let plugins = true;
    for (const [what, args] of [
      ["add a local marketplace", ["plugin", "marketplace", "add", marketplace]],
      ...[PLAIN_PLUGIN, PROVIDER_PLUGIN].map((id) => [`install ${id} from it`, ["plugin", "add", id]] as const),
    ] as const) {
      const result = cli([...args]);
      if (result.status === 0) continue;
      plugins = false;
      if (result.status === 2 && /unrecognized subcommand/i.test(result.stderr)) {
        notes.push(
          `Codex CLI ${version} has no \`codex ${args.slice(0, -1).join(" ")}\`, so plugin overrides were not read back.`,
        );
      } else {
        fail(`could not ${what}, so plugin overrides were not read back`, errorLine(result));
      }
      break;
    }

    // MCP servers in the home, each turned off on its own as a delegation that allows the rest would.
    const baseline = serverStates(mcpList(pluginsOff));
    if (typeof baseline === "string") {
      fail(`\`codex ${MCP_LIST_ARGS.join(" ")}\` did not load the scratch configuration`, baseline);
    } else {
      const wrong = mismatch(baseline, [...homeServers, [PLUGIN_SERVER, "absent"]]);
      if (wrong) fail(`the MCP listing this server relies on is not what the configuration defines`, wrong);
      for (const name of READBACK_SERVERS) {
        const others = READBACK_SERVERS.filter((other) => other !== name);
        const overrides = inheritanceOverrides({ kind: "list", names: others }, { kind: "none" }, READBACK_SERVERS, []);
        const states = serverStates(mcpList(overrides));
        const problem = typeof states === "string"
          ? states
          : mismatch(states, READBACK_SERVERS.map((other): [string, boolean] => [other, other !== name]));
        if (problem) fail(`turning off MCP server ${JSON.stringify(name)} with \`${overrides.join(" ")}\` did not work`, problem);
      }
    }

    // A trusted project's own server, run from the project.
    const inProject = serverStates(mcpList(pluginsOff, project));
    if (typeof inProject === "string") {
      fail("the MCP listing did not load in a trusted project", inProject);
    } else if (mismatch(inProject, [[PROJECT_SERVER, true], ...homeServers])) {
      fail("the MCP listing in a trusted project is not what the configuration defines",
        mismatch(inProject, [[PROJECT_SERVER, true], ...homeServers])!);
    } else {
      const all = [PROJECT_SERVER, ...READBACK_SERVERS];
      const overrides = inheritanceOverrides({ kind: "list", names: READBACK_SERVERS }, { kind: "none" }, all, []);
      const states = serverStates(mcpList(overrides, project));
      const problem = typeof states === "string" ? states : mismatch(states, [[PROJECT_SERVER, false], ...homeServers]);
      if (problem) fail(`turning off the trusted project's MCP server with \`${overrides.join(" ")}\` did not work`, problem);
    }

    // The quoted key names an entry with literal quotes; if it ever turns the entry off, the
    // read-back can no longer tell a working override from a broken one.
    const quotedServer = `mcp_servers.${tomlKey("plain")}.enabled=false`;
    // Today it names a server nobody configured, which Codex refuses to load; any other outcome
    // leaves this control unverified.
    const quotedRun = mcpList([...pluginsOff, "--config", quotedServer]);
    const quoted = serverStates(quotedRun);
    if (typeof quoted === "string") {
      // Only the CLI refusing the configuration counts; output it printed but could not be read does not.
      const refused = quotedRun.status !== 0 && quotedRun.status !== null && /invalid transport/i.test(loadError(quotedRun));
      if (!refused) fail(`the quoted-key control \`${quotedServer}\` failed for another reason`, quoted);
    } else if (quoted.get("plain") === false) {
      fail(
        `the quoted key \`${quotedServer}\` turned the server off`,
        "the CLI changed how it reads quoted keys, so this check no longer tells a working override from a broken one",
      );
    } else {
      const wrong = mismatch(quoted, homeServers);
      if (wrong) fail(`the quoted-key control \`${quotedServer}\` loaded an unexpected listing`, wrong);
    }

    if (plugins) {
      const installed = pluginStates(pluginList([]));
      if (typeof installed === "string") {
        fail("`codex plugin list --json` did not load after installing plugins", installed);
      } else {
        const ids = [PLAIN_PLUGIN, PROVIDER_PLUGIN];
        const wrong = mismatch(installed, ids.map((id): [string, boolean] => [id, true]));
        if (wrong) fail("the installed plugins are not listed as enabled", wrong);
        for (const [label, allowed] of [["excludes", [PROVIDER_PLUGIN]], ["includes", ids]] as const) {
          const overrides = inheritanceOverrides({ kind: "all" }, { kind: "list", names: [...allowed] }, [], ids);
          const states = pluginStates(pluginList(overrides));
          const problem = typeof states === "string"
            ? states
            : mismatch(states, ids.map((id): [string, boolean] => [id, allowed.includes(id)]));
          if (problem) fail(`a plugin policy that ${label} ${PLAIN_PLUGIN} did not read back with \`${overrides.join(" ")}\``, problem);
        }

        const quotedPlugin = `plugins.${tomlKey(PLAIN_PLUGIN)}.enabled=false`;
        const quotedStates = pluginStates(pluginList(["--config", quotedPlugin]));
        if (typeof quotedStates === "string") {
          fail(`\`codex plugin list --json\` did not load with the quoted key \`${quotedPlugin}\``, quotedStates);
        } else if (quotedStates.get(PLAIN_PLUGIN) === false) {
          fail(
            `the quoted key \`${quotedPlugin}\` turned the plugin off`,
            "the CLI changed how it reads quoted keys, so this check no longer tells a working override from a broken one",
          );
        } else {
          const wrong = mismatch(quotedStates, ids.map((id): [string, boolean] => [id, true]));
          if (wrong) fail(`the quoted-key control \`${quotedPlugin}\` read back an unexpected listing`, wrong);
        }
      }

      // A plugin's MCP server: listed while the plugin is on, gone once the plugin is turned off.
      const withPlugins = serverStates(mcpList([]));
      if (typeof withPlugins === "string") {
        fail("the MCP listing did not load with plugins on", withPlugins);
      } else if (!withPlugins.has(PLUGIN_SERVER)) {
        fail(
          `the MCP listing with plugins on does not show ${JSON.stringify(PLUGIN_SERVER)}, which ${PROVIDER_PLUGIN} provides`,
          "turning the plugin off would prove nothing",
        );
      } else if (mismatch(withPlugins, [...homeServers, [PLUGIN_SERVER, true]])) {
        fail("the MCP listing with plugins on is not what the configuration and the plugin define",
          mismatch(withPlugins, [...homeServers, [PLUGIN_SERVER, true]])!);
      } else {
        const overrides = inheritanceOverrides({ kind: "all" }, { kind: "list", names: [PLAIN_PLUGIN] }, [], [PLAIN_PLUGIN, PROVIDER_PLUGIN]);
        const states = serverStates(mcpList(overrides));
        const problem = typeof states === "string" ? states : mismatch(states, [...homeServers, [PLUGIN_SERVER, "absent"]]);
        if (problem) fail(`turning off ${PROVIDER_PLUGIN} with \`${overrides.join(" ")}\` did not remove its MCP server`, problem);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { version, failures, notes };
}

/** Runs the compatibility probes with a fresh, empty CODEX_HOME (#64). */
export function checkCompatibilityInEmptyHome(input: {
  version: string;
  newestVerified: string;
  run: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => CliRun;
}): Report {
  // An empty home: no login, no user config, no MCP servers, no plugins. Each directory is removed
  // by a finally that starts as soon as it exists, so a failure creating the next cannot leak it.
  const codexHome = mkdtempSync(join(tmpdir(), "codex-compat-home-"));
  try {
    const dir = mkdtempSync(join(tmpdir(), "codex-compat-dir-"));
    try {
      const env = { ...process.env, CODEX_HOME: codexHome };
      return checkCompatibility({
        version: input.version,
        newestVerified: input.newestVerified,
        dir,
        run: (args) => input.run(args, { cwd: dir, env }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

/** Why a path is not the native CLI, or null when it is. */
export function shimProblem(path: string): string | null {
  const name = basename(path.replace(/\\/g, "/")).toLowerCase();
  if (/\.(cmd|bat|ps1)$/.test(name)) return `${path} is a shell shim; this server never runs the CLI through a shell.`;
  if (/\.(js|cjs|mjs)$/.test(name)) return `${path} is the npm wrapper script, not the native binary.`;
  return null;
}

/**
 * The native binary inside an npm prefix. `@openai/codex-<platform>` ships it at
 * `vendor/<target triple>/bin/codex` since at least 0.159.2, and at
 * `vendor/<target triple>/codex/codex` in 0.110.0 (`codex.exe` on Windows).
 */
export function findCodexBinary(prefix: string, platform: NodeJS.Platform = process.platform): string | null {
  const scope = join(prefix, "node_modules", "@openai");
  const executable = platform === "win32" ? "codex.exe" : "codex";
  for (const pkg of existsSync(scope) ? readdirSync(scope) : []) {
    const vendor = join(scope, pkg, "vendor");
    for (const triple of existsSync(vendor) ? readdirSync(vendor) : []) {
      for (const directory of ["bin", "codex"]) {
        const candidate = join(vendor, triple, directory, executable);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function writeSummary(report: Report, binary: string): void {
  const lines = [
    `## Codex CLI ${report.version} on ${process.platform}`,
    "",
    `Binary: \`${binary}\``,
    "",
    ...(report.failures.length > 0
      ? ["### Failures", "", ...report.failures.map((failure) => `- ${failure.replace(/\n/g, "\n  ")}`), ""]
      : [
          "Every argv shape was accepted, the negative control was rejected, the catalog, MCP and plugin listings " +
            "parsed, and the inheritance overrides read back as intended.",
          "",
        ]),
    ...report.notes.map((note) => `- ${note}`),
  ];
  const text = lines.join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`, "utf8");
}

function main(): void {
  const prefix = process.argv[2];
  if (!prefix) {
    console.error("usage: check-codex-compat <npm prefix where @openai/codex is installed>");
    process.exit(2);
  }
  const binary = findCodexBinary(prefix);
  if (!binary) {
    console.error(`check-codex-compat: no native Codex binary under ${prefix}/node_modules/@openai/*/vendor`);
    process.exit(1);
  }
  const shim = shimProblem(binary);
  if (shim) {
    console.error(`check-codex-compat: ${shim}`);
    process.exit(1);
  }

  const run = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): CliRun => {
    const result = spawnSync(binary, args, {
      shell: false,
      encoding: "utf8",
      timeout: 60_000,
      cwd: options.cwd,
      env: options.env,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.error
        ? `error: ${result.error.message}`
        : result.signal
          ? `error: killed by ${result.signal}`
          : (result.stderr ?? ""),
    };
  };

  // `--version` reads no configuration, but runs in an empty home all the same.
  const versionHome = mkdtempSync(join(tmpdir(), "codex-compat-version-"));
  let versionRun: CliRun;
  try {
    versionRun = run(["--version"], { cwd: versionHome, env: { ...process.env, CODEX_HOME: versionHome } });
  } finally {
    rmSync(versionHome, { recursive: true, force: true });
  }
  const version = parseVersion(versionRun.stdout);
  if (!version) {
    console.error(
      `check-codex-compat: could not read a version from ${binary} --version ` +
        `(exit ${versionRun.status}): ${errorLine(versionRun)}`,
    );
    process.exitCode = 1;
    return;
  }
  const compatibility = checkCompatibilityInEmptyHome({ version, newestVerified: NEWEST_VERIFIED_CODEX_VERSION, run });
  const readback = checkOverrideReadback({ version, run });
  const report: Report = {
    version,
    failures: [...compatibility.failures, ...readback.failures],
    notes: [...compatibility.notes, ...readback.notes],
  };
  writeSummary(report, binary);
  process.exitCode = report.failures.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
