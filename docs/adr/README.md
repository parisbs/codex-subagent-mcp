# Architecture Decision Records

Each record captures one decision, the situation that forced it, and what it costs. Format follows
Michael Nygard's: Context, Decision, Consequences.

See also [VERSIONING.md](../VERSIONING.md) for what counts as a breaking change, and
[ROADMAP.md](../ROADMAP.md) for what is planned and what is deliberately out of scope.

A record's status is the `status` field of its YAML front matter. A record is not edited once its
status on `main` is accepted or rejected — it is superseded by a later one, which links back. The
superseded record changes in its front matter status only, naming its successor, and the status
column below says the same. That way the reasoning behind a past choice stays readable even after the
choice changes. There is no exception for facts that became untrue; see
[0015](0015-agents-md-and-immutable-records.md), [0019](0019-name-the-successor-in-the-status-line.md)
and [0029](0029-keep-the-status-in-front-matter.md).

| # | Title | Status |
| --- | --- | --- |
| [0001](0001-use-the-local-codex-cli.md) | Use the local Codex CLI instead of the OpenAI API | Accepted |
| [0002](0002-model-and-effort-are-independent.md) | Treat model and reasoning effort as independent axes | Accepted |
| [0003](0003-read-the-catalog-from-the-cli.md) | Read the model catalog from the CLI at runtime | Accepted; the startup-probe and fallback parts superseded by [0009](0009-preflight-the-codex-cli.md), the recommendation matrix as the default path by [0012](0012-mechanism-not-policy.md) |
| [0004](0004-spawn-with-argv-and-stdin.md) | Invoke the CLI with argv and deliver the prompt on stdin | Accepted |
| [0005](0005-read-only-by-default.md) | Default to a read-only sandbox | Accepted; superseded in part by [0014](0014-user-controlled-sandbox-defaults.md) |
| [0006](0006-two-execution-modes.md) | Offer blocking and background execution modes | Accepted |
| [0007](0007-inject-the-quality-contract.md) | Inject the quality contract into the prompt | Accepted |
| [0008](0008-typescript-and-the-high-level-sdk.md) | Build on TypeScript and the high-level MCP SDK | Accepted |
| [0009](0009-preflight-the-codex-cli.md) | Preflight the Codex CLI before every tool call | Accepted |
| [0010](0010-distribution-strategy.md) | Distribute through npm, with the registry and bundles layered on top | Accepted |
| [0011](0011-resolve-the-executable-without-a-shell.md) | Resolve the Codex executable without a shell | Accepted |
| [0012](0012-mechanism-not-policy.md) | Provide mechanism, not policy | Accepted; superseded in part by [0014](0014-user-controlled-sandbox-defaults.md) |
| [0013](0013-confirm-applied-settings.md) | Confirm what Codex applied instead of re-implementing its configuration | Accepted; that a read of the session file never decides anything, for the directory a follow-up resumes in, superseded by [0020](0020-let-the-session-file-decide-where-a-follow-up-resumes.md) |
| [0014](0014-user-controlled-sandbox-defaults.md) | Make sandbox defaults user-controlled and unsandboxed access opt-in | Accepted |
| [0015](0015-agents-md-and-immutable-records.md) | Keep agent instructions in AGENTS.md and records immutable | Accepted; the AGENTS.md decision superseded by [0018](0018-keep-agent-instructions-in-claude-md-alone.md), the status kept in the index alone by [0019](0019-name-the-successor-in-the-status-line.md), immutability from the merge by [0029](0029-keep-the-status-in-front-matter.md) |
| [0016](0016-turn-off-inherited-tools.md) | Turn off the MCP servers, plugins and apps a delegation inherits | Accepted |
| [0017](0017-define-1-0-as-the-interface-freeze.md) | Define 1.0 as the freeze of the public interface | Accepted |
| [0018](0018-keep-agent-instructions-in-claude-md-alone.md) | Keep agent instructions in CLAUDE.md alone | Accepted |
| [0019](0019-name-the-successor-in-the-status-line.md) | Name the successor in a superseded record's status line | Accepted; the successor named in a `Status:` line rather than in the front matter status superseded by [0029](0029-keep-the-status-in-front-matter.md) |
| [0020](0020-let-the-session-file-decide-where-a-follow-up-resumes.md) | Let the session file decide where a follow-up resumes | Accepted |
| [0021](0021-report-the-base-of-a-worktree-run.md) | Report the base of a worktree run | Accepted; the read of the caller's working tree with git, and the prompt names and result notes built from it, superseded by [0026](0026-report-a-worktree-run-from-the-session-file-alone.md) |
| [0022](0022-keep-an-opt-in-local-usage-log.md) | Keep an opt-in local usage log | Accepted; the characters a label may contain superseded by [0024](0024-settle-the-open-details-of-the-usage-log.md) |
| [0023](0023-bound-delegations-in-memory.md) | Bound delegations per hour, in memory | Accepted; the refusal when every slot is held by calls that have not spawned superseded by [0025](0025-settle-the-open-details-of-the-delegation-bound.md) |
| [0024](0024-settle-the-open-details-of-the-usage-log.md) | Settle the open details of the usage log | Accepted |
| [0025](0025-settle-the-open-details-of-the-delegation-bound.md) | Settle the open details of the delegation bound | Accepted |
| [0026](0026-report-a-worktree-run-from-the-session-file-alone.md) | Report a worktree run from the session file alone | Accepted |
| [0027](0027-opt-in-to-the-extended-doctor-report.md) | Opt in to the extended doctor report | Accepted |
| [0028](0028-describe-the-instance-in-server-instructions.md) | Describe the instance in server instructions, not in tool descriptions | Accepted |
| [0029](0029-keep-the-status-in-front-matter.md) | Keep the status in front matter and freeze records on acceptance | Accepted |
| [0030](0030-recognise-a-capacity-failure-from-the-session-file.md) | Recognise a capacity failure from the session file | Accepted |
