# 6. Offer blocking and background execution modes

Status: Accepted

## Context

A Codex delegation at high reasoning effort on a real repository can run for many minutes. MCP
clients apply a tool-call timeout, and the prototype — which buffered output and returned once —
would have been cut off well before such a run finished.

MCP has a mechanism for this. A client that passes a progress token and enables
`resetTimeoutOnProgress` extends its timeout each time the server sends a progress notification. The
CLI's `--json` stream provides exactly the events to report: session started, command started,
command finished, turn completed.

That solves duration but not concurrency. A blocking call occupies the orchestrator until it
returns, so two delegations cannot overlap, and the orchestrator cannot do anything else meanwhile.

## Decision

Support both, selected with a `mode` parameter.

`blocking` (the default) runs the delegation in the foreground and emits an MCP progress
notification for each meaningful event, which both keeps the client's timeout alive and gives the
user visible activity.

`background` returns a `job_id` immediately and runs the delegation in an in-memory registry, with
`codex_job_status`, `codex_job_result` and `codex_job_cancel` to manage it. The registry caps
concurrency, retains finished jobs for an hour, and aborts every running child on server shutdown.

Both modes enforce the same timeout.

## Consequences

Blocking is the right default: most delegations are a step in a larger task, and the orchestrator
needs the answer before continuing. Progress notifications make a long run legible instead of
looking hung.

Background enables parallel delegations and lets the orchestrator keep working, at the cost of a
polling cycle it has to remember to complete. A job whose result is never read is wasted quota, so
`codex_job_status` always points at `codex_job_result` once a job finishes.

Jobs live in the server process. If Claude Code restarts, they are gone. Persisting them would mean
owning a state store and reattaching to orphaned children — deferred until real usage shows it
matters.

Progress notifications are best-effort: a failed send is swallowed, because a dropped notification
must never fail the delegation it was describing.
