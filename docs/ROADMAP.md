# Roadmap

The goal is a dependable bridge for multi-model orchestration: Claude Code decides *what* needs
doing and *how hard it is*, and hands the work to the right Codex model at the right reasoning
depth. Everything below serves that, or it does not ship.

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
that is worth fixing depends on how often long delegations outlive a session — revisit with real
usage rather than on principle.

## v0.3 — Delegated code review

`codex exec review` is a separate subcommand with its own flags (`--uncommitted`, `--base`,
`--commit`, `--title`) and its own output shape. Wrapping it as `codex_review` gives the
orchestrator a second opinion on a diff from a different model family, which is the most obviously
valuable thing a cross-model setup can offer.

Open question: whether review findings are worth parsing into a structured list, or whether the
prose summary is enough for the orchestrator to act on.

## v0.4 — Structured results

`codex exec --output-schema <FILE>` constrains the model's final response to a JSON Schema. Today
the orchestrator receives prose and has to re-read it. An optional `output_schema` parameter would
let a delegation return, for example, a list of findings with file, line and severity — parseable
without a second model call.

Requires writing the schema to a temporary file and cleaning it up, including when the run is
killed.

## v0.5 — Cost and configuration

- Per-delegation accounting: token usage is already captured per run but discarded afterwards. A
  local rolling summary would let the orchestrator notice it is spending `xhigh` effort on work that
  `low` would have handled.
- Codex profiles (`-p/--profile`), so a project can pin a named Codex configuration.
- `--add-dir` ergonomics for monorepos, where the interesting code sits outside the working root.

## v1.0 — Hardening

- Integration tests that exercise the real CLI, gated behind an environment variable so the default
  `npm test` stays free and offline.
- CI running build, typecheck and unit tests.
- Published to npm so it can be installed without cloning.

## Deliberately out of scope

**Calling the OpenAI API directly.** See `docs/adr/0001-use-the-local-codex-cli.md`. The CLI brings
the sandbox, the approval model, session persistence and the agentic loop; reimplementing those over
raw API calls is a different and much larger project.

**Writing `AGENTS.md` into target repositories.** See `docs/adr/0007-inject-the-quality-contract.md`.
A delegation tool that mutates the repository it was pointed at is a bad neighbour.

**Orchestrating Codex-to-Codex fan-out.** Codex's own `ultra` effort already delegates subtasks. A
second orchestration layer on top of this server would duplicate that with less information.
