# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org) as defined in [docs/VERSIONING.md](docs/VERSIONING.md).

Every release states the Codex CLI version it was verified against. That matters more than usual
here: half of this server's behaviour depends on a third-party binary that changes flags between
releases, and a release verified against a newer CLI may behave differently on an older one. The
preflight reports that case as `unverified-version` rather than guessing.

## [Unreleased]

### Added

- Cross-platform coverage of a full delegation cycle: spawning, the prompt going
  through stdin, incremental JSONL parsing, split lines, non-ASCII text, in-band error
  items, exit codes and stderr. These run on Linux, Windows and macOS in CI, use no
  Codex quota and need no credentials. Previously only build, tests and startup were
  verified off macOS; see [docs/VERSIONING.md](docs/VERSIONING.md) for what is still
  missing before 1.0.

## [0.1.0] - 2026-09-11

First public release.

### Added

- Eight MCP tools: `codex_doctor`, `list_codex_models`, `codex_recommend`, `codex_delegate`,
  `codex_follow_up`, `codex_job_status`, `codex_job_result` and `codex_job_cancel`.
- Model and reasoning effort as two independent axes: `-m` for raw capability, and
  `model_reasoning_effort` for how long the model deliberates. Conflating them was the original
  prototype's core bug.
- A model catalog read from `codex debug models` at runtime and cached for ten minutes, so new
  models appear without a release here. The requested reasoning effort is clamped to what the chosen
  model actually supports.
- A preflight that runs on every tool call and reports whether the CLI is installed, recent enough
  and signed in, with the installation commands for the detected platform. It never installs
  anything, and it never degrades to a plausible-looking answer when the CLI is unavailable.
- `read-only` as the default sandbox. Writing is opt-in and explicit.
- Two execution modes: blocking with MCP progress notifications, and background with a job id.
- Delegation policy through five environment variables — `CODEX_SUBAGENT_DEFAULT_MODEL`,
  `CODEX_SUBAGENT_DEFAULT_EFFORT`, `CODEX_SUBAGENT_ALLOWED_MODELS`, `CODEX_SUBAGENT_MAX_SANDBOX`
  and `CODEX_SUBAGENT_MAX_EFFORT`. Configuration may only restrict; no setting makes delegations
  more permissive.
- A quality contract injected into every prompt, rather than writing an `AGENTS.md` into somebody
  else's repository.
- `CODEX_BIN` for a Codex executable that is not called `codex` or is not on `PATH`.

### Security

- The CLI is always invoked with `spawn` and an argv array, never a shell command string, and the
  prompt is written to the child's stdin. A prompt is attacker-influenced text; string interpolation
  into a shell would be a command-injection hole.
- On Windows, a `.cmd` shim from a global npm install is reported as `unsupported-shim` rather than
  silently run through a shell, which would reintroduce that hole.

### Verified against

- Codex CLI 0.154.0 on macOS, including a real delegation end to end.
- Build, tests and startup on Linux (Node 20, 24 and 26), Windows (Node 20 and 24) and macOS
  (Node 24). A real delegation has never been run on Windows or Linux; see
  [docs/VERSIONING.md](docs/VERSIONING.md) for what 1.0 requires.

### Known limitations

- The Codex sandbox restricts writes and network access, not reads. A delegation can read files
  outside the working directory, credentials included. The README explains the mitigation.
- Background jobs live in memory and do not survive a server restart.

[Unreleased]: https://github.com/parisbs/codex-subagent-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/parisbs/codex-subagent-mcp/releases/tag/v0.1.0
