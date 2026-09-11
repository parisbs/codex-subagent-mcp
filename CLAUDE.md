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

Check with `codex exec --help`, `codex exec resume --help`, `codex features list`, and
`codex debug models`.

**Never degrade to a plausible-looking answer when the CLI is unavailable.** Every tool runs the
preflight first and fails with installation steps. Returning `FALLBACK_MODELS` as if the catalog had
been read turns a clear, fixable problem into a confusing one — that was the bug ADR 9 fixes. The
fallback now covers only a CLI that runs but whose `debug models` output was unusable.

**Windows resolves executables differently, and `spawn` does not do it for you.** `spawn` ignores
PATHEXT and refuses to run `.cmd`/`.bat` files without a shell — and a global npm install of the
Codex CLI produces exactly such a shim. Resolution goes through `src/codex/resolve.ts`, which prefers
a real executable and reports a shim as `unsupported-shim` rather than as "not installed". Never fix
this with `shell: true`; that reintroduces the injection hole ADR 4 closed.

**Keep npm scripts shell-agnostic.** npm runs scripts through cmd.exe on Windows, which expands no
globs and has no `rm`. That is why `npm test` goes through `scripts/run-tests.mjs` instead of a glob,
and why `clean` removes the directory with Node rather than `rm -rf`. CI covers Windows on Node 20,
the combination where neither the shell nor Node expands a pattern.

**Never install anything on the user's machine.** The preflight prints the installation commands for
the detected platform; running them is the user's decision.

**The preflight runs per tool call, never at startup.** A server that probed the CLI while
connecting would fail to register on a machine without Codex, and the user would never see the
diagnosis. `scripts/check-startup.mjs` asserts this in CI.

## Architecture

`src/index.ts` starts the stdio transport and cancels running jobs on shutdown.
`src/server.ts` registers the eight tools and owns all user-facing formatting.

- `src/codex/doctor.ts` — preflight: is the CLI installed, recent enough and signed in, and what
  should the user run if not.
- `src/codex/resolve.ts` — finds the Codex executable the way a shell would, without a shell.
- `src/codex/catalog.ts` — reads, normalises and caches the model catalog; clamps a requested
  reasoning effort to what the chosen model supports.
- `src/codex/args.ts` — builds the argv. Separate paths for `exec` and `exec resume`.
- `src/codex/events.ts` — incremental JSONL parser for `codex exec --json`, plus the progress
  descriptions.
- `src/codex/runner.ts` — spawns the child, streams events, enforces the timeout.
- `src/prompt.ts` — `QUALITY_CONTRACT` plus the layered prompt sections.
- `src/recommend.ts` — the model/effort matrix, always reconciled against the live catalog.
- `src/jobs.ts` — in-memory registry for `mode: "background"` delegations.

Two independent axes govern a delegation: the **model** (`-m`) sets raw capability, the **reasoning
effort** (`-c model_reasoning_effort=...`) sets how long it deliberates. Conflating them was the
original prototype's core bug.

## Testing the server by hand

Build first, then drive it with an MCP stdio client pointed at `node build/index.js`. Useful probes:
`list_codex_models` with no arguments, a `codex_delegate` against this repo with
`sandbox: "read-only"`, and an unsupported effort (`ultra` on `gpt-5.6-luna`) to confirm clamping.
Delegations cost real Codex quota, so keep smoke tests on the cheapest model at `low` effort.

## Conventions

Code, comments and documentation are written in English. Commit messages are a single English
sentence with an infinitive verb. See `docs/adr/` for why the design is the way it is, and
`docs/ROADMAP.md` for what is planned.
