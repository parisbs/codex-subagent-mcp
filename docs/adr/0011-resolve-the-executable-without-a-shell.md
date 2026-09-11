# 11. Resolve the Codex executable without a shell

Status: Accepted

## Context

Expanding CI to Windows turned up a defect that had been invisible on macOS and Linux, and that
would have hit every Windows user who installed the Codex CLI the most common way.

`child_process.spawn` with `shell: false` behaves differently on Windows than a shell does:

- It does not apply `PATHEXT`, the list of extensions a shell appends when resolving a bare command.
- It refuses to execute `.cmd` and `.bat` files at all. Node blocked this deliberately: arguments
  cannot be passed to a batch file safely, so running one without a shell was a vulnerability.

`npm install -g @openai/codex` on Windows produces exactly such a batch shim, `codex.cmd`, which
wraps the Node entry point. So a user with a perfectly working `codex` command in their terminal was
told by this server that the Codex CLI was not installed.

The obvious fix — `shell: true` — is not available. It would reinstate the injection surface that
[ADR 4](0004-spawn-with-argv-and-stdin.md) exists to close, this time through `working_dir` and
`add_dirs`, which are caller-supplied paths.

## Decision

Resolve the executable explicitly, in `src/codex/resolve.ts`, before spawning.

On POSIX, hand the bare name to `spawn` unchanged. It already searches `PATH` correctly, and
duplicating that logic would only add ways to be wrong. An explicit path is checked for existence and
the executable bit.

On Windows, search `PATH` applying `PATHEXT`, and classify what is found:

- A real executable (`.exe`, `.com`) is spawned by absolute path.
- A batch shim (`.cmd`, `.bat`) is reported as the distinct `unsupported-shim` state, never spawned.
- A real executable anywhere on `PATH` wins over a shim, so a working install is never passed over.

`unsupported-shim` carries its own remediation: use the Windows installer, which produces a real
executable, or point `CODEX_BIN` at `codex.exe` directly.

## Consequences

A Windows user who installed through npm now gets an accurate explanation and two ways forward,
instead of being told their working installation does not exist. That is the whole value of this
change: the failure was not that the server did not work, it was that it lied about why.

The honest cost: this server cannot be used with an npm-installed Codex CLI on Windows. That is a
real restriction, and it is the right one — the alternative is executing a batch file with
caller-controlled arguments through a command shell.

The resolution runs in the preflight, the catalog reader and the runner, so all three agree on which
binary is being talked about.

This was found by a CI check that fabricates a `codex.cmd` on `PATH` and asserts the diagnosis
(`scripts/check-codex-resolution.mjs`). Reasoning alone would not have settled it; the check runs on
every pull request precisely because the behaviour is platform-specific and easy to regress.
