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
that is worth fixing depends on how often long delegations outlive a session — revisited in v1.0,
with real usage rather than on principle.

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

- Build, typecheck and tests on every pull request, across Node 20 and 24.
- A startup check asserting the server comes up with no Codex CLI present, which is the one thing
  local development cannot verify.
- Package-contents check on the tarball, catching the classic mistake of publishing sources without
  build output.

Next step for this: make the CI check a required status check on `main`, now that it exists.

## v0.5 — Publish to npm

npm hosts the artifact; everything else layers on top of it. See
[ADR 10](adr/0010-distribution-strategy.md).

Remaining before the first publish:

- A `prepublishOnly` script, so a publish can never ship a stale or missing build.
- Settle the repository's visibility. Publishing to npm distributes the code regardless, and a
  public package backed by a private repository leaves users unable to read the design notes, file
  an issue, or send a fix.
- Pick the package name. `codex-subagent-mcp` and `codex-subagent` are both unclaimed.

The install path this buys, with no prior install:

```bash
claude mcp add codex-subagent -- npx -y codex-subagent-mcp
```

## v0.6 — Discovery

Optional, and only worth doing once npm publication has settled.

- **MCP Registry.** Metadata only, so it requires the npm package first, plus an `mcpName` field in
  `package.json` matching `server.json`. Namespace is proven by GitHub login (`io.github.parisbs/...`).
  Free, currently in preview.
- **Claude Code plugin.** More interesting than the registry for this project, because a plugin
  carries the slash commands (`/verify-catalog`, `/smoke-test`) alongside the server, and those are
  part of how it is actually used.

Not planned: an `.mcpb` desktop bundle. One-click installation implies a self-contained server, and
this one depends on an external Codex CLI it cannot install. The click would succeed and every tool
call would fail.

## v0.7 — Delegated code review

`codex exec review` is a separate subcommand with its own flags (`--uncommitted`, `--base`,
`--commit`, `--title`) and its own output shape. Wrapping it as `codex_review` gives the
orchestrator a second opinion on a diff from a different model family, which is the most obviously
valuable thing a cross-model setup can offer.

Open question: whether review findings are worth parsing into a structured list, or whether the
prose summary is enough for the orchestrator to act on.

## v0.8 — Structured results

`codex exec --output-schema <FILE>` constrains the model's final response to a JSON Schema. Today
the orchestrator receives prose and has to re-read it. An optional `output_schema` parameter would
let a delegation return, for example, a list of findings with file, line and severity — parseable
without a second model call.

Requires writing the schema to a temporary file and cleaning it up, including when the run is
killed.

## v0.9 — Cost and configuration

- Per-delegation accounting: token usage is already captured per run but discarded afterwards. A
  local rolling summary would let the orchestrator notice it is spending `xhigh` effort on work that
  `low` would have handled.
- Codex profiles (`-p/--profile`), so a project can pin a named Codex configuration.
- `--add-dir` ergonomics for monorepos, where the interesting code sits outside the working root.

## v1.0 — Hardening

- Integration tests that exercise the real CLI, gated behind an environment variable so the default
  `npm test` stays free and offline.
- Background jobs surviving a restart, if real usage shows it matters. Today they live only in the
  server process.

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
