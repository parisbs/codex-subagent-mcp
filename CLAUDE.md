# codex-subagent-mcp

A local MCP server that lets Claude Code delegate work to the OpenAI Codex CLI installed on this
machine: Claude Code stays the orchestrator, Codex becomes a subagent whose model and reasoning
effort are chosen per task.

<!-- Path-scoped detail lives in .claude/rules/: codex-cli.md (CLI traps, session files, recursion
guard), process-handling.md (termination and shutdown budget), tests.md (offline suite, stand-in)
and release.md. Each loads only when a matching file is read or edited. Keep what every session
needs here, and keep the Invariants, Conventions and Verify formats: hooks parse them. -->

## Commands

- Verify: `npm run verify` (typecheck, build, tests, and the startup and CLI-resolution checks; the
  same steps CI runs, on one platform).

## Invariants

**Never hardcode the model list.** The catalog is read at runtime from `codex debug models`
(`src/codex/catalog.ts`); OpenAI ships models often and a hardcoded list sends stale slugs. The only
static list is `FALLBACK_MODELS`, used when the catalog cannot be read (the CLI fails, or its output
is unusable), always flagged as stale and never used to validate a delegation.

**Never build a shell command string.** The CLI is spawned with an argv array and `shell: false`, and
the prompt goes to the child's stdin, never the argv: a prompt is attacker-influenced text.
`test/args.test.ts` guards this. Windows shims are no excuse: `spawn` ignores PATHEXT and refuses
`.cmd`/`.bat`, so `src/codex/resolve.ts` prefers a real executable and reports a shim as
`unsupported-shim` (ADR 11).

**Verify CLI behaviour against the installed binary, not from memory.** Flags differ between
subcommands and versions, and several traps are already known: `.claude/rules/codex-cli.md` lists
them, with the session-file format and the recursion guard. A task that touches `src/codex/` or
`src/threads.ts` reads it first.

**Never degrade to a plausible-looking answer when the CLI is unavailable.** Every tool that reaches
the CLI runs the preflight first and fails with installation steps; the job tools and `codex_usage`
read local state and do not. A config Codex cannot load is its own failure: `login status` exits 1
for it as for a signed-out account, so the preflight reads stderr (`Error loading configuration:`).

**Mechanism, not policy.** The server never decides which model a task deserves: with no model in
the call and none configured, it refuses and returns the recommendation it would have made. The
matrix in `src/recommend.ts` is advice and never on the execution path. Sandbox policy has a
user-set default and ceiling, `read-only` and `workspace-write` when unset; a call may override the
default but never exceed the ceiling, and `danger-full-access` needs an explicit opt-in (ADR 12,
ADR 14).

**Never install anything on the user's machine.** The preflight prints the installation commands;
running them is the user's decision.

**The preflight runs per tool call, never at startup.** A server that probed the CLI while
connecting would fail to register on a machine without Codex, hiding the diagnosis.
`scripts/check-startup.mjs` asserts this in CI.

**A stdio server writes only protocol messages to stdout.** Logs and diagnostics go to stderr.

**Keep npm scripts shell-agnostic.** npm runs them through cmd.exe on Windows, which expands no
globs and has no `rm`: `npm test` goes through `scripts/run-tests.mjs`, and `clean` removes the
build with Node. CI runs Windows on Node 22, the floor.

## Architecture

`src/server.ts` registers the tools and assembles delegation results; `src/codex/` holds everything
that talks to the CLI, including the diagnosis and inheritance text. Two Codex formats are internal
and undocumented, each read in one place: session files in `src/codex/rollout.ts` and the
`codex doctor --json` report in `src/codex/doctor-report.ts` (ADR 13).

The **model** (`-m`) sets raw capability and the **reasoning effort**
(`-c model_reasoning_effort=...`) sets how long it deliberates. They are independent axes;
conflating them was the original prototype's core bug.

## Conventions

- Git: branches `feature/`, `fix/`, `hotfix/`, `release/`, `chore/`, `docs/`, `refactor/` or
  `test/`, squash merge to `main`. Commits and pull request titles: Conventional Commits in English,
  one line, imperative mood, such as `fix(runner): report a timeout as an error`; CI checks the
  title.
- Code, comments and documentation are in English. Documentation diagrams use Mermaid with a short
  prose description.
- Significant decisions get an ADR in `docs/adr/`, status in YAML front matter. A record is
  immutable from the commit on `main` where it is accepted or rejected; a change goes in a new record
  that supersedes it. The rules are in `CONTRIBUTING.md` and `scripts/check-adrs.mjs` enforces them
  in CI.
- Instructions live in this file alone; there is no `AGENTS.md`, so a delegated Codex run loads no
  repository instructions (ADR 18).
- `CHANGELOG.md` changes only on a `release/` or `hotfix/` branch; a hook refuses other edits. A
  pull request describes any user-visible change in its own body for the release to compile.
- Version bumps follow `docs/VERSIONING.md`.

## Workflow

- Issues carry acceptance criteria as `WHEN ... THEN ...`, numbered `AC-n`; tests that prove one
  carry its identifier in their name.
- Implement: claude
- Review: none by default. A change to argv construction (`src/codex/args.ts`), the event parser
  (`src/codex/events.ts`) or the catalog (`src/codex/catalog.ts`) asks for a Codex review; those
  files are on the Human merge line, so the human sees whether it ran.
- Human merge: package-lock.json, .npmrc, server.json, .mcp.json, scripts/, .claude/hooks/, src/codex/args.ts, src/codex/events.ts, src/codex/catalog.ts
- `.mcp.json` registers this checkout's `build/` as `codex-subagent`, so sessions here exercise the
  code under development. After changing the server, run `npm run build` and restart the session; a
  session-start hook warns when the build is older than `src/`.
- Delegations spend real Codex quota: smoke tests use the cheapest model at `low` effort
  (`/smoke-test`).
