# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org) as defined in [docs/VERSIONING.md](docs/VERSIONING.md).

Every release states the Codex CLI version it was verified against. That matters more than usual
here: half of this server's behaviour depends on a third-party binary that changes flags between
releases, and a release verified against a newer CLI may behave differently on an older one. The
preflight reports that case as `unverified-version` rather than guessing.

## [Unreleased]

## [0.3.0] - 2026-09-17

Defaults that survive a fresh install, and results that mean what they say. A day of measuring real
delegations against the installed CLI drove most of this: three places were asking Codex a question
in the wrong directory, and two numbers in every result meant something other than what they looked
like. A minor rather than a patch because a caller can see the difference; each such change is
marked below.

### Changed

- **Breaking:** the sandbox ceiling now defaults to `workspace-write`. An unconfigured server used to
  allow a call to request `danger-full-access`, which removes the sandbox entirely, network included.
  Reaching it requires setting `CODEX_SUBAGENT_MAX_SANDBOX=danger-full-access` deliberately. The
  `sandbox` argument is filled in by an orchestrating model whose judgement is influenced by content
  it has read; removing the sandbox is a decision for the person who installed the server. ([#77],
  [ADR 14](docs/adr/0014-user-controlled-sandbox-defaults.md))
- **Breaking:** the token line in a result changed shape. A follow-up used to print the thread's
  cumulative total as if it were that call's cost — measured, a turn that cost 56,261 input tokens
  was reported as 123,432. Results now label `tokens this turn` and `tokens thread so far`, print a
  single `tokens=` line when they are the same, and say `unknown` for the turn when the previous
  total is not known rather than passing the total off as it. Input is also broken out as cached and
  uncached. ([#76], [#82])
- **Breaking:** `working_dir` given as an empty string is refused instead of silently falling back to
  the server's own directory. ([#74])
- New `CODEX_SUBAGENT_DEFAULT_SANDBOX`: the sandbox used when a call omits one. Unset still means
  `read-only`. A value above the ceiling is a configuration error. ([#77])
- The command count in a result is the true total. `commands` retains the newest 500, so counting the
  list undercounted a long run; the heading now says how many ran and how many are shown. ([#82])
- Every result states the working directory the run actually used, which for a call that omits
  `working_dir` is the server process's own — in a desktop client, possibly nowhere near the
  repository the user means. ([#82])
- `codex_doctor`, `list_codex_models` and `codex_recommend` accept a `working_dir`, and run their
  probes there. ([#56], [#80])
- A follow-up on a thread this server has no record of — started elsewhere, or before a restart —
  recovers the model, effort and directory from Codex's own session file when the record is complete,
  validates them through the same catalog, allow-list and ceiling checks as a caller-supplied
  override, and says where they came from. An incomplete or stale record still gives the previous
  refusal. ([#81])
- The `codex_delegate` description tells the orchestrator to call `codex_recommend` first when the
  user named no model, and to present the suggestion before delegating. The refusal for a call that
  arrives with no model is unchanged. ([#78])
- A read-only delegation is told that commands needing temporary, cache or build writes may fail
  under the sandbox and that such a failure is a verification it could not complete, not a defect;
  and that its shell has no network while the web-search tool, being API-backed, works. A run
  measured before this reported 80 failing tests that were sandbox artefacts. ([#79])

### Added

- Results confirm what Codex actually applied. After a run, the server reads the session file Codex
  writes for the thread and compares the model, effort, sandbox and directory it recorded against the
  ones requested: the metadata line ends with `applied=confirmed`, `applied=differs` or
  `applied=unconfirmed`, and a difference is stated before Codex's report. A sandbox recorded as more
  permissive than requested fails the delegation with a security notice. A value that cannot be read
  or recognised is reported as unconfirmed, never as confirmation. ([#55],
  [ADR 13](docs/adr/0013-confirm-applied-settings.md))
- [docs/DELEGATING.md](docs/DELEGATING.md): what a delegation costs and how to shape one, from
  measurements rather than intuition — the cost model, rules ranked by measured effect, three
  weak-versus-strong prompt pairs, and an explicit list of what these parameters do not mean. ([#83])
- Releases are built and staged by GitHub Actions from a version tag, with npm provenance through
  trusted publishing, and reach users only when a maintainer approves the staged release with
  two-factor authentication. The tag, `package.json` and `SERVER_VERSION` must agree or the job
  fails. ([#66])

### Fixed

- The recursion guard asked its question in the wrong directory. It listed Codex's MCP servers in the
  server's own directory while the delegation runs in `working_dir` — which is where Codex loads a
  trusted project's `.codex/config.toml`, and therefore the only place a repository could register
  this server to provoke recursion. It now lists in the delegation's directory, on new runs and
  follow-ups, and a result says when the guard could not be applied instead of failing open in
  silence. The injected prompt also tells a delegated run not to delegate further — an instruction,
  not a control, for configurations the listing cannot enumerate. ([#75])
- `codex_doctor` reports an invalid `CODEX_SUBAGENT_*` value instead of a clean bill of health, and
  `codex_recommend` refuses while the environment is misconfigured. Both read that configuration, and
  either can be the first call anyone makes — so "is this working?" used to answer yes while every
  delegation refused.
- The preflight and the model catalog run in the delegation's working directory and cache per
  directory. Codex resolves configuration against the directory it runs in, so a delegation could be
  validated against a catalog that was not the one its run would use, and a project whose
  `.codex/config.toml` Codex cannot parse looked healthy. ([#56])

### Security

- An unconfigured installation can no longer be asked for an unsandboxed run. See the first entry
  under Changed. ([#77])
- `SECURITY.md` records what `workspace-write` actually allows, measured: writes in the working
  directory and `/tmp`, no commits (Codex keeps `.git` read-only), and no network in the shell. It
  also records the two Codex settings that lift those limits, that both were verified to work, and
  why this server deliberately exposes neither — write access to `.git` is code execution through
  hooks on the next git command, and network access is what keeps a run from sending out what it
  read. ([#72])

### Verified against

- Codex CLI 0.154.0 on macOS.
- Build, tests and startup on Linux (Node 22, 24, 26), Windows (Node 22, 24) and macOS (Node 24). A
  real delegation has still never been run on Windows or Linux.

## [0.2.0] - 2026-09-14

Hardening after the first review of 0.1.0, plus what real use and a deliberate look at Codex's own
configuration found. A minor rather than a patch because it raises the Node floor and changes
behaviour a caller can see; each such change is marked below.

### Changed

- **Breaking:** Node 22 or newer is required. Node 20 reached end-of-life on 2026-04-30. ([#43])
- **Breaking:** follow-ups always state the model, reasoning effort and working directory. A resumed
  Codex session does not keep its model — without `--model`, Codex takes it from the configuration
  of the directory it resumes in and compacts the thread — so the server now remembers what each
  thread it started ran with and restates it. A follow-up on a thread it has no record of (started
  by another server process, or before a restart) needs an explicit `model`, unless
  `CODEX_SUBAGENT_DEFAULT_MODEL` is set; `working_dir` defaults to the thread's directory. ([#52])
- **Breaking:** `auto_approve: true` on `codex_follow_up` is refused, and nothing runs. It was
  accepted and silently dropped, because `codex exec resume` has no such flag. ([#52])
- **Breaking:** more runs are reported as failed. A turn Codex reports as failed (`turn.failed`) is a
  failure whatever the exit code, and so is a clean exit with no answer at all. ([#53])
- **Breaking:** `codex_delegate` refuses to run when only the static fallback catalog is available,
  instead of validating a paid run against a list that may not match the installed CLI. ([#51])
- `codex_recommend`, and the recommendation included when a delegation is refused for lack of a
  model, stay within `CODEX_SUBAGENT_MAX_EFFORT` and skip models with no effort under it. ([#54])
- The `codex_delegate` and `codex_follow_up` descriptions state that a delegation sends its content
  to OpenAI and spends the user's Codex usage, when delegating fits, and that Claude should say when
  it delegates. The server is available in any conversation, not only programming ones, and the old
  "coding or analysis task" invited delegation almost anywhere.
- A delegation refused for lack of a model now asks the orchestrator to confirm the model with the
  user before calling again, rather than inviting it to retry with the suggestion on its own.
- Collections retained per run are bounded: the newest 500 commands, 100 distinct errors (repeats
  collapsed into one entry with a count, each capped at 2,000 characters) and the first 1,000
  distinct changed files. Anything dropped is counted and reported. At most 100 finished background
  jobs are kept. ([#42])

### Security

- `codex_follow_up` no longer lets a `thread_id` reach the CLI argv as an option. The id is passed
  positionally to `exec resume`, so a value beginning with a dash was parsed as a flag: `--help` made
  the CLI print its help and exit 0, which this server reported as a successful follow-up, and other
  flags reached option parsing the same way — including one that disables the sandbox. The value is
  now checked against a safe shape at the argv boundary and again at the tool's schema.
  (GHSA-m9wq-wr2p-3rc4)
- Configured model and effort ceilings are enforced on `codex_follow_up`. Resuming without an
  override skipped `CODEX_SUBAGENT_ALLOWED_MODELS` and `CODEX_SUBAGENT_MAX_EFFORT` entirely. Every
  follow-up now resolves its model and effort through the same policy as a new delegation and states
  both on the argv. (GHSA-6946-2h8r-6372, [#52])
- `add_dirs` entries are validated as existing absolute directories, the same as `working_dir`.
- A delegation can no longer call this server again. If the server is also registered in the user's
  Codex configuration, every delegation and follow-up switches that entry off for the run
  (`-c mcp_servers.<name>.enabled=false`), found through `codex mcp list --json`. An environment
  marker could not do this: Codex starts MCP servers with almost no environment.
- Every delegation result starts by stating that Codex's report is information, not instructions.
  Codex may have read hostile content, and its report is how that content would reach the
  orchestrator.

### Fixed

- `web_search: true` works. It had never worked: `--search` is an option of `codex`, not of
  `codex exec`, so every run that set it failed during argument parsing. It is now passed as
  `-c web_search="live"`. A completed search shows in progress as `Searched the web: <query>`.
  ([#48])
- A Codex configuration the CLI cannot load — a TOML syntax error, an invalid value, the removed
  top-level `profile = "…"` selector, an unknown provider — is reported as the new `config-error`
  status with Codex's own message, instead of "not signed in". The catalog no longer falls back to
  the static list for it. A sign-in probe that times out is `unknown` rather than signed out. ([#51])
- Why a turn failed is reported. A usage limit or a lost connection arrives as a top-level `error`
  event followed by `turn.failed`; both were ignored, and the caller saw only an exit code. ([#53])
- Configuration warnings Codex emits as error items — ignored project config keys, a model switch on
  resume — are listed once under "Codex notices" instead of as errors, and no longer make a run look
  failed. Warnings on stderr are shown on successful runs too. ([#53])
- The effort ceiling can no longer produce an effort the chosen model does not support; the effort is
  chosen from what the model supports at or below the ceiling, and the call is refused if nothing
  qualifies. ([#38])
- Tool descriptions no longer promise what the server does not do: an omitted `model` is refused
  with a recommendation rather than picked, and the `reasoning_effort`, `auto_approve`,
  `use_worktree`, `list_codex_models` and `codex_follow_up` descriptions match the code. ([#39])
- A malformed field inside an otherwise valid JSON event no longer crashes the server. Events are
  validated at the boundary, and a throw while processing the stream is contained and reported.
  ([#22])
- Retained output is bounded: an oversized JSONL line is abandoned and parsing resynchronises at the
  next newline, and agent messages are capped by size and count, keeping the newest. ([#24])
- The timeout holds even when the Codex process exits while a descendant keeps its pipes open, which
  could leave a background job pending indefinitely. ([#25])
- Failed delegations are reported as errors, including in-band error items on a zero exit and
  background jobs that exited non-zero. An error only counts when the run produced no answer, so a
  truncation notice or a recovered error does not flag a run that did its job. ([#23])
- A cancellation that arrives before the runner starts is honoured and spawns nothing, and such a
  job is recorded as cancelled rather than failed. ([#26])

### Added

- `config-error` and `unknown` states in `codex_doctor`. ([#51])
- Cross-platform coverage of a full delegation cycle — spawning, stdin, incremental JSONL parsing,
  exit codes and stderr — on Linux, Windows and macOS in CI, using a stand-in that needs no Codex
  quota or credentials.

### Documentation

- [Staying in control of delegation](docs/CONTROL.md), linked from a short README section: client
  permissions, server ceilings, version ranges, the user's own rules for Claude, what the server does
  on its own and what no setting can guarantee.
- A versioning policy with one bump rule per kind of change, a Node support policy, and this
  changelog written at release time. ([#41])
- Windows and Linux covered alongside macOS: Codex installation, sandbox prerequisites, Claude
  Desktop configuration and the maintainer checklists.
- How Codex's own configuration interacts with this server, and why ceilings belong outside the
  working tree: a `workspace-write` delegation can edit a project `.mcp.json`. See `SECURITY.md` and
  `docs/TOOLS.md`.

### Verified against

- Codex CLI 0.154.0 on macOS. Each fix touching the CLI was checked against the real binary; the
  release smoke test is recorded in the release notes.
- Build, tests and startup on Linux (Node 22, 24 and 26), Windows (Node 22 and 24) and macOS
  (Node 24). A real delegation has still not been run on Windows or Linux.

### Known limitations

- Results report the model, effort and sandbox this server requested, not a confirmation of what
  Codex applied. ([#55])
- The preflight and catalog run in the server's working directory, not the delegation's, so a
  trusted project's Codex config is not part of what they check. ([#56])
- Background jobs and the per-thread settings used by follow-ups live in memory and do not survive a
  server restart.
- The Codex sandbox restricts writes and network access, not reads.

[#22]: https://github.com/parisbs/codex-subagent-mcp/issues/22
[#23]: https://github.com/parisbs/codex-subagent-mcp/issues/23
[#24]: https://github.com/parisbs/codex-subagent-mcp/issues/24
[#25]: https://github.com/parisbs/codex-subagent-mcp/issues/25
[#26]: https://github.com/parisbs/codex-subagent-mcp/issues/26
[#38]: https://github.com/parisbs/codex-subagent-mcp/issues/38
[#39]: https://github.com/parisbs/codex-subagent-mcp/issues/39
[#55]: https://github.com/parisbs/codex-subagent-mcp/issues/55
[#56]: https://github.com/parisbs/codex-subagent-mcp/issues/56
[#66]: https://github.com/parisbs/codex-subagent-mcp/issues/66
[#72]: https://github.com/parisbs/codex-subagent-mcp/issues/72
[#74]: https://github.com/parisbs/codex-subagent-mcp/issues/74
[#75]: https://github.com/parisbs/codex-subagent-mcp/issues/75
[#76]: https://github.com/parisbs/codex-subagent-mcp/issues/76
[#77]: https://github.com/parisbs/codex-subagent-mcp/issues/77
[#78]: https://github.com/parisbs/codex-subagent-mcp/issues/78
[#79]: https://github.com/parisbs/codex-subagent-mcp/issues/79
[#80]: https://github.com/parisbs/codex-subagent-mcp/issues/80
[#81]: https://github.com/parisbs/codex-subagent-mcp/issues/81
[#82]: https://github.com/parisbs/codex-subagent-mcp/issues/82
[#83]: https://github.com/parisbs/codex-subagent-mcp/issues/83
[#41]: https://github.com/parisbs/codex-subagent-mcp/issues/41
[#42]: https://github.com/parisbs/codex-subagent-mcp/issues/42
[#43]: https://github.com/parisbs/codex-subagent-mcp/issues/43
[#48]: https://github.com/parisbs/codex-subagent-mcp/issues/48
[#51]: https://github.com/parisbs/codex-subagent-mcp/issues/51
[#52]: https://github.com/parisbs/codex-subagent-mcp/issues/52
[#53]: https://github.com/parisbs/codex-subagent-mcp/issues/53
[#54]: https://github.com/parisbs/codex-subagent-mcp/issues/54
[#55]: https://github.com/parisbs/codex-subagent-mcp/issues/55
[#56]: https://github.com/parisbs/codex-subagent-mcp/issues/56

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

[Unreleased]: https://github.com/parisbs/codex-subagent-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/parisbs/codex-subagent-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/parisbs/codex-subagent-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/parisbs/codex-subagent-mcp/releases/tag/v0.1.0
