# Roadmap

The goal is a dependable bridge for multi-model orchestration: Claude Code decides *what* needs
doing and *how hard it is*, and hands the work to the right Codex model at the right reasoning
depth. Everything below serves that, or it does not ship.

## Where the work is tracked

This document is the reasoning: why each thing was built the way it was, and why some things will
not be built at all. It is not a task list and it does not track status.

The work itself lives on GitHub, where it can actually be closed:

- **[Issues](https://github.com/parisbs/codex-subagent-mcp/issues)** — one per piece of work, with
  the reproduction where there is one.
- **[Milestones](https://github.com/parisbs/codex-subagent-mcp/milestones)** — the same issues
  grouped by the release that will carry them.

A note on numbering, because the two do not line up: the phases below (v0.1 through v0.6) were all
delivered inside the **0.1.0** release. They are development phases, not published versions. From
here on the headings are the release versions themselves, matching the milestones — and like the
milestones, a version not yet published is a forecast. [VERSIONING.md](VERSIONING.md) says how the
number is chosen and when it can still move.

## v0.1 — Correct core (done)

The prototype's premise was right and its execution was not. This release replaces it.

- Model catalog read from `codex debug models` at runtime, never hardcoded.
- Model and reasoning effort treated as independent axes, with per-model effort clamping.
- CLI invoked through `spawn` with an argv array; prompt delivered on stdin.
- `list_codex_models`, `codex_recommend`, `codex_delegate`, `codex_follow_up`.
- Blocking execution with MCP progress notifications, so long delegations are not cut off by the
  client's tool timeout.
- Read-only sandbox by default; writes are opt-in.
- Quality contract injected into every delegation.
- Enforced timeout with SIGTERM/SIGKILL escalation.

## v0.2 — Background delegations (done)

- `mode: "background"` returning a `job_id`, with `codex_job_status`, `codex_job_result` and
  `codex_job_cancel`.
- Concurrency cap, retention window, and cancellation of every child process on shutdown.

The remaining gap: jobs live only in the server process. A Claude Code restart loses them. Whether
that is worth fixing depends on how often long delegations outlive a session, so it is an open
question rather than planned work:
[#33](https://github.com/parisbs/codex-subagent-mcp/issues/33).

## v0.3 — Codex CLI preflight (done)

This server is useless without the Codex CLI, and until now it said so badly. `codex_delegate`
failed with `spawn ENOENT`, and `list_codex_models` did not fail at all — it returned the static
fallback with a warning, so an orchestrator could delegate against model slugs that were never
confirmed.

- `codex_doctor`, plus a preflight in front of every tool that needs the CLI.
- Three distinct states reported separately, because they need different fixes: not installed, not
  signed in, older than the verified version.
- Platform-specific installation commands, printed for the user to run. Never executed here.
- The fallback catalog narrowed to the one case it makes sense for.

Ordered ahead of publication deliberately: shipping without it guarantees a broken first impression
for every user who does not already have Codex. See
[ADR 9](adr/0009-preflight-the-codex-cli.md).

## v0.4 — Continuous integration (done)

- Build, typecheck and tests on every pull request: Node 20, 24 and 26 on Linux, plus Windows on 20
  and 24, and macOS. Required status checks on `main`. The Node 20 rows moved to 22 when the floor
  was raised in 0.2.0 ([#43](https://github.com/parisbs/codex-subagent-mcp/issues/43)).
- A startup check asserting the server comes up with no Codex CLI present, which is the one thing
  local development cannot verify.
- A resolution check that fabricates a Codex CLI on `PATH` and asserts the preflight finds it.
- Package-contents check on the tarball, plus installing that tarball into a scratch project and
  starting the installed bin.

Cross-platform CI paid for itself immediately, finding three defects that were invisible on macOS:

1. `npm test` relied on a glob. Neither cmd.exe nor Node 20's `--test` expands one, so the suite
   could not run on Windows at the version declared in `engines`. Test files are now resolved in
   Node (`scripts/run-tests.mjs`), which depends on neither.
2. `npm run clean` used `rm -rf`, which does not exist on Windows.
3. The server could not find a Codex CLI installed through npm on Windows, and reported it as not
   installed. See [ADR 11](adr/0011-resolve-the-executable-without-a-shell.md).

Since then, CI also runs a whole delegation cycle on all three platforms against a stand-in:
spawning, the prompt going through stdin, incremental JSONL parsing, split lines, exit codes and
stderr. It needs no Codex and no credentials. The trick is that the argv always begins with `exec`,
so the runner can be pointed at Node itself with a CommonJS file of that name in the child's
working directory — a shebang script is not executable on Windows and a `.cmd` shim is rejected by
`resolve.ts` on purpose, so neither could serve as the fixture.

Still unverified off macOS: the coupling to the real CLI — that it accepts the argv built here and
emits the events parsed here — and the process-termination paths on Windows, where there are no
POSIX signals and the behaviour differs by design. Tracked in
[#32](https://github.com/parisbs/codex-subagent-mcp/issues/32).

## v0.5 — Publish to npm (done)

npm hosts the artifact; everything else layers on top of it. See
[ADR 10](adr/0010-distribution-strategy.md).

Done:

- `prepublishOnly` runs a clean build and the test suite, so a publish can never ship a stale build
  or one that fails its own tests.
- Package metadata: repository, bugs, homepage, author, `publishConfig.access`.
- CI installs the packed tarball into a scratch project and starts the installed bin. Listing the
  tarball's contents does not prove the package works; this catches a broken `bin` entry or a
  missing executable bit.
- Name settled: `codex-subagent-mcp`, matching the repository. Unclaimed on npm.
- Versioning policy written: see [VERSIONING.md](VERSIONING.md). The first release is 0.1.0, and the
  document states what would have to be true for 1.0.
- Community files in place: issue templates, contributing guide, security policy, code of conduct
  and Dependabot.

- Repository made public, so the links the npm page will carry resolve, and standard CI runners
  became free.

- README rewritten as the install and quick-start guide, with the safety section and the disclaimer
  where they get read rather than at the bottom.

Published as [`codex-subagent-mcp@0.1.0`](https://www.npmjs.com/package/codex-subagent-mcp) on
2026-09-11, which buys this install path:

```bash
claude mcp add codex-subagent -- npx -y codex-subagent-mcp
```

Deliberately left out at the time: a release workflow. Automating a publish that had never been run
once by hand, against a secret that did not exist yet, would have been untested machinery guarding
the riskiest operation in the project. After two manual releases that reasoning had run its course,
and 0.3.0 ships it: a tag builds and tests the tagged commit, checks that the tag, `package.json` and
`SERVER_VERSION` agree, and stages the npm release with provenance through trusted publishing. It
does not publish — a maintainer approves the staged release with two-factor authentication
([#66](https://github.com/parisbs/codex-subagent-mcp/issues/66)).

## v0.6 — Configurable policy (done)

The server used to pick a model when the caller did not name one, using a regular-expression matrix
that encoded one person's opinion about which tasks deserve which model. It now refuses instead, and
hands back the recommendation it would have made.

- Five environment variables: `DEFAULT_MODEL`, `DEFAULT_EFFORT`, `ALLOWED_MODELS`, `MAX_SANDBOX`,
  `MAX_EFFORT`.
- Ceilings that a caller cannot argue past. `MAX_SANDBOX` closes a gap `SECURITY.md` previously
  listed as undefended.
- The matrix survives as advice in `codex_recommend` and in the refusal message, never on the
  execution path.

See [ADR 12](adr/0012-mechanism-not-policy.md).

## 0.2.0 — Hardening after the first review

Publishing 0.1.0 was not the end of the work; it was the point at which the code became worth
reviewing properly. A cross-model review — Codex at `gpt-6-astra`, `xhigh` reasoning, read-only,
through this server's own delegation tool — found seven defects in code with 90 tests and green CI
on three platforms. Every one was reproduced rather than argued for.

Two are security issues and are being handled through the repository's
[Security tab](https://github.com/parisbs/codex-subagent-mcp/security/advisories) as draft
advisories, published together with the release that fixes them. A published advisory reaches
`npm audit` and Dependabot; a closed issue reaches nobody.

The other five are fixed on `main`:

- [#22](https://github.com/parisbs/codex-subagent-mcp/issues/22) — a malformed event *field* inside
  valid JSON throws outside the promise and takes the process down.
- [#23](https://github.com/parisbs/codex-subagent-mcp/issues/23) — failed delegations come back
  without `isError`, including background jobs that exited non-zero.
- [#24](https://github.com/parisbs/codex-subagent-mcp/issues/24) — the line buffer has no cap;
  64 MiB without a newline is retained in full.
- [#25](https://github.com/parisbs/codex-subagent-mcp/issues/25) — a child that exits while a
  descendant holds the pipes defeats the timeout entirely.
- [#26](https://github.com/parisbs/codex-subagent-mcp/issues/26) — a cancellation arriving during
  the preflight is dropped, because `AbortSignal` does not replay.

Worth recording as a judgement, not just a list: the defects cluster in the places where this server
treats the CLI's output and the caller's input as well-formed. The parts that were designed
adversarially — the prompt never touching the argv, the executable resolved without a shell — held
up under direct attack. The parts that were merely written carefully did not.

A planning review that followed found three more gaps of the same kind, also fixed: the effort
ceiling could produce an effort the model does not support
([#38](https://github.com/parisbs/codex-subagent-mcp/issues/38)), the `model` parameter told the
orchestrator that omitting it picks one automatically
([#39](https://github.com/parisbs/codex-subagent-mcp/issues/39)), and commands, errors and file
changes were retained without limit
([#42](https://github.com/parisbs/codex-subagent-mcp/issues/42)).

Using the server for real work then found two things no review had. `web_search: true` had never
worked: `--search` belongs to `codex`, not `codex exec`, and every run that set it died in argument
parsing ([#48](https://github.com/parisbs/codex-subagent-mcp/issues/48)). And when a delegation hit
the ChatGPT plan's usage limit, the only thing reported was an exit code.

That second one led to a deliberate look at how Codex's own configuration — `config.toml` at user
and project level, and managed `requirements.toml` — interacts with a delegation. Every behaviour was
checked against the installed CLI with a scratch `CODEX_HOME`, and four fixes came out of it:

- [#51](https://github.com/parisbs/codex-subagent-mcp/issues/51) — a config Codex cannot load was
  reported as "not signed in", and the catalog quietly fell back to the static list.
- [#52](https://github.com/parisbs/codex-subagent-mcp/issues/52) — a resumed session does not keep
  its model: without `--model`, Codex takes it from the config of the directory it resumes in.
  Follow-ups now always restate model, effort and directory.
- [#53](https://github.com/parisbs/codex-subagent-mcp/issues/53) — `turn.failed` and top-level
  `error` events were ignored, while configuration warnings were counted as errors.
- [#54](https://github.com/parisbs/codex-subagent-mcp/issues/54) — recommendations ignored
  `MAX_EFFORT`.

The same work settled a design question: this server's policy stays in environment variables rather
than moving into Codex's `config.toml`. Codex's files are layered per directory and a trusted
repository can contribute to them, which is exactly where a ceiling meant to bound that repository
must not live. Codex's own restrictions exist, but in administrator-managed `requirements.toml`, which
this server cannot write and an individual user usually cannot either; they apply on top of this
server's ceilings rather than replacing them.

This was planned as a 0.1.1 of fixes alone. It becomes 0.2.0 because it also raises the supported
Node floor to 22 ([#43](https://github.com/parisbs/codex-subagent-mcp/issues/43)): Node 20 reached
end-of-life on 2026-04-30, and dropping a Node line is breaking under
[VERSIONING.md](VERSIONING.md). Several of the fixes above change behaviour a caller could see, which
a minor bump also covers.

## 0.3.0 — Defaults that survive a fresh install, and results that tell the truth

The theme is what happens to someone who installs this and configures nothing, and what the results
they read actually mean. Measuring a day of real delegations turned up more of both than expected.

Sandbox policy gains a user-set default and a ceiling that starts at `workspace-write`, so an
unconfigured server can no longer be asked for an unsandboxed run
([#77](https://github.com/parisbs/codex-subagent-mcp/issues/77),
[ADR 14](adr/0014-user-controlled-sandbox-defaults.md)). The recursion guard stops asking its
question in the wrong directory and says when it could not be applied
([#75](https://github.com/parisbs/codex-subagent-mcp/issues/75)); `codex_recommend` reads the
catalog of the directory the delegation will use
([#80](https://github.com/parisbs/codex-subagent-mcp/issues/80)); a thread survives a restart by
recovering its settings from Codex's own session file
([#81](https://github.com/parisbs/codex-subagent-mcp/issues/81)); a read-only run is told what it
cannot verify and where the network is
([#79](https://github.com/parisbs/codex-subagent-mcp/issues/79)); and a result reports this turn's
tokens rather than the thread's running total, along with the true command count and the directory
the run used ([#76](https://github.com/parisbs/codex-subagent-mcp/issues/76),
[#82](https://github.com/parisbs/codex-subagent-mcp/issues/82)).

`docs/DELEGATING.md` is the other half: what a delegation costs and how to shape one, from
measurements rather than intuition ([#83](https://github.com/parisbs/codex-subagent-mcp/issues/83)).

**`codex_review` is no longer scheduled here.** Wrapping `codex exec review` looked like the
headline feature of this release until it was measured against a plain delegation on the same
commit: the dedicated subcommand cost more, found less, hides its usage in a subagent thread the
event stream does not expose, and has no `--sandbox` flag. The issue stays open as an evaluation
with the numbers attached ([#27](https://github.com/parisbs/codex-subagent-mcp/issues/27)).

The configuration work behind 0.2.0 left two follow-ups here. The first is done: a result now
reports what Codex recorded as applied, not only what this server requested, so an override — by
managed requirements, say — is visible instead of silent, and a sandbox recorded as wider than the
one requested fails the delegation ([#55](https://github.com/parisbs/codex-subagent-mcp/issues/55),
[ADR 13](adr/0013-confirm-applied-settings.md)). The second is done too: the preflight and the
catalog now run in the delegation's working directory and are cached per directory, so a trusted
project's configuration is part of what they check
([#56](https://github.com/parisbs/codex-subagent-mcp/issues/56)). What is left from that issue is
summarising `codex doctor --json`, which is tracked separately
([#69](https://github.com/parisbs/codex-subagent-mcp/issues/69)): the command takes about ten seconds
and performs network reachability probes, so it cannot sit on a preflight path.

## 0.4.0 — Structured results, and runs that stop when told to

A delegation can return JSON instead of prose: an optional `output_schema` constrains the turn's
final message through `codex exec --output-schema`, so the orchestrator can act on a list of findings
or a verdict without a second model call
([#28](https://github.com/parisbs/codex-subagent-mcp/issues/28)). The schema travels in a private
temporary file that lives exactly as long as the run's processes.

That needed runs that actually stop, and they did not. Cancelling stopped the Codex process but not
what it started, and a descendant holding its pipes kept the result from settling
([#96](https://github.com/parisbs/codex-subagent-mcp/issues/96)); the real CLI runs each command in a
process group of its own and leaves it running on the signal the server sent
([#107](https://github.com/parisbs/codex-subagent-mcp/issues/107)). Shutdown now fits inside the half
second Claude Code allows before killing the server, and forces every stuck run before it exits
whatever the machine's speed ([#40](https://github.com/parisbs/codex-subagent-mcp/issues/40),
[#112](https://github.com/parisbs/codex-subagent-mcp/issues/112),
[#116](https://github.com/parisbs/codex-subagent-mcp/issues/116)).

It also takes the registry step ADR 10 decided on: an `mcpName`, a `server.json`, and a manually run
publication once the npm release is approved
([#97](https://github.com/parisbs/codex-subagent-mcp/issues/97)). And the server is re-verified
against Codex CLI 0.159.2, with a daily CI check that runs every argv shape against the newest
release without credentials
([#98](https://github.com/parisbs/codex-subagent-mcp/issues/98),
[#99](https://github.com/parisbs/codex-subagent-mcp/issues/99)).

## 0.5.0 — Delegations that inherit nothing they were not given

Codex's sandbox confines the shell commands a delegation runs, and nothing else. Measured on Codex
CLI 0.159.2, the MCP servers, plugins and apps a delegation inherits from the user's Codex setup run
as their own processes with the user's permissions: a tool that declares itself read-only runs
without approval even under `read-only`, and `auto_approve` lets any tool run. A trusted repository
can add servers of its own. So a delegation now starts with none of them unless the user allows them
in the server's configuration, outside the reach of tool arguments, and every result says what it was
allowed ([#64](https://github.com/parisbs/codex-subagent-mcp/issues/64),
[ADR 16](adr/0016-turn-off-inherited-tools.md)).

Building it showed that a `-c` override written the documented way, with a quoted key, named an
entry with literal quotes: the plugin it meant stayed on, and a server name with a space stopped
Codex from starting. `--help` cannot see that, so the daily CI check now applies the overrides in a
scratch Codex home and reads the result back through the CLI's own listings, on every platform and
on both the oldest supported release and the newest
([#129](https://github.com/parisbs/codex-subagent-mcp/issues/129)). The model allow-list now rejects
an empty entry instead of letting a list with no names allow everything
([#128](https://github.com/parisbs/codex-subagent-mcp/issues/128)).

## 0.6.0 — Measurement and additive changes

A blocking result already reports the tokens the CLI counted — input, cached, output and reasoning.
What does not exist is any view across delegations that outlives the process, so there is no way to
notice a pattern such as `xhigh` effort spent on work that `low` would have handled. Cost accounting comes first in this release
because later decisions depend on its data: whether background jobs must survive a restart, whether
task intents are worth building, and whether wrapping `codex exec review` is.

One thing this will deliberately never do: report or estimate subscription quota, such as the share
of a usage window a delegation consumed. The CLI's own logs expose those percentages, but plan limits
and credit rates are OpenAI's to change without notice, and a figure this server printed would go
wrong silently. Tokens reported by the CLI are the only usage figure surfaced.

The accounting is a local log the user turns on, one line per delegation process with counts and
enumerations, never anything the server takes from the prompt or the working tree, read back through
a `codex_usage` tool. Grouping by kind of task uses a label the caller chooses and the server stores
as given, because the server classifying prompts would be making policy
([ADR 22](adr/0022-keep-an-opt-in-local-usage-log.md)).

The rest of the release only adds surface or fixes: a bound on how many delegations a session can
start, counted in memory and set by the user
([ADR 23](adr/0023-bound-delegations-in-memory.md),
[ADR 25](adr/0025-settle-the-open-details-of-the-delegation-bound.md)), a summary of `codex doctor --json`, and
skipping a plugin listing that has no effect under the default configuration. No breaking change is
planned here ([ADR 17](adr/0017-define-1-0-as-the-interface-freeze.md)).

It also lets each registration describe itself. A user who registers the server twice with different
ceilings, one read-only for reviews and one that can write, today gets two identical sets of tools:
the descriptions are fixed strings, so a read-only registration still invites a writing sandbox, and
the server sends no instructions when a client connects. The descriptions and the instructions will
state what the configuration already says — the sandbox ceiling and default, the effort ceiling,
whether a default model makes `codex_recommend` unnecessary — plus, optionally, a purpose the user
writes in their own words and the server passes on without interpreting. That is reporting the
user's policy, not making one ([ADR 12](adr/0012-mechanism-not-policy.md)). Task intents
([#136](https://github.com/parisbs/codex-subagent-mcp/issues/136)) would change what the orchestrator
is told per call; this is about what each instance says about itself, and it does not wait for that
decision.

Worktree runs become something a caller can integrate without parsing a mismatch report. A follow-up
already resumes in the worktree Codex applied
([ADR 20](adr/0020-let-the-session-file-decide-where-a-follow-up-resumes.md)). What is still missing
is the worktree's path and base commit as a line of their own, and any word about what the worktree
left out: it is made from the last commit, so uncommitted changes, untracked files and ignored files
such as installed dependencies are not in it, and a probe saw Codex rewrite production code around a
missing dependency. The server reads the caller's tree with git before the run, tells Codex in the
prompt what its worktree lacks, takes the base commit from the session file rather than from the
request, and reports what differs ([ADR 21](adr/0021-report-the-base-of-a-worktree-run.md)). It
refuses nothing: denying a run from a dirty tree is a client-side hook's job.

[#29](https://github.com/parisbs/codex-subagent-mcp/issues/29),
[#62](https://github.com/parisbs/codex-subagent-mcp/issues/62),
[#69](https://github.com/parisbs/codex-subagent-mcp/issues/69),
[#135](https://github.com/parisbs/codex-subagent-mcp/issues/135),
[#143](https://github.com/parisbs/codex-subagent-mcp/issues/143),
[#149](https://github.com/parisbs/codex-subagent-mcp/issues/149),
[#150](https://github.com/parisbs/codex-subagent-mcp/issues/150)

## 0.7.0 — Closing the interface

The last release allowed to break before 1.0. Every open item that could still change the public
interface is implemented or closed here: which parts of a result an orchestrator may parse, how a
result says a turn is waiting for an answer, path validation for extra directories, refusing a
directory nobody chose, and whether background jobs survive a restart. The last two are questions;
closing one as `wontfix` resolves it as well as building it does.

[#138](https://github.com/parisbs/codex-subagent-mcp/issues/138),
[#125](https://github.com/parisbs/codex-subagent-mcp/issues/125),
[#31](https://github.com/parisbs/codex-subagent-mcp/issues/31),
[#63](https://github.com/parisbs/codex-subagent-mcp/issues/63),
[#33](https://github.com/parisbs/codex-subagent-mcp/issues/33)

## 1.0.0 — The interface freeze

1.0 is the declaration that the public interface is frozen, as
[ADR 17](adr/0017-define-1-0-as-the-interface-freeze.md) defines it and
[VERSIONING.md](VERSIONING.md#what-10-requires) lists. It carries no work of its own beyond what
proves the freeze: a period after 0.7.0 with no breaking change, whose length and conditions are
still to be set from data ([#139](https://github.com/parisbs/codex-subagent-mcp/issues/139)), and a
real delegation verified off macOS ([#32](https://github.com/parisbs/codex-subagent-mcp/issues/32)).

Changes that only add surface do not wait for 1.0 and do not block it. Codex profiles
([#30](https://github.com/parisbs/codex-subagent-mcp/issues/30)), task intents
([#136](https://github.com/parisbs/codex-subagent-mcp/issues/136)) and a review tool
([#27](https://github.com/parisbs/codex-subagent-mcp/issues/27)) are scheduled when data justifies
them, before or after 1.0.

## Under consideration: keeping delegation under the user's control

Not tied to a release. This server can be called from any conversation, not only programming ones,
and every call sends a prompt to OpenAI and spends the user's usage. An evaluation of how it gets
triggered — a vague "delegate this", a general-purpose chat, content that steers the orchestrator —
led to guardrails that shipped at once (tool descriptions that state the cost, a refusal that asks the
orchestrator to confirm the model with the user, results framed as information, and a guard against
a delegation calling this server again) and to four ideas that need design or evidence first:

- A limit on how many delegations a session can start, counted in delegations rather than quota
  ([#62](https://github.com/parisbs/codex-subagent-mcp/issues/62)).
- Refusing to run in a directory nobody chose, once its real impact on everyday use is measured
  ([#63](https://github.com/parisbs/codex-subagent-mcp/issues/63)).
- Turning off Codex plugins and features a delegation inherits from the user's own setup. Verified
  and shipped in 0.5.0: see that section
  ([#64](https://github.com/parisbs/codex-subagent-mcp/issues/64)).
- Asking the user directly before expensive runs through MCP elicitation, if clients actually show it
  ([#65](https://github.com/parisbs/codex-subagent-mcp/issues/65)). So far they do not reliably: the
  Claude Code desktop app answers `decline` without showing a prompt.

The strongest controls remain the ones the user already has: the client's permission prompt, the
server's ceilings, and their own instructions to Claude. [CONTROL.md](CONTROL.md) explains how to use
them.

## Under consideration: task intents

Not tied to a release. Whether the server should offer explicit task intents, such as `review` or
`investigate`, depends on data the project does not have yet: which delegations repeat and what they
cost ([#29](https://github.com/parisbs/codex-subagent-mcp/issues/29)), and a review comparison
larger than one trial ([#27](https://github.com/parisbs/codex-subagent-mcp/issues/27)). The design
constraints found so far and the criterion for deciding are in
[#136](https://github.com/parisbs/codex-subagent-mcp/issues/136), which may close as `wontfix`.

## Not planned: a triage skill, or a Claude Code plugin

Both were on this roadmap and have been removed, for the reason in ADR 12.

A skill shipping criteria for when to delegate would encode one workflow as the project's
recommended one, and users have different budgets, different tolerances and different trust in each
model. It also cannot be distributed: skills do not travel in an npm package. The plugin existed
mostly as the skill's delivery channel, so it goes with it — npm distributes the server perfectly
well on its own.

Escalation rules belong in each user's own `CLAUDE.md`, in plain language, where the orchestrating
model applies them with real understanding. That is strictly better than any rule table this server
could offer, and it costs nothing to build.

## Deliberately out of scope

**Shipping an `.mcpb` desktop bundle.** See
[ADR 10](adr/0010-distribution-strategy.md). One-click installation implies a self-contained server,
and this one cannot be one.

**Calling the OpenAI API directly.** See `docs/adr/0001-use-the-local-codex-cli.md`. The CLI brings
the sandbox, the approval model, session persistence and the agentic loop; reimplementing those over
raw API calls is a different and much larger project.

**Writing `AGENTS.md` into target repositories.** See `docs/adr/0007-inject-the-quality-contract.md`.
A delegation tool that mutates the repository it was pointed at is a bad neighbour.

**Orchestrating Codex-to-Codex fan-out.** Codex's own `ultra` effort already delegates subtasks. A
second orchestration layer on top of this server would duplicate that with less information.
