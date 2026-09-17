# codex-subagent-mcp

A local MCP server that lets Claude Code delegate work to the OpenAI Codex CLI installed on this
machine. It is the bridge for multi-model orchestration: Claude Code stays the orchestrator, Codex
becomes a callable subagent whose model and reasoning depth are chosen per task.

## Commands

```bash
npm run build      # tsc -> build/
npm test           # scripts/run-tests.mjs -> node --test via tsx, against src/
npm run typecheck  # tsc --noEmit
npm run dev        # tsx watch src/index.ts
```

## Hard rules

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
  off by default, and the flag alone exits with "requires the worktrees feature".

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
  turn with the model, effort, sandbox and cwd Codex resolved. That format is internal and
  undocumented: re-verify it on every CLI bump (`test/rollout.test.ts` pins a real 0.154.0 line), and
  keep every failure path reporting "unconfirmed" rather than guessing. Never let a read of it change
  anything but the report.
- Codex starts its MCP servers with almost no environment (`HOME`, `LOGNAME`, `PATH`, `SHELL`,
  `TMPDIR`, `USER`) unless an entry lists `env_vars`, so an environment marker cannot tell this
  server it is running inside a delegation. The recursion guard instead finds this server in
  `codex mcp list --json` and passes `-c mcp_servers.<name>.enabled=false` (`src/codex/mcp.ts`).

Check with `codex exec --help`, `codex exec resume --help`, `codex features list`, and
`codex debug models`.

**Never degrade to a plausible-looking answer when the CLI is unavailable.** Every tool runs the
preflight first and fails with installation steps. Returning `FALLBACK_MODELS` as if the catalog had
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
must never end up on the execution path again. Configuration may only restrict; there is no setting
that makes delegations more permissive. See ADR 12.

**Never install anything on the user's machine.** The preflight prints the installation commands for
the detected platform; running them is the user's decision.

**The preflight runs per tool call, never at startup.** A server that probed the CLI while
connecting would fail to register on a machine without Codex, and the user would never see the
diagnosis. `scripts/check-startup.mjs` asserts this in CI.

## Architecture

`src/index.ts` starts the stdio transport and cancels running jobs on shutdown.
`src/server.ts` registers the eight tools and owns all user-facing formatting.

- `src/codex/doctor.ts` — preflight: is the CLI installed, recent enough, signed in and able to load
  its configuration, and what should the user run if not.
- `src/codex/resolve.ts` — finds the Codex executable the way a shell would, without a shell.
- `src/codex/catalog.ts` — reads, normalises and caches the model catalog; clamps a requested
  reasoning effort to what the chosen model supports.
- `src/codex/args.ts` — builds the argv. Separate paths for `exec` and `exec resume`.
- `src/codex/events.ts` — incremental JSONL parser for `codex exec --json`, plus the progress
  descriptions.
- `src/codex/rollout.ts` — reads the session file Codex writes for a thread, to confirm what it
  actually applied. The only place that touches an internal Codex format; see ADR 13.
- `src/codex/runner.ts` — spawns the child, streams events, enforces the timeout.
- `src/prompt.ts` — `QUALITY_CONTRACT` plus the layered prompt sections.
- `src/config.ts` — user policy read from the environment: defaults and ceilings.
- `src/recommend.ts` — the model/effort matrix, always reconciled against the live catalog. Advice
  only.
- `src/jobs.ts` — in-memory registry for `mode: "background"` delegations.
- `src/threads.ts` — what each thread last ran with, so follow-ups can restate it.
- `src/outcome.ts` — the one definition of a failed delegation, shared by blocking and background.

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

## Testing the server by hand

Build first, then drive it with an MCP stdio client pointed at `node build/index.js`. Useful probes:
`list_codex_models` with no arguments, a `codex_delegate` against this repo with
`sandbox: "read-only"`, and an unsupported effort (`ultra` on `gpt-5.6-luna`) to confirm clamping.
Delegations cost real Codex quota, so keep smoke tests on the cheapest model at `low` effort.

## Conventions

Code, comments and documentation are written in English. Commit messages are a single English
sentence with an infinitive verb. See `docs/adr/` for why the design is the way it is, and
`docs/ROADMAP.md` for what is planned.
