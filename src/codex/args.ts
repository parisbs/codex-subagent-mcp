import type { ReasoningEffort, SandboxMode } from "../types.js";

export interface CodexInvocation {
  /** Subcommand shape: a fresh `codex exec` run or a resumed thread. */
  kind: "exec" | "resume";
  /** Required when `kind` is "resume". */
  threadId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandbox: SandboxMode;
  /** Adds `--approve-for-me`; only meaningful when the sandbox allows writes. */
  autoApprove?: boolean;
  workingDir?: string;
  addDirs?: string[];
  useWorktree?: boolean;
  webSearch?: boolean;
  skipGitRepoCheck?: boolean;
  /** Runs without persisting a session file; disables follow-ups. */
  ephemeral?: boolean;
  /** Codex MCP entries that point back at this server, switched off for this run. */
  disabledMcpServers?: string[];
  /** Installed Codex plugins switched off for this run (ADR 16). */
  disabledPlugins?: string[];
  /** Switches every Codex plugin off for this run (ADR 16). */
  disableAllPlugins?: boolean;
  /** Switches Codex's apps off for this run (ADR 16). */
  disableApps?: boolean;
  /** Absolute path of a JSON Schema file for `--output-schema` (#28). */
  outputSchemaPath?: string;
}

/**
 * Whether a name can be addressed in a `-c` path.
 *
 * Verified against codex-cli 0.159.2: the CLI splits the path on dots and the override on its first
 * `=`, and reads TOML quotes literally, so a quoted key names an entry whose name includes the
 * quotes — for an MCP server, one with no transport, and Codex refuses to start. A raw segment
 * works for anything else, spaces, quotes, backslashes and `@` included; a name with a dot or `=`
 * cannot be addressed at all, and callers must fail closed instead (ADR 16).
 */
export function addressableInConfigPath(name: string): boolean {
  return name.length > 0 && !/[.=]/.test(name);
}

function configPathArg(table: string, name: string): string {
  if (!addressableInConfigPath(name)) {
    throw new Error(
      `${table} entry ${JSON.stringify(name)} cannot be turned off for one run: Codex cannot address a ` +
        "name with a dot or \"=\" in a config override.",
    );
  }
  return `${table}.${name}.enabled=false`;
}

/**
 * Switches off Codex MCP entries for one run, so a delegation cannot call this server again, nor
 * any server the user did not allow (ADR 16).
 *
 * Verified against codex-cli 0.154.0: `-c mcp_servers.<name>.enabled=false` keeps the entry from
 * starting, on `exec` and on `exec resume`.
 */
function disableMcpServerArgs(names: string[] | undefined): string[] {
  return (names ?? []).flatMap((name) => ["--config", configPathArg("mcp_servers", name)]);
}

/**
 * Switches off the plugins and apps a run would inherit from the user's Codex setup (ADR 16).
 *
 * Verified against codex-cli 0.159.2: `features.plugins=false` and `features.apps=false` give the
 * model the same input as `--disable plugins --disable apps`, and `plugins.<id>.enabled=false`
 * (raw, see `addressableInConfigPath`) turns one plugin off. Config overrides, unlike the flags,
 * are accepted by `exec resume` as well.
 */
function inheritanceArgs(invocation: CodexInvocation): string[] {
  const args = (invocation.disabledPlugins ?? []).flatMap((id) => ["--config", configPathArg("plugins", id)]);
  if (invocation.disableAllPlugins) args.push("--config", "features.plugins=false");
  if (invocation.disableApps) args.push("--config", "features.apps=false");
  return args;
}

/**
 * Constrains the final message to a JSON Schema (#28).
 *
 * Verified against codex-cli 0.154.0 and 0.159.2: `--output-schema <FILE>` is
 * accepted by `exec` and by `exec resume`. The path is one argv element — the
 * server creates it, absolute, and spawn never goes through a shell.
 */
function outputSchemaArgs(path: string | undefined): string[] {
  return path === undefined ? [] : ["--output-schema", path];
}

/**
 * Flags `codex exec resume` does not accept.
 *
 * Verified against codex-cli 0.154.0: resume takes a much smaller flag set than
 * a fresh `exec` (no --color, --sandbox, --approve-for-me, --cd, --add-dir or
 * --search), because those belong to the recorded session. Anything resume
 * still needs is passed through `-c` config overrides instead.
 */

/**
 * Running in a managed worktree needs the feature turned on for the invocation.
 *
 * `worktrees` is experimental in codex-cli 0.154.0 and off by default: passing
 * `--worktree` alone exits with "requires the worktrees feature". `--enable`
 * applies only to this run and never writes to the user's config.
 */
const WORKTREE_ARGS = ["--enable", "worktrees", "--worktree"] as const;

/**
 * Live web search, as a config override rather than a flag.
 *
 * `--search` belongs to `codex` itself, not to `codex exec`: after the
 * subcommand, codex-cli 0.154.0 rejects it with "unexpected argument '--search'
 * found". `web_search = "live"` is the documented setting behind it, `exec`
 * accepts it through `--config`, and the argv keeps starting with `exec`.
 */
const WEB_SEARCH_ARGS = ["--config", 'web_search="live"'] as const;

/**
 * Shape a thread id must have before it is allowed onto the argv.
 *
 * `exec resume` takes the thread id positionally, so a value beginning with a
 * dash is parsed by the CLI as an option rather than as an identifier — passing
 * `--help` made it print its help and exit 0, which this server then reported
 * as a successful delegation. Arbitrary flags reached option parsing the same
 * way, including one that disables the sandbox.
 *
 * The pattern deliberately describes a safe *shape* rather than the exact
 * format the CLI currently issues (a UUID). Pinning it to today's format would
 * break every follow-up the day Codex changes it, and would buy nothing: what
 * closes the hole is that the value cannot start with a dash and cannot contain
 * anything a parser would treat as structure.
 */
export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

/**
 * Builds the argv for a Codex CLI run.
 *
 * The prompt is deliberately absent: it is written to the child's stdin, which
 * the CLI reads when no positional prompt is given. That removes every quoting
 * and shell-injection concern, so this array is always passed to `spawn` with
 * `shell: false`.
 */
export function buildCodexArgs(invocation: CodexInvocation): string[] {
  return invocation.kind === "resume"
    ? buildResumeArgs(invocation)
    : buildExecArgs(invocation);
}

function buildExecArgs(invocation: CodexInvocation): string[] {
  const args: string[] = ["exec", "--json", "--color", "never"];

  if (invocation.model) {
    args.push("--model", invocation.model);
  }

  if (invocation.reasoningEffort) {
    // Reasoning effort is a config key, not a flag: it is an axis independent
    // of model choice and is set through `-c`.
    args.push("--config", `model_reasoning_effort="${invocation.reasoningEffort}"`);
  }

  // `--approve-for-me` already implies the workspace-write sandbox and the CLI
  // rejects the two together ("--sandbox cannot be used with --approve-for-me"),
  // so it replaces the flag rather than accompanying it.
  if (invocation.autoApprove && invocation.sandbox === "workspace-write") {
    args.push("--approve-for-me");
  } else {
    args.push("--sandbox", invocation.sandbox);
  }

  if (invocation.workingDir) {
    args.push("--cd", invocation.workingDir);
  }

  for (const dir of invocation.addDirs ?? []) {
    args.push("--add-dir", dir);
  }

  if (invocation.useWorktree) args.push(...WORKTREE_ARGS);
  if (invocation.webSearch) args.push(...WEB_SEARCH_ARGS);
  if (invocation.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (invocation.ephemeral) args.push("--ephemeral");
  args.push(...disableMcpServerArgs(invocation.disabledMcpServers));
  args.push(...inheritanceArgs(invocation));
  args.push(...outputSchemaArgs(invocation.outputSchemaPath));

  return args;
}

function buildResumeArgs(invocation: CodexInvocation): string[] {
  if (!invocation.threadId) {
    throw new Error("A thread_id is required to resume a Codex session.");
  }

  if (!THREAD_ID_PATTERN.test(invocation.threadId)) {
    throw new Error(
      `Invalid thread_id: "${invocation.threadId}". A thread id is the value reported by a ` +
        "previous delegation: letters, digits, hyphens and underscores, starting with a letter " +
        "or digit.",
    );
  }

  const args: string[] = ["exec", "resume", invocation.threadId, "--json"];

  if (invocation.model) {
    args.push("--model", invocation.model);
  }

  if (invocation.reasoningEffort) {
    args.push("--config", `model_reasoning_effort="${invocation.reasoningEffort}"`);
  }

  // Resume has no --sandbox flag; the policy is applied as a config override.
  args.push("--config", `sandbox_mode="${invocation.sandbox}"`);

  if (invocation.useWorktree) args.push(...WORKTREE_ARGS);
  if (invocation.skipGitRepoCheck) args.push("--skip-git-repo-check");
  args.push(...disableMcpServerArgs(invocation.disabledMcpServers));
  args.push(...inheritanceArgs(invocation));
  args.push(...outputSchemaArgs(invocation.outputSchemaPath));

  return args;
}
