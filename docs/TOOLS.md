# Tool reference

Complete reference for the eight tools this server exposes. The [README](../README.md) covers what
to use them for; this covers every parameter.

Codex cannot see the orchestrator's conversation. Everything a delegation needs has to arrive in
`prompt`, `context`, `target_files` and `acceptance_criteria`.

---

## Configuration

Set through environment variables on the MCP server, which is the mechanism MCP clients already
have:

```bash
claude mcp add codex-subagent \
  -e CODEX_SUBAGENT_DEFAULT_MODEL=gpt-5.6-terra \
  -e CODEX_SUBAGENT_MAX_SANDBOX=read-only \
  -- npx -y codex-subagent-mcp
```

| Variable | Effect |
| --- | --- |
| `CODEX_BIN` | Path to the Codex executable, if it is not `codex` on `PATH`. |
| `CODEX_SUBAGENT_DEFAULT_MODEL` | Model used when a call specifies none. Unset means the call is refused with a suggestion rather than guessed at. |
| `CODEX_SUBAGENT_DEFAULT_EFFORT` | Effort used when a call specifies none. Unset means the model's own default from the catalog. |
| `CODEX_SUBAGENT_ALLOWED_MODELS` | Comma-separated allow-list. Any other model is refused, and excluded models are hidden from `list_codex_models`. A list of exactly one acts as the default. |
| `CODEX_SUBAGENT_MAX_SANDBOX` | The most permissive sandbox allowed. A call asking for more is **refused**. |
| `CODEX_SUBAGENT_MAX_EFFORT` | The highest reasoning effort allowed. A call asking for more is **clamped**, with a note. |

Two rules govern all of this, and are explained in
[ADR 12](adr/0012-mechanism-not-policy.md):

**The server never chooses a model silently.** Which model a task deserves depends on your budget and
on how costly a wrong answer is. With no model in the call and none configured, the delegation is
refused — and the refusal includes the recommendation it would have made.

**Configuration may only restrict.** There is no setting that makes delegations more permissive than
the defaults, which is why there is no configurable default sandbox: `read-only` stays the floor and
a ceiling can only lower what a caller may reach.

Ceilings differ by kind on purpose. A sandbox above the ceiling is refused, because the caller asked
for write access for a reason and running read-only anyway would fail the task silently. An effort
above the ceiling is clamped, because less deliberation makes the task worse rather than impossible.

Invalid values are reported on the first tool call, not at startup — a server that refuses to start
cannot explain why.

---

## `codex_doctor`

Checks whether the local Codex CLI is installed, recent enough and signed in, and reports the exact
steps to fix it if not. Inspects only; it never installs or changes anything.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `refresh` | boolean | `false` | Re-probe the CLI instead of reusing the cached diagnosis. |

Reported states:

| Status | Meaning | Usable |
| --- | --- | --- |
| `ok` | Installed, signed in, at or above the verified version. | yes |
| `unverified-version` | Older than the version this server was verified against. | yes, with a warning |
| `missing` | The CLI could not be run at all. | no |
| `unauthenticated` | Installed, but no account is signed in. | no |
| `unsupported-shim` | Found only as a Windows `.cmd`/`.bat` shim, which cannot be spawned safely. | no |

Every other tool runs this check first, so a broken installation is reported the same way whichever
tool you happen to call.

---

## `list_codex_models`

Lists the models available on this machine with the reasoning-effort levels each one supports. Read
from the installed CLI at runtime, never hardcoded, so new models appear without a release here.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `refresh` | boolean | `false` | Bypass the ten-minute cache and re-read the catalog. |

A `WARNING:` line means the live catalog could not be read and a static fallback was used. Treat the
slugs below it as unconfirmed.

---

## `codex_recommend`

Suggests a model and reasoning effort for a task. Runs no model call; it applies a documented matrix
and reconciles it against the live catalog.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `task_description` | string | required | What the task involves, in a sentence or two. |
| `priority` | `quality` \| `balanced` \| `latency` \| `cost` | `balanced` | Biases the effort up or down. |

---

## `codex_delegate`

Runs a task on the local Codex CLI.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `prompt` | string | required | The task. Self-contained. |
| `model` | string | required unless configured | A slug from `list_codex_models`. Omitted with no `CODEX_SUBAGENT_DEFAULT_MODEL` set means the call is refused with a suggestion. |
| `reasoning_effort` | `low` … `ultra` | model default | Clamped to what the model supports, with a note. |
| `system_instructions` | string | — | Persona or extra rules, layered on the built-in quality contract. |
| `context` | string | — | Background: prior findings, constraints, relevant excerpts. |
| `target_files` | string[] | — | Paths to focus on, relative to `working_dir`. |
| `acceptance_criteria` | string[] | — | Conditions that must hold for the task to be done. |
| `working_dir` | string | CLI default | Absolute path. Validated before any model call. |
| `sandbox` | `read-only` \| `workspace-write` \| `danger-full-access` | `read-only` | What Codex may do. |
| `auto_approve` | boolean | `false` | Codex approves its own commands. Implies `workspace-write`; ignored under `read-only`. |
| `add_dirs` | string[] | — | Extra absolute directories writable alongside `working_dir`. |
| `use_worktree` | boolean | `false` | Writes land in a managed git worktree under `~/.codex/worktrees/`, never your working tree. Uses an experimental Codex feature, enabled for that invocation only. |
| `web_search` | boolean | `false` | Enable Codex's native web search. |
| `skip_git_repo_check` | boolean | `false` | Allow running outside a git repository. |
| `timeout_seconds` | integer | `1800` | The run is terminated past this budget. Max 7200. |
| `mode` | `blocking` \| `background` | `blocking` | `background` returns a `job_id` immediately. |

### What comes back

A blocking delegation returns the final message, the files it changed (with the path each landed
at), the commands it ran with their exit codes, the token usage, the duration, the model and effort
actually used, and a `thread_id` for follow-ups.
Anything Codex reported as an in-band error is surfaced separately — those do not change its exit
code, so they would otherwise be lost.

Progress is reported through MCP progress notifications as the run proceeds, which is also what
keeps a long delegation from being cut off by the client's tool timeout.

### Sandbox

`read-only` is the default: Codex investigates and reports, and the prompt tells it so explicitly so
it does not waste the run discovering the restriction. Writing requires
`sandbox: "workspace-write"`. `use_worktree` confines those writes to a managed git worktree, which
the server does not clean up — a worktree may hold changes you have not applied yet.

---

## `codex_follow_up`

Continues a previous delegation using its `thread_id`. Codex still holds the earlier context, so
this is far cheaper than re-sending it.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `thread_id` | string | required | Reported by a previous `codex_delegate`. |
| `prompt` | string | required | The follow-up instruction. |
| `model` | string | session default | Pass the model the original run used. |
| `reasoning_effort` | `low` … `ultra` | session default | Override for this turn. |
| `sandbox` | see above | `read-only` | Applied as a config override; `resume` has no sandbox flag. |
| `auto_approve` | boolean | `false` | |
| `working_dir` | string | — | |
| `timeout_seconds` | integer | `1800` | |

Pass the same `model` the original delegation used. Without it Codex resumes with your configured
default and reports the mismatch as an in-band error, which this server surfaces.

---

## `codex_job_status`

Reports the state and recent activity of a background delegation. Called with no `job_id`, it lists
every known job.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `job_id` | string | — | Omit to list all jobs. |
| `include_activity` | boolean | `false` | Include the recent progress log. |

States: `running`, `completed`, `failed`, `cancelled`.

---

## `codex_job_result`

Returns the full output of a finished background delegation. Errors if the job is still running.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `job_id` | string | required | Returned by `codex_delegate` in background mode. |

---

## `codex_job_cancel`

Terminates a running background delegation.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `job_id` | string | required | Returned by `codex_delegate` in background mode. |

---

## Limits on background jobs

At most eight run concurrently. Finished jobs are kept for an hour, then discarded. All running jobs
are cancelled when the server shuts down, so nothing keeps burning quota with nobody reading the
result.

Jobs live only in the server process: restarting Claude Code loses them. See the
[roadmap](ROADMAP.md).
