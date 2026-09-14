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
  and 24, and macOS. Required status checks on `main`.
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

Not done, deliberately: a release workflow. Automating a publish that has never been run once by
hand, against a secret that does not exist yet, would be untested machinery guarding the riskiest
operation in the project.

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

A planning review that followed found three more gaps of the same kind, now part of this release: the
effort ceiling could produce an effort the model does not support
([#38](https://github.com/parisbs/codex-subagent-mcp/issues/38)), the `model` parameter still told
the orchestrator that omitting it picks one automatically
([#39](https://github.com/parisbs/codex-subagent-mcp/issues/39)), and commands, errors and file
changes are still retained without limit
([#42](https://github.com/parisbs/codex-subagent-mcp/issues/42)).

This was planned as a 0.1.1 of fixes alone. It becomes 0.2.0 because it also raises the supported
Node floor to 22 ([#43](https://github.com/parisbs/codex-subagent-mcp/issues/43)): Node 20 reached
end-of-life on 2026-04-30, and dropping a Node line is breaking under
[VERSIONING.md](VERSIONING.md).

## 0.3.0 — Delegated code review

`codex exec review` is a separate subcommand with its own flags (`--uncommitted`, `--base`,
`--commit`, `--title`) and its own output shape. Wrapping it as `codex_review` gives the
orchestrator a second opinion on a diff from a different model family, which is the most obviously
valuable thing a cross-model setup can offer — and the review behind 0.2.0 is the evidence that it
works.

Open question: whether review findings are worth parsing into a structured list, or whether the
prose summary is enough for the orchestrator to act on. That may depend on 0.4.0.

[#27](https://github.com/parisbs/codex-subagent-mcp/issues/27)

## 0.4.0 — Structured results

`codex exec --output-schema <FILE>` constrains the model's final response to a JSON Schema. Today
the orchestrator receives prose and has to re-read it. An optional `output_schema` parameter would
let a delegation return, for example, a list of findings with file, line and severity — parseable
without a second model call.

Requires writing the schema to a temporary file and cleaning it up, including when the run is
killed — a path this project now knows it gets wrong in some orderings.

[#28](https://github.com/parisbs/codex-subagent-mcp/issues/28)

## 0.5.0 — Cost and configuration

Every result already reports the tokens the CLI counted — input, cached, output and reasoning. What
does not exist is any view across delegations, so there is no way to notice a pattern such as `xhigh`
effort spent on work that `low` would have handled. Codex profiles are not exposed, and monorepos
have to restate their extra directories on every call.

One thing this will deliberately never do: report or estimate subscription quota, such as the share
of a usage window a delegation consumed. The CLI's own logs expose those percentages, but plan limits
and credit rates are OpenAI's to change without notice, and a figure this server printed would go
wrong silently. Tokens reported by the CLI are the only usage figure surfaced.

[#29](https://github.com/parisbs/codex-subagent-mcp/issues/29),
[#30](https://github.com/parisbs/codex-subagent-mcp/issues/30),
[#31](https://github.com/parisbs/codex-subagent-mcp/issues/31)

## 1.0.0 — Hardening

The leading digit is not a decision to be made by declaration; [VERSIONING.md](VERSIONING.md) says
what it requires. The two open pieces are integration tests against the real CLI off macOS, and a
settled answer on whether background jobs must survive a restart — which is a question about real
usage, and may well close as `wontfix`.

[#32](https://github.com/parisbs/codex-subagent-mcp/issues/32),
[#33](https://github.com/parisbs/codex-subagent-mcp/issues/33)

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
