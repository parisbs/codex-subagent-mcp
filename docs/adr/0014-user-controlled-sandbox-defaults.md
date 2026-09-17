# 14. Make sandbox defaults user-controlled and unsandboxed access opt-in

Status: Accepted

Supersedes only the **configuration may only restrict** clause of
[ADR 12](0012-mechanism-not-policy.md). Its other decisions remain accepted.

## Context

ADR 12 made `read-only` an invariant default and allowed configuration only to restrict what a
caller could request. That kept a call from granting itself more access, but combined two different
actors into one rule: the user who configures the server and the orchestrating model that supplies a
tool argument.

The distinction matters in both directions. Someone who deliberately delegates edits throughout the
day should be able to choose `workspace-write` once, outside the repository, instead of relying on
every tool call to repeat it. A missed argument otherwise spends a run on a patch that Codex can only
describe.

At the same time, an unconfigured server allowed any call to request `danger-full-access`. That mode
removes the sandbox entirely, including its network boundary. The `sandbox` argument is filled in by
an orchestrating model, and that model's judgement can be influenced by repository files, web pages,
issues and other content it has read. Removing the sandbox must therefore be a deliberate human act,
not something a tool call can request on a fresh installation.

## Decision

Sandbox policy has a default and a ceiling, both read from the MCP server environment:

- `CODEX_SUBAGENT_DEFAULT_SANDBOX` is used when a call omits `sandbox`. It accepts the same values as
  the tool parameter and defaults to `read-only`.
- `CODEX_SUBAGENT_MAX_SANDBOX` remains the ceiling no call may exceed, but its built-in value is now
  `workspace-write`. `danger-full-access` is reachable only when the user sets the ceiling to that
  value explicitly.
- A configured default above the ceiling is invalid configuration. As with other conflicting
  defaults and ceilings, the error is collected during configuration loading and reported on the
  first tool call rather than preventing server registration.
- An explicit tool argument still overrides the default when it is at or below the ceiling. A value
  above the ceiling is refused rather than silently lowered.

A default the user sets for themselves in the MCP server environment is policy supplied outside the
repository. It is not equivalent to a caller widening its own run. This distinction supersedes only
ADR 12's statement that configuration may only restrict; the server still does not choose a model,
the recommendation matrix remains advice, and callers remain bounded by user-configured ceilings.

## Consequences

A fresh installation is read-only when the caller says nothing, permits callers to request
`workspace-write`, and refuses `danger-full-access`. Enabling unsandboxed runs now requires a visible
environment setting controlled by the user.

Users who want write-enabled delegation by default can set
`CODEX_SUBAGENT_DEFAULT_SANDBOX=workspace-write` without changing each call. They should keep that
setting, like the ceiling, outside the working tree: a project `.mcp.json` editable by an earlier
delegation could otherwise raise the default for the next server process.

This is a breaking change for installations that relied on an absent ceiling while requesting
`danger-full-access`. The project is still in 0.x, so it will receive a minor version bump when a
release is prepared; this decision does not itself change a version or the changelog.
