# 1. Use the local Codex CLI instead of the OpenAI API

Status: Accepted

## Context

The server's purpose is to let Claude Code delegate real coding work to an OpenAI model. There are
two ways to reach one: call the OpenAI API directly over HTTP, or drive the Codex CLI that is
already installed and authenticated on the developer's machine.

Delegated coding work is not a single completion. It is an agentic loop: read files, run commands,
inspect output, apply patches, decide what to do next. Everything that makes that loop safe and
useful — the sandbox policies, the approval model, tool definitions, session persistence, project
instruction files, the compaction strategy for long runs — lives in the Codex client, not in the
model endpoint.

## Decision

Shell out to the local Codex CLI (`codex exec`). Do not call the OpenAI API.

Authentication, quota and model access are whatever the user's existing `codex login` already
grants. The server holds no API key and no credentials of its own.

## Consequences

The agentic loop, the sandbox and the approval machinery come for free and stay current as the user
updates their CLI. The server stays small: it composes a prompt, builds an argv, and parses a JSONL
stream.

Nothing leaves the machine that was not already going to leave it through Codex. There is no second
credential to manage or leak.

The cost is coupling to a CLI whose flags change between versions, and which is not a stable API.
That coupling is real and has already bitten: `codex exec resume` accepts a much smaller flag set
than `codex exec`, and `--approve-for-me` cannot be combined with `--sandbox`. It is contained by
keeping all argv construction in one module and covering the known traps with tests, but it will
need periodic re-verification against new CLI releases.

The server also inherits the CLI's failure modes. A CLI that is missing, unauthenticated or out of
quota surfaces as a delegation error, so those errors are reported with the actual stderr rather
than a generic failure.
