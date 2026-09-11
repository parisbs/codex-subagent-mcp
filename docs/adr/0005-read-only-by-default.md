# 5. Default to a read-only sandbox

Status: Accepted

## Context

The prototype defaulted `autonomous` to `true`, which added `--approve-for-me` so Codex approved its
own commands and edited files without asking. A delegation triggered by a single tool call could
modify the user's working tree before anyone saw the plan.

Codex offers three sandbox policies: `read-only`, `workspace-write` and `danger-full-access`. The
choice is not only about safety — it changes what the delegation *is*. A read-only delegation is an
investigation that returns findings. A workspace-write delegation is an implementation that returns
a modified tree. The orchestrator wants both, at different times, and should say which.

## Decision

Default to `read-only`. Writing requires an explicit `sandbox: "workspace-write"`.

When the sandbox is read-only, prepend an `<execution_mode>` block telling Codex it cannot modify
files and should describe changes precisely rather than attempt them — otherwise it wastes the run
discovering the restriction.

`auto_approve` (which adds `--approve-for-me`) is off by default and is ignored, with a note, when
the sandbox is read-only.

Offer `use_worktree` so a writing delegation can land in a managed git worktree instead of the
user's working tree.

## Consequences

The failure mode of a mistaken delegation is a wasted model call, not an unwanted edit. The
orchestrator opts into write access per call, which is also a useful signal in the transcript: it
is visible when a delegation was allowed to change files.

Investigation is the common case and it is now the cheap, safe default.

The cost is a parameter the caller must remember for implementation work. A delegation that was
meant to edit files and did not will report what it would have changed, which is recoverable — the
inverse mistake is not.

`danger-full-access` remains reachable for callers who need it, but auto-approval is never combined
with it: an unsandboxed run that also approves its own commands has no check left at all.

This decision interacts with a CLI constraint found during verification: `--approve-for-me` already
implies the workspace-write sandbox and cannot be passed alongside `--sandbox`. The argv builder
substitutes one for the other rather than sending both.
