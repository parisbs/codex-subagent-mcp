# 12. Provide mechanism, not policy

Status: Accepted

Supersedes part of [ADR 3](0003-read-the-catalog-from-the-cli.md), which introduced the
recommendation matrix as the default path for delegations.

## Context

`codex_delegate` used to pick a model when the caller did not specify one. A regular expression
matched the task description against a tier, and the tier named a model and a reasoning effort. The
result mentioned the choice in a note, after the delegation had run and been paid for.

Those tiers are an opinion. They were derived from how the Codex catalog describes its own models,
and they encode assumptions that do not generalise: that a multi-file migration deserves high effort,
that a race condition deserves the most capable model. Which model a task actually deserves depends
on the user's budget, their tolerance for latency, how much a wrong answer costs them, and how much
they trust each model. None of that is derivable from the text of a prompt.

Two related ideas were considered and rejected for the same reason.

A **triage skill** for Claude Code, shipping criteria for when to delegate. It would encode one
person's workflow as the project's recommended one. It also could not be distributed: skills do not
travel in an npm package.

**User-defined triage rules** inside the server, replacing the matrix with the user's own patterns.
This would reimplement, worse, something the user already has. Regular expressions over a task
description are a poor classifier; the orchestrating model is a good one. A user who writes their
escalation criteria in plain language in their own `CLAUDE.md` gets semantic understanding and ends
up passing the right parameters — strictly better than any rule table this server could offer.

## Decision

The server provides mechanism. The user provides policy.

Delegating, choosing a model, setting an effort, isolating in a worktree, running in the background:
mechanism, and it stays. Deciding *when* to escalate: policy, and it leaves.

Concretely:

- **The server never chooses a model silently.** With no model in the call and none configured, the
  delegation is refused — and the refusal carries the recommendation it would have made, so the
  caller can decide in one more round trip instead of being billed for a guess.
- **The matrix survives as advice, not as a decision.** It answers `codex_recommend` and fills in
  that refusal message. It is never on the execution path.
- **Policy is configured through the environment**, using the mechanism MCP clients already have.
  Five variables: `DEFAULT_MODEL`, `DEFAULT_EFFORT`, `ALLOWED_MODELS`, `MAX_SANDBOX`, `MAX_EFFORT`.
- **Configuration may only restrict.** There is no setting that makes delegations more permissive
  than the defaults. Notably there is no configurable default sandbox: its only real use would be
  making `workspace-write` the baseline to avoid repeating it, which is trading away the safety
  [ADR 5](0005-read-only-by-default.md) established, for typing.
- **An allow-list of exactly one model is treated as a default.** Nothing is left to decide, so
  refusing there would be friction with no decision behind it.

Ceilings behave differently by kind, and the difference is deliberate. A sandbox above the ceiling is
**refused**: the caller asked for write access because the task needs it, and quietly running
read-only would produce a delegation that cannot do its job and does not say so. An effort above the
ceiling is **clamped** with a note: less deliberation makes the task worse, not impossible.

## Consequences

No delegation is paid for on this server's judgement. Every model choice is either the caller's or
the user's, and visible in the call.

`MAX_SANDBOX` closes a gap `SECURITY.md` previously listed as undefended. A prompt is untrusted
input, and a write-enabled delegation built from untrusted content can direct Codex to modify the
repository. A sandbox ceiling makes that impossible rather than unlikely, which is the one control
that cannot be expressed by passing parameters — a caller can always pass different ones.

The cost is one extra round trip the first time a session delegates without a model. It is real, and
`DEFAULT_MODEL` removes it for anyone who does not want it. The refusal carries the suggestion
precisely so that round trip is informed rather than a bare rejection.

Invalid configuration is reported on the first tool call rather than at startup. A server that
refuses to start cannot explain why: the user would see a tool that is simply absent. This mirrors
how a missing Codex CLI is handled.

What this deliberately does not do: infer policy from usage, learn preferences, or add a rules
engine. Each would be this server deciding again, with more machinery.
