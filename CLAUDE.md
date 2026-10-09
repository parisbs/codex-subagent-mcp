# codex-subagent-mcp

A local MCP server that lets Claude Code delegate work to the OpenAI Codex CLI installed on this
machine. It is the bridge for multi-model orchestration: Claude Code stays the orchestrator, Codex
becomes a callable subagent whose model and reasoning depth are chosen per task.

## Commands

- Verify: `npm run verify` (typecheck, build, tests, and the startup and CLI-resolution checks; the
  same steps CI runs, on one platform).
- `npm run dev` watches `src/index.ts`; `npm run clean` removes the build output through Node, not
  `rm`.

## Invariants

**Never hardcode the model list.** The catalog is read at runtime from `codex debug models`
(`src/codex/catalog.ts`). OpenAI ships new Codex models regularly; a hardcoded list goes stale and
sends invalid slugs to the CLI. The only static list is `FALLBACK_MODELS`, which exists solely for
when the CLI cannot be reached and is always flagged as stale to the caller.

**Never build a shell command string.** The CLI is always invoked with `spawn(argv, {shell: false})`
and the prompt is written to the child's stdin, never placed on the argv. A prompt is attacker-
influenced text; string interpolation into a shell is a command-injection hole. `test/args.test.ts`
guards this.

**Verify CLI behaviour against the installed binary, not from memory.** The flag set differs between
subcommands and between versions. Two traps already found the hard way, both covered by tests:

- `codex exec resume` rejects `--color`, `--sandbox`, `--approve-for-me`, `--cd`, `--add-dir` and
  `--search`. Anything it still needs goes through `-c` config overrides.
- `--approve-for-me` already implies the workspace-write sandbox and cannot be combined with
  `--sandbox`; it replaces the flag instead of accompanying it.

- `--worktree` needs `--enable worktrees` on the same invocation: the feature is experimental and
  off by default in 0.154.0, and the flag alone exits with "requires the worktrees feature". It is
  stable and on by default in 0.159.2; the flag stays for the 0.154.0 floor.

- `--search` is an option of `codex`, not of `codex exec`: after the subcommand the CLI exits 2 with
  "unexpected argument '--search' found", so `web_search: true` never worked until it was replaced
  by `-c web_search="live"`. That form is accepted by `exec` and keeps the argv starting with
  `exec`, which the cross-platform test fixture depends on. Tests that only check a flag is
  *present* in the argv would not have caught this; check the position against `--help`.

- Warnings arrive as failures and failures arrive outside items. Configuration warnings (ignored
  project config keys, a model switch on resume) are `item.completed` items of type `error`, printed
  twice before `turn.started`; a usage limit or a lost connection is a top-level `error` event
  followed by `turn.failed`. `src/codex/events.ts` downgrades only known warning shapes and treats
  `turn.failed` as fatal. When a new warning shows up as an error, add its shape there rather than
  loosening the rule.

- A resumed session does not keep its model. `codex exec resume` without `--model` takes the model
  from the config of the directory it runs in, even when the thread was recorded on another one, and
  an effort missing from the argv comes from config even if the model does not support it. That is
  why follow-ups always restate model, effort and directory (`src/threads.ts`).
- Configuration is resolved against the working directory, so a probe's answer is a property of the
  directory, not of the machine. `codex doctor --json` reports the `cwd` its `config.load` check
  resolved for. That is why `runDoctor` and `getCatalog` take a `cwd` and cache per directory, and
  why the delegation tools pass their `working_dir` to both.
- What a run *applied* is not what it was *asked for*. The session file under
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` carries a `turn_context` line per
  turn with the model, effort, sandbox and cwd Codex resolved, and a `session_meta` line with
  `git.commit_hash`, the commit the session started from. That format is internal and
  undocumented: re-verify it on every CLI bump (`test/rollout.test.ts` pins real 0.154.0, 0.159.2,
  0.160.0 and 0.162.0 lines), and keep every failure path reporting "unconfirmed" rather than
  guessing. A read of it changes nothing
  but the report, except the directory a follow-up resumes in: on a registry miss (recovery) and
  after a `use_worktree` run, where the worktree path exists nowhere else. An unconfirmed read there
  degrades to the old behaviour or to a refusal, never to a guessed directory (ADR 20).
- Codex starts its MCP servers with almost no environment (`HOME`, `LOGNAME`, `PATH`, `SHELL`,
  `TMPDIR`, `USER`) unless an entry lists `env_vars`, so an environment marker cannot tell this
  server it is running inside a delegation. The recursion guard instead finds this server in
  `codex mcp list --json`, run in the delegation's working directory, and passes
  `-c mcp_servers.<name>.enabled=false` (`src/codex/mcp.ts`). Listing failure must remain fail-open
  but be reported as a run whose recursion guard could not be applied. The prompt also instructs a
  delegated run not to delegate further; that is an instruction, not a control, and covers
  configurations the listing could not enumerate. Recognition is deliberately by shape: the
  `codex-subagent-mcp` string, a `codex-subagent` executable basename, or this process's exact entry
  script path. A copy registered under a different path and name is not recognised.

Check with `codex exec --help`, `codex exec resume --help`, `codex features list`, and
`codex debug models`.

`.github/workflows/codex-compat.yml` does part of this every day against the newest release, with no
credentials: every argv shape `buildCodexArgs` can produce is run with `--help` appended, which makes
the CLI reject an argv it would not accept without running anything. A removed flag serves as the
negative control; if the CLI ever accepts it, the check fails rather than trust the rest. A new
option in `src/codex/args.ts` must be added to `argvShapes` in `scripts/check-codex-compat.ts`, or
`test/codex-compat.test.ts` fails. `NEWEST_VERIFIED_CODEX_VERSION` moves only after `/smoke-test`
passes on that release.

**Never degrade to a plausible-looking answer when the CLI is unavailable.** Every tool that reaches
the CLI runs the preflight first and fails with installation steps (the job tools read this server's
own memory and do not). Returning `FALLBACK_MODELS` as if the catalog had
been read turns a clear, fixable problem into a confusing one — that was the bug ADR 9 fixes. The
fallback now covers only a CLI that runs but whose `debug models` output was unusable, and it is
never used to validate a delegation. A config Codex cannot load is its own failure: `login status`
exits 1 for it just as for a signed-out account, so the preflight reads stderr
(`Error loading configuration:`) instead of calling it "not signed in".

**Windows resolves executables differently, and `spawn` does not do it for you.** `spawn` ignores
PATHEXT and refuses to run `.cmd`/`.bat` files without a shell — and a global npm install of the
Codex CLI produces exactly such a shim. Resolution goes through `src/codex/resolve.ts`, which prefers
a real executable and reports a shim as `unsupported-shim` rather than as "not installed". Never fix
this with `shell: true`; that reintroduces the injection hole ADR 4 closed.

**Keep npm scripts shell-agnostic.** npm runs scripts through cmd.exe on Windows, which expands no
globs and has no `rm`. That is why `npm test` goes through `scripts/run-tests.mjs` instead of a glob,
and why `clean` removes the directory with Node rather than `rm -rf`. CI runs Windows on the Node
floor, 22: cmd.exe still expands nothing, and the suite must not depend on Node 22's `--test` doing it
instead.

**Mechanism, not policy.** The server never decides which model a task deserves. With no model in
the call and none configured, it refuses and returns the recommendation it would have made. The
matrix in `src/recommend.ts` is advice — it answers `codex_recommend` and fills in that refusal — and
must never end up on the execution path again. Sandbox policy has a user-set default and a ceiling:
a caller may override the default but never exceed the ceiling. With no configuration those are
`read-only` and `workspace-write`; reaching `danger-full-access` requires an explicit environment
opt-in. See ADR 12 and ADR 14.

**Never install anything on the user's machine.** The preflight prints the installation commands for
the detected platform; running them is the user's decision.

**The preflight runs per tool call, never at startup.** A server that probed the CLI while
connecting would fail to register on a machine without Codex, and the user would never see the
diagnosis. `scripts/check-startup.mjs` asserts this in CI.

## Architecture

`src/server.ts` owns all user-facing formatting; `src/codex/` holds everything that talks to the
CLI, and `src/codex/rollout.ts` is the only place that touches an internal Codex format (ADR 13).

Two independent axes govern a delegation: the **model** (`-m`) sets raw capability, the **reasoning
effort** (`-c model_reasoning_effort=...`) sets how long it deliberates. Conflating them was the
original prototype's core bug.

## Automated coverage of a delegation

`test/delegation-cycle.test.ts` runs a whole delegation on every platform without Codex, without
credentials and without quota. The stand-in in `test/fixtures/` works by exploiting the fact that
the argv always starts with `exec`: the runner is pointed at `process.execPath` with a temporary
directory as the child's cwd, and a CommonJS file named `exec` sits in that directory, so Node
treats it as the entry point and the Codex flags land in `process.argv`.

That indirection is the point. A shebang script is not executable on Windows and a `.cmd` shim is
rejected by `resolve.ts` by design, so neither can be the fixture. Do not "simplify" this by adding
`shell: true` or by shipping a `.cmd`.

The signal tests in `test/runner.test.ts` stay POSIX-only: Windows has no SIGTERM to ignore, so the
escalation they cover does not exist there. So is the descendant-holds-the-pipes test, for a
different reason found in CI: on Windows that run settled in 89 ms with `timedOut: false`, so
`close` arrives as soon as the parent exits even when a descendant inherited its stdout — the stuck
pipe the test needs does not occur. Both are platform differences, not gaps.

Termination targets the process tree, not the Codex process (`src/codex/terminate.ts`): on POSIX the
CLI leads its own process group and the group is signalled, even after Codex exits; a bare pid is
never signalled once reaped, and Windows `taskkill /T /F` runs only while the leader lives.
`test/termination.test.ts` covers this on all three platforms with a stand-in that starts a
descendant.

The real CLI does not keep its commands in that group (#107, verified on 0.159.2): each shell
command and helper leads a process group of its own, and on SIGTERM Codex exits and leaves them
running, while on SIGINT it kills them. So the polite signal is SIGINT, and the groups of Codex's
descendants are read from `ps` while Codex is still alive and included in the forced stage. The
stand-in reproduces this with `descendant.ownGroup`; a stand-in that skips it would pass while the
real CLI leaks commands, which is how #96 shipped with this gap.

Shutdown has a budget set by the host, not by this server: Claude Code 2.1.285 sends SIGINT,
SIGTERM 100 ms later and SIGKILL about half a second after the first signal, and never closes stdin
first. `src/shutdown.ts` fits inside it (SIGKILL at 250 ms, exit by 300 ms); do not reuse the
five-second cancellation grace there. Re-measure with a probe MCP server when the host changes.
Every millisecond spent before a SIGKILL counts against that budget, and reading the process table
takes about 30 ms on a developer Mac and about 130 ms on GitHub's macOS runner: counted per run, the
reads pushed a second run's SIGKILL past the exit, so it was never sent (#112). Runs stopped
together therefore share one SIGKILL instant, counted from the request, and a shutdown reads the
table once, before the polite signal, abandoned after `SHUTDOWN_TABLE_TIMEOUT_MS`, and not again
before SIGKILL (#116). Reading after killing Codex would not help: its children are reparented at
once. Test this schedule on a mocked clock; a test that times real processes measures the machine,
so it is held only to the host's budget.

## Testing the server by hand

Build first, then drive it with an MCP stdio client pointed at `node build/index.js`. Useful probes:
`list_codex_models` with no arguments, a `codex_delegate` against this repo with
`sandbox: "read-only"`, and an unsupported effort (`ultra` on `gpt-5.6-luna`) to confirm clamping.
Delegations cost real Codex quota, so keep smoke tests on the cheapest model at `low` effort.

## Stack rules

- A stdio server writes only protocol messages to stdout. Logs and diagnostics go to stderr.
- The unit suite runs offline and never invokes the Codex CLI. Behaviour that depends on it is
  tested through pure functions (`diagnose`, `buildCodexArgs`, `parseCatalog`) with fixtures
  captured from real CLI output.
- For acceptance tests, declare new API with `throw new Error('not implemented')` bodies so tests
  fail by assertion, not by compilation.

## Conventions

- Git: gitflow branch names (`feature/`, `fix/`, `hotfix/`, `release/`, `chore/`, `docs/`,
  `refactor/`, `test/`), squash merge to `main`.
- Commits and pull request titles: Conventional Commits in English, one line, imperative mood, for
  example `fix(runner): report a timeout as an error`. CI checks the pull request title.
- Code, comments and documentation are in English. Documentation diagrams use Mermaid and carry a
  short prose description.
- Significant decisions get an ADR in `docs/adr/`, in Nygard format. A record is immutable once
  merged to `main`, with no exception: a changed decision or a fact that became untrue goes in a
  later record that supersedes it and links back (ADR 15). The superseded record changes in its
  status line only, naming its successor, and its index row says the same (ADR 19).
- Instructions live in this `CLAUDE.md` alone; there is no `AGENTS.md`, so a delegated run loads no
  repository instructions of its own (ADR 18).
- `CHANGELOG.md` changes only when a release is prepared. A pull request describes any user-visible
  change in its own body so the release step can compile it.
- How a change affects the version number is defined in `docs/VERSIONING.md`.
- **Release branches are deleted once the release is published.** A `release/X.Y.Z` branch exists
  only to prepare a release: the documentation pass, the changelog and the version bump. It is
  squash-merged into `main` like any other branch, and the annotated tag `vX.Y.Z` is what records
  the published state; pushing the tag runs `.github/workflows/publish.yml`, which stages the
  release with npm provenance for a maintainer to approve.
- **The MCP Registry entry follows the npm approval, by hand.** Once the staged release is live, run
  `.github/workflows/registry.yml` with the tag. The registry checks `server.json` against the
  package npm serves, so it refuses a version that is only staged or whose `package.json` lacks
  `mcpName`, and the workflow checks both first. `server.json` must list every variable in the
  README's configuration table (`test/registry.test.ts`). The `mcp-publisher` version and its SHA-256
  are pinned in `scripts/check-registry.ts`; "invalid audience" from the registry means that pin is
  due, and both values move together.

## Workflow

- Issues carry acceptance criteria as `WHEN ... THEN ...`, numbered `AC-n`. Tests that prove a
  criterion carry its identifier in their name.
- Review: none
- Ask for a Codex review when a change touches argv construction, the event parser or the catalog.
  Those files are on the `Human merge:` line, so the human sees whether the review ran.
- Implement: claude
- Human merge: package-lock.json, .npmrc, server.json, .mcp.json, scripts/, src/codex/args.ts, src/codex/events.ts, src/codex/catalog.ts

## Claude Code

- `/smoke-test` runs the end-to-end verification against the real Codex CLI, on the cheapest model
  and effort because delegations spend real quota.
- `/verify-catalog` checks the model catalog code against the installed CLI after an OpenAI model
  release.
- `.mcp.json` registers this checkout's build as `codex-subagent`, so sessions in this repository
  exercise the code under development rather than a published version. Run `npm run build` after
  changing the server, and restart the session to load it.
