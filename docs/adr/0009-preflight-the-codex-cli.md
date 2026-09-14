# 9. Preflight the Codex CLI before every tool call

Status: Accepted

## Context

This server is useless without the Codex CLI. That was acceptable while the only user was the
author, who has it installed and signed in. It stops being acceptable the moment the package is
distributed: the first thing a new user without Codex would see is a failure that does not explain
itself.

The behaviour before this change, measured by pointing `CODEX_BIN` at a path that does not exist:

- `codex_delegate` failed with `spawn /nonexistent/codex ENOENT`. Accurate, and useless to anyone
  who does not already know what ENOENT means or that Codex is a separate install.
- `list_codex_models` **did not fail**. It returned five models from `FALLBACK_MODELS` with a
  warning line. An orchestrator can read that list, skip the warning, and delegate with a slug it
  believes is valid. Degrading to a plausible-looking answer is worse than failing: it converts a
  clear, fixable problem into a confusing one.

There are also three distinct failure states that all presented identically, despite needing
different fixes: the CLI is not installed, the CLI is installed but no account is signed in, and the
CLI is too old for the flags this server uses.

## Decision

Add a preflight (`src/codex/doctor.ts`) that probes `codex --version` and `codex login status`, and
classifies the result as `ok`, `missing`, `unauthenticated`, `unverified-version` or `unknown`.

Run it before every tool that needs the CLI. When the CLI is unusable, fail the call with the
diagnosis and ordered remediation steps chosen for the detected platform — `process.platform`
selects between the shell installer, the PowerShell installer, Homebrew and npm.

Expose it as a `codex_doctor` tool so the state can be inspected directly.

**Print the installation commands; never run them.** Installing software on the user's machine is
the user's decision, and the official installers pipe a remote script into a shell.

Treat an older-than-verified CLI as usable with a warning rather than a hard failure. The version
floor records what was tested, not what is known to break; the CLI's own argument error is more
informative than a guess made here.

Keep `FALLBACK_MODELS`, but narrow what it covers. With the preflight in front, a missing or
signed-out CLI no longer reaches the catalog code, so the fallback now only handles a CLI that runs
but whose `debug models` output could not be used.

## Consequences

Every failure mode now names itself and says what to do about it, in the same words from whichever
tool the orchestrator happened to call first. Nothing returns a plausible answer built on a CLI that
is not there.

This is a prerequisite for distribution, not a later refinement: publishing without it guarantees a
broken first impression for every user who does not already have Codex. It is why the roadmap orders
it ahead of npm publication.

The cost is two extra child processes on the first call of a session. The result is cached for the
process lifetime, and a failed probe is deliberately **not** cached, so installing Codex and
retrying works without restarting the server.

The preflight runs per tool call and never at startup. A server that probed the CLI while connecting
would fail to register on a machine without Codex, and the user would never see the diagnosis
explaining why — `scripts/check-startup.mjs` asserts this in CI.

The sign-in check reads the exit code of `codex login status` rather than its message, because the
wording varies by authentication method.

Both paths have since been verified against the real CLI, by moving `~/.codex/auth.json` aside and
restoring it, which avoids signing the account out:

- signed in: exits `0`, prints "Logged in using ChatGPT"
- signed out: exits `1`, prints "Not logged in"

Correction for 0.2.0: the exit code alone turned out not to be enough. A Codex configuration the CLI
cannot load also makes `codex login status` exit `1`, with `Error loading configuration:` on stderr,
and was reported as signed out. The preflight now reads that prefix and reports a separate
`config-error` state, and a probe killed by its own timeout is `unknown` rather than signed out.
The catalog no longer falls back to `FALLBACK_MODELS` for a configuration error, and no delegation is
validated against the fallback.

Worth recording how close that came to being measured wrong: the first attempt read `$?` after
piping the command into `head`, so it captured `head`'s exit code and reported `0` for both cases.
Had that reading been trusted, the signed-out branch would never fire. Measure the exit code of the
command itself, not of a pipeline.
