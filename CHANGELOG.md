# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org) as defined in [docs/VERSIONING.md](docs/VERSIONING.md).

Every release states the Codex CLI version it was verified against. That matters more than usual
here: half of this server's behaviour depends on a third-party binary that changes flags between
releases, and a release verified against a newer CLI may behave differently on an older one. The
preflight reports that case as `unverified-version` rather than guessing.

## [Unreleased]

### Security

- `codex_follow_up` no longer lets a `thread_id` reach the CLI argv as an option. The id is passed
  positionally to `exec resume`, so a value beginning with a dash was parsed as a flag: `--help`
  made the CLI print its help and exit 0, which this server reported as a successful follow-up, and
  other flags reached option parsing the same way — including one that disables the sandbox. The
  value is now checked against a safe shape at the argv boundary and again at the tool's schema.
  (GHSA-m9wq-wr2p-3rc4)
- Configured model and effort ceilings are now enforced on `codex_follow_up`. A resumed session
  keeps the model and effort it was created with, and this server cannot read those back, so
  resuming without an override skipped `CODEX_SUBAGENT_ALLOWED_MODELS` and
  `CODEX_SUBAGENT_MAX_EFFORT` entirely. When either is configured, the resumed turn now states both
  explicitly. (GHSA-6946-2h8r-6372)
- `add_dirs` entries are validated as existing absolute directories, the same as `working_dir`. The
  CLI rejects a flag-shaped value today, but a third-party parser was the only thing standing
  between a caller and the argv.

### Fixed

- A malformed field inside an otherwise valid JSON event no longer crashes the server. Events are
  validated at the boundary before any consumer reads them, and a throw while processing the stream
  is contained and reported instead of ending the process — it previously escaped the stdout
  listener, outside the promise, taking every in-flight delegation with it. ([#22])
- Retained output is bounded. An oversized JSONL line is abandoned and parsing resynchronises at the
  next newline, and retained agent messages are capped by size and count, keeping the newest.
  Truncation is reported through the result's errors rather than silently dropping content. Feeding
  64 MiB without a newline previously retained all of it. ([#24])
- The timeout now holds even when the Codex process exits while a descendant keeps its stdout and
  stderr open. Settlement no longer waits for a `close` event that in that case never arrives, which
  could leave a background job pending indefinitely. ([#25])
- A cancellation that arrives before the runner starts is honoured, and no child is spawned at all.
  `AbortSignal` does not replay its event, so a signal already aborted during the preflight was
  never heard. ([#26])

[#22]: https://github.com/parisbs/codex-subagent-mcp/issues/22
[#24]: https://github.com/parisbs/codex-subagent-mcp/issues/24
[#25]: https://github.com/parisbs/codex-subagent-mcp/issues/25
[#26]: https://github.com/parisbs/codex-subagent-mcp/issues/26

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
