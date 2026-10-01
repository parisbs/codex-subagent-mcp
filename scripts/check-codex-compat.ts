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
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCodexArgs, type CodexInvocation } from "../src/codex/args.ts";
import { parseCatalog } from "../src/codex/catalog.ts";
import { parsePluginInventory } from "../src/codex/inherited.ts";
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
  }

  const mcpRun = run(["mcp", "list", "--json"]);
  try {
    if (mcpRun.status !== 0) throw new Error(errorLine(mcpRun));
    if (!Array.isArray(JSON.parse(mcpRun.stdout))) throw new Error("the output is not a JSON array");
  } catch (error) {
    failures.push(
      `Codex CLI ${version}: \`codex mcp list --json\` is unusable for the recursion guard: ` +
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

/** Runs the compatibility probes with a fresh, empty CODEX_HOME (#64). */
export function checkCompatibilityInEmptyHome(input: {
  version: string;
  newestVerified: string;
  run: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => CliRun;
}): Report {
  // An empty home: no login, no user config, no MCP servers, no plugins.
  const codexHome = mkdtempSync(join(tmpdir(), "codex-compat-home-"));
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
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
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
      : ["Every argv shape was accepted, the negative control was rejected, and the catalog, MCP and plugin listings parsed.", ""]),
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
  const report = checkCompatibilityInEmptyHome({ version, newestVerified: NEWEST_VERIFIED_CODEX_VERSION, run });
  writeSummary(report, binary);
  process.exitCode = report.failures.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
