# 27. Opt in to the extended doctor report

Status: Accepted

## Context

The cheap preflight reports installation, version, authentication and configuration failures in
the caller's working directory. Codex's `doctor --json` additionally reports configured settings
and startup warnings, but its runtime grows with provider, update and HTTP MCP probes. Running it
automatically would add network traffic and unpredictable latency to every delegation.

[Issue #69](https://github.com/parisbs/codex-subagent-mcp/issues/69) records observations from
codex-cli 0.162.0 and older source shapes. The report is an internal format: fields change within
schemaVersion 1, and paths remain in the CLI's redacted output. A failure in an unrelated doctor
check can make a usable report exit nonzero.

## Decision

Add `extended: boolean`, default false, to the existing `codex_doctor` tool rather than introducing
a separate tool. This keeps one place to ask about the CLI, with an explicit costlier mode. It
never runs during startup, the shared preflight, or automatically. Each opt-in call runs afresh;
there is no cache or extra concurrency cap, and `refresh` affects only the cheap probes.

Keep the cheap text and `isError` unchanged and append the extended section as a second text item.
Run the resolved executable with exactly `doctor --json`, no shell, ignored stdin, the inherited
environment, and the requested directory or the server's own. A parsed CLI version permits the
run even when authentication or configuration failed. Skip unavailable executables, cancelled
requests and calls after shutdown begins.

Use a whitelist for `config.load`: status, summary, remediation, configuration scope, model and
provider, feature flags, startup warning count/texts, error, decimal line/column, and a reduced
`config.toml parse` state. Omit other details, checks, issues and notes. Wrong types are omitted
individually. Unknown status is unrecognised rather than healthy. The displayed model is labelled
`configured model`, since it need not be the model a delegation applies. Quote and escape strings,
limit each to 2,000 code points and warning texts to ten, and cap the section at 16,384 code points
with explicit cut markers. Formatting this section lives in `src/codex/doctor-report.ts`.

Impose a 60 s deadline from spawn, cap stdout at 1 MiB, and drain stderr while retaining at most
64 KiB. Never parse a stopped run or echo raw output. Recognise usable schemaVersion 1 reports
regardless of exit code before classifying unsupported schemas or failures without reports.

Track the run in `ActiveRuns` using its minimal lifecycle handle. Reuse the process-tree
termination helpers, with SIGINT followed by SIGKILL, and honour shutdown's shared forced instant
and single process-table read. Request cancellation, timeout and oversized stdout stop the tree.
Record shutdown even when the registry is empty, preventing later extended spawns.

## Consequences

The caller can inspect configuration warnings without changing normal preflight latency or error
semantics. This is a slow, networked mode, potentially taking over a minute including cheap probes.
It contacts enabled HTTP MCP servers even when delegation inheritance disables them and writes
the support files ordinary Codex invocations write. The tool therefore advertises
`openWorldHint: true`, retains `readOnlyHint: true`, and says it never installs or repairs anything.

The whitelist reduces irrelevant output but does not remove paths from permitted warning text.
The deadline can cut short legitimate large configurations; such a result explicitly reports a
timeout and produces no partial summary. Independent concurrent calls can duplicate network work.
Internal report formats remain a compatibility risk, addressed by captured fixtures, explicit
unsupported cases and checking the shared argv constant in the CLI compatibility shapes.
