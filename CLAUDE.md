# codex-subagent-mcp

A local MCP server that lets Claude Code delegate work to the OpenAI Codex CLI installed on this
machine. It is the bridge for multi-model orchestration: Claude Code stays the orchestrator, Codex
becomes a callable subagent whose model and reasoning depth are chosen per task.

## Commands

```bash
npm run build      # tsc -> build/
npm test           # node --test via tsx, against src/
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

Check with `codex exec --help`, `codex exec resume --help`, and `codex debug models`.

## Architecture

`src/index.ts` starts the stdio transport and cancels running jobs on shutdown.
`src/server.ts` registers the seven tools and owns all user-facing formatting.

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
