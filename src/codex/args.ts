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

  return args;
}
