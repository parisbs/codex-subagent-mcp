# Contributing

Thanks for taking a look. This document covers what you need to work on this project and the few
rules that are not negotiable, because breaking them has caused real defects here.

## Setup

```bash
npm ci
npm run build
npm test
```

You need Node 22 or newer. For anything beyond unit tests you also need the
[Codex CLI](https://developers.openai.com/codex/cli) installed and signed in — the server delegates
to it, so without it there is nothing to delegate to. Install it without npm on every platform: with
Homebrew (`brew install --cask codex`) on macOS, the standalone installer on Linux, and the
PowerShell installer on Windows, where a global npm install produces a `codex.cmd` shim this server
refuses to run. The README has the exact commands and the reasons, including the `bubblewrap`
prerequisite for Codex's sandbox on Linux.

Verify your setup with the `codex_doctor` tool, or by running the server and calling it.

## Rules that are not negotiable

Each of these exists because ignoring it produced a bug that shipped.

**Never hardcode the model list.** The catalog is read at runtime from `codex debug models`. The
original prototype hardcoded `gpt-4o` and `o1`, neither of which existed by the time anyone ran it.
The only static list is `FALLBACK_MODELS`, always flagged as stale.

**Never build a shell command string, and never use `shell: true`.** The CLI is invoked with an argv
array and the prompt is written to the child's stdin. A prompt is attacker-influenced text;
interpolating it into a shell is a command-injection hole. This also rules out the tempting fix for
Windows batch shims — see [ADR 11](docs/adr/0011-resolve-the-executable-without-a-shell.md).

**Verify CLI behaviour against the installed binary, not from memory.** Flags differ between
subcommands and between CLI versions. `codex exec resume` rejects flags that `codex exec` accepts,
and `--approve-for-me` cannot be combined with `--sandbox`. Both were found by running the thing.

**Never degrade to a plausible-looking answer.** If the Codex CLI is unavailable, fail with
instructions. Returning a fallback as though the catalog had been read turns a fixable problem into
a confusing one.

**Keep npm scripts shell-agnostic.** npm runs scripts through cmd.exe on Windows: no glob expansion,
no `rm`. That is why `npm test` goes through `scripts/run-tests.mjs`.

`CLAUDE.md` carries the same rules in the form an AI assistant reads them, and the two should be
kept in step.

## Where the work is tracked

Open work lives in [issues](https://github.com/parisbs/codex-subagent-mcp/issues), grouped by
[milestone](https://github.com/parisbs/codex-subagent-mcp/milestones). `docs/ROADMAP.md` explains
the reasoning behind each phase; it is not a task list and does not track status.

Security issues do not go in an issue. `SECURITY.md` says how to report one privately.

## Making a change

1. Branch from `main`. `main` is protected: changes land through a pull request with CI passing.
2. Group commits the way the work actually happened. Messages are a single English sentence with an
   infinitive verb, no trailing period: `Resolve the Codex executable explicitly`.
3. Add tests. The suite runs offline and never invokes the Codex CLI — behaviour that depends on it
   is tested through pure functions (`diagnose`, `buildCodexArgs`, `parseCatalog`) with fixtures
   captured from real CLI output.
4. Fill in the pull request template, including the Codex CLI version you tested against.

## Verification standards

State what you actually ran and what it produced. If you did not test something, say so — an
unverified claim in a pull request costs more to undo than an honest gap.

Delegations cost real Codex quota. Keep manual smoke tests on the cheapest model (`gpt-5.6-luna`) at
`low` reasoning effort.

## Documentation

Significant decisions get an ADR in `docs/adr/`, in Nygard format. A record is not edited once
accepted; it is superseded by a later one that links back. The exception is correcting a statement
of fact that has become untrue, such as marking something verified that was previously inferred.

Do not edit `CHANGELOG.md` in a pull request. It is written once, when a release is prepared, from
the pull requests that release contains. What a pull request must do instead is describe any
user-visible change in its own description — a new or renamed tool, a changed default, a new
environment variable, a fixed bug — clearly enough to be copied into the changelog later. Refactors,
test changes and internal cleanups need no such note. Releases also record the Codex CLI version
they were verified against, because the flag set differs between CLI versions.

How a change affects the version number is defined in `docs/VERSIONING.md`.

Code, comments, documentation and commit messages are written in English.
