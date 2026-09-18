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
claude mcp add codex-subagent -e CODEX_SUBAGENT_DEFAULT_MODEL=gpt-5.6-terra -e CODEX_SUBAGENT_MAX_SANDBOX=read-only -- npx -y codex-subagent-mcp
```

Kept on one line on purpose: a trailing `\` continues a line only in POSIX shells, not in PowerShell
or cmd.exe, so this form runs unchanged on macOS, Linux and Windows.

| Variable | Effect |
| --- | --- |
| `CODEX_BIN` | Path to the Codex executable, if it is not `codex` on `PATH`. On Windows it must be `codex.exe`, not a `.cmd` shim. |
| `CODEX_HOME` | Codex's own variable, read here too: it is where the session files that confirm a run's applied settings are looked up. Unset means `~/.codex`. |
| `CODEX_SUBAGENT_DEFAULT_MODEL` | Model used when a call specifies none. Unset means the call is refused with a suggestion rather than guessed at. |
| `CODEX_SUBAGENT_DEFAULT_EFFORT` | Effort used when a call specifies none. Unset means the model's own default from the catalog. |
| `CODEX_SUBAGENT_ALLOWED_MODELS` | Comma-separated allow-list. Any other model is refused, and `codex_recommend` never suggests one. `list_codex_models` still lists excluded models, marked as blocked, so you can see what the restriction costs. A list of exactly one acts as the default. |
| `CODEX_SUBAGENT_DEFAULT_SANDBOX` | Sandbox used when a call specifies none. Unset means `read-only`. It cannot be more permissive than `CODEX_SUBAGENT_MAX_SANDBOX`. |
| `CODEX_SUBAGENT_MAX_SANDBOX` | The most permissive sandbox allowed. Unset means `workspace-write`; reaching `danger-full-access` requires setting it to that value explicitly. A call asking for more is **refused**. |
| `CODEX_SUBAGENT_MAX_EFFORT` | The highest reasoning effort allowed. A call asking for more is **clamped** to the closest level the chosen model supports at or below it, with a note. If the model supports no level at or below it, the call is **refused** and nothing runs. Recommendations respect it too, and skip models with no level under it. |

Two rules govern all of this, and are explained in
[ADR 12](adr/0012-mechanism-not-policy.md) and
[ADR 14](adr/0014-user-controlled-sandbox-defaults.md):

**The server never chooses a model silently.** Which model a task deserves depends on your budget and
on how costly a wrong answer is. With no model in the call and none configured, the delegation is
refused — and the refusal includes the recommendation it would have made.

**A caller cannot widen the user's policy.** The user may choose a more permissive default sandbox
outside the repository, but a call can never exceed `CODEX_SUBAGENT_MAX_SANDBOX`. That ceiling is
`workspace-write` when unset, so removing the sandbox requires the user to opt in explicitly.

Ceilings differ by kind on purpose. A sandbox above the ceiling is refused, because the caller asked
for write access for a reason and running read-only anyway would fail the task silently. An effort
above the ceiling is clamped, because less deliberation makes the task worse rather than impossible.

Invalid values are reported on the first tool call, not at startup — a server that refuses to start
cannot explain why.

**Keep sandbox defaults and ceilings out of the working tree.** Set them where a delegation cannot edit them: Claude
Code's default `local` scope or `--scope user` (both stored in your home directory), or Claude
Desktop's own config file. Avoid `--scope project` for them, which writes a `.mcp.json` into the
repository. A delegation with `workspace-write` can edit files in its working directory, and Codex
keeps only `.git`, `.codex` and `.agents` read-only there — not `.mcp.json`. An edited ceiling would
take effect the next time the server starts; an edited default could make later delegations write
without asking for a sandbox. `danger-full-access` removes that boundary entirely, which is one more
reason to leave its explicit opt-in outside the repository.

---

## `codex_doctor`

Checks whether the local Codex CLI is installed, recent enough, signed in and able to load its
configuration, and reports the exact steps to fix it if not. Inspects only; it never installs or
changes anything.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `refresh` | boolean | `false` | Re-probe the CLI instead of reusing the cached diagnosis. |
| `working_dir` | string | the server's working directory | Absolute directory to run the check in. Codex loads the configuration of the directory it runs in, so pass the one a delegation would use. The result states which directory was checked. |

Reported states:

| Status | Meaning | Usable |
| --- | --- | --- |
| `ok` | Installed, signed in, at or above the verified version. | yes |
| `unverified-version` | Older than the version this server was verified against. | yes, with a warning |
| `missing` | The CLI could not be run at all. | no |
| `unauthenticated` | Installed, but no account is signed in. | no |
| `config-error` | Installed, but Codex cannot load its configuration (a TOML syntax error, an invalid value, a removed setting such as the top-level `profile = "…"`). Codex's own message names the file and value. This is not a sign-in problem. | no |
| `unknown` | Installed, but the sign-in check did not finish in time. | yes, with a warning |
| `unsupported-shim` | Found only as a Windows `.cmd`/`.bat` shim, which cannot be spawned safely. | no |

Every other tool runs this check first, so a broken installation is reported the same way whichever
tool you happen to call. The check — and the catalog read that follows it — runs in the directory
the delegation will run in, because that is where Codex resolves its configuration: a
`.codex/config.toml` Codex cannot parse, or a project catalog, is only visible from inside that
project. Diagnoses and catalogs are cached per directory, and only a clean diagnosis is cached, so
signing in or fixing a file takes effect without restarting the server.

---

## `list_codex_models`

Lists the models available on this machine with the reasoning-effort levels each one supports. Read
from the installed CLI at runtime, never hardcoded, so new models appear without a release here.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `refresh` | boolean | `false` | Bypass the ten-minute cache and re-read the catalog. |
| `working_dir` | string | the server's working directory | Absolute directory to read the catalog in. A project you have trusted in Codex can set its own `model_catalog_json`, so this is the directory whose models a delegation there would actually have. |

A `WARNING:` line means the live catalog could not be read and a static fallback was used. Treat the
slugs below it as unconfirmed: `codex_delegate` refuses to run while only that fallback is available,
rather than validate a paid run against a list that may not match your CLI. When the catalog cannot
be read because of a configuration problem, no fallback is shown at all; the tool reports Codex's
message instead.

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
| `reasoning_effort` | `low` … `ultra` | configured default, else the model's | Adjusted to the closest level the model supports within `CODEX_SUBAGENT_MAX_EFFORT`, with a note. |
| `system_instructions` | string | — | Persona or extra rules, layered on the built-in quality contract. |
| `context` | string | — | Background: prior findings, constraints, relevant excerpts. |
| `target_files` | string[] | — | Paths to focus on, relative to `working_dir`. |
| `acceptance_criteria` | string[] | — | Conditions that must hold for the task to be done. |
| `working_dir` | string | the server's working directory | Absolute path. Validated before any model call. Codex also reads a trusted project's `.codex/config.toml` from here. |
| `sandbox` | `read-only` \| `workspace-write` \| `danger-full-access` | configured default, else `read-only` | What Codex may do. Always passed explicitly, so Codex configuration cannot widen it. |
| `auto_approve` | boolean | `false` | Codex approves its own commands. Applies only with `workspace-write`; ignored otherwise, with a note under `read-only`. |
| `add_dirs` | string[] | — | Extra absolute directories writable alongside `working_dir`. |
| `use_worktree` | boolean | `false` | Writes land in a managed git worktree under `~/.codex/worktrees/`, never your working tree. Uses an experimental Codex feature, enabled for that invocation only. |
| `web_search` | boolean | — | `true` enables Codex's API-backed live web-search tool for this run, passed as `-c web_search="live"`. In a read-only sandbox, shell commands have no network access, so this is the route to current external information. `false` or omitted leaves Codex's own configured `web_search` mode in place; it does not turn search off. |
| `skip_git_repo_check` | boolean | `false` | Allow running outside a git repository. |
| `timeout_seconds` | integer | `1800` | The run is terminated past this budget. Max 7200. |
| `mode` | `blocking` \| `background` | `blocking` | `background` returns a `job_id` immediately. |

### What comes back

Every result starts with one line stating that Codex's report is information from another agent,
not instructions. Codex may have read hostile content, and its report is how that content would
reach the orchestrator.

A blocking delegation returns the final message, the files it changed (with the path each landed
at), the commands it ran with their exit codes, the token usage, the duration, the model, effort and
sandbox this server passed to Codex, and a `thread_id` for follow-ups.
Anything Codex reported as an in-band error is surfaced separately — those do not change its exit
code, so they would otherwise be lost.

### What Codex actually applied

The command line is not the last word on a run: managed requirements can lower a value, a model may
not support the effort requested, and a resumed session takes what it is not given from the
configuration of the directory it runs in. So after the run, this server reads the session file
Codex writes for the thread and compares the model, effort, sandbox and working directory it
recorded against the ones it was given. The metadata line ends with `applied=confirmed`,
`applied=differs` or `applied=unconfirmed`.

| Outcome | What is reported |
| --- | --- |
| Everything matched | Nothing beyond `applied=confirmed`. |
| A different model, effort, narrower sandbox or directory | Listed before Codex's report, as requested vs applied. The delegation does **not** fail: a shallower answer is still an answer. |
| A sandbox wider than the one requested | The delegation **fails** with a security notice saying the run is already over and its commands already ran under that sandbox. |
| A model outside `ALLOWED_MODELS`, or an effort above `MAX_EFFORT` | Reported as a policy breach. The ceilings are applied when the run is built; this is what Codex ended up running. |
| Nothing could be read | `applied=unconfirmed`, with the reason. The settings shown are what was requested, not an observation. |

Confirmation is an observation, not a guarantee, and it arrives after the run. It depends on a Codex
file format that is internal and undocumented, so a change there shows up as `unconfirmed` rather
than as a wrong answer, and nothing else about the delegation depends on it. See
[ADR 13](adr/0013-confirm-applied-settings.md).

Codex also reports some warnings as error items: configuration keys it ignored in a project's
`.codex/config.toml`, or a model switch when a session resumes. Those are listed once under
"Codex notices" and never make a delegation fail. When Codex gives up on a turn (`turn.failed`) —
a usage limit, a lost connection — the reason is stated first and the delegation is reported as
failed, even if the process exited 0. A run that exits cleanly without any answer is a failure
too. Warnings Codex writes to stderr are shown on successful runs as well.

Progress is reported through MCP progress notifications as the run proceeds, which is also what
keeps a long delegation from being cut off by the client's tool timeout.

### Sandbox

`read-only` is the built-in default: Codex investigates and reports, and the prompt tells it so
explicitly so it does not waste the run discovering the restriction. Writing requires either
`sandbox: "workspace-write"` in the call or a user-set `CODEX_SUBAGENT_DEFAULT_SANDBOX=workspace-write`.
`use_worktree` confines those writes to a managed git worktree, which the server does not clean up —
a worktree may hold changes you have not applied yet.

The prompt also explains two limits of read-only verification. Commands that need to create
temporary, cache or build files can be denied by the sandbox; when that specific denial prevents a
check, the result should say the verification could not be completed rather than call it a code
defect. Permission failures that are themselves the behaviour under investigation still must be
reported as defects. Shell commands have no network access under read-only; current external
information must use Codex's web-search tool, when enabled for the run.

Before every new delegation and follow-up, the server runs `codex mcp list --json` in the directory
that run will use. It disables entries that point back to this server with
`mcp_servers.<name>.enabled=false`. If the listing fails, execution remains fail-open, but the result
says the recursion guard could not be applied. The injected prompt separately instructs the
delegated agent not to delegate further. That prompt layer is an instruction, not a control, and
covers configurations the server could not enumerate.

Self-reference recognition is by shape: the string `codex-subagent-mcp`, a `codex-subagent`
executable basename, or this server's exact entry script path. A registration pointing at a copy of
the server under a different path and name is not recognised; this is a known limitation.

---

## `codex_follow_up`

Continues a previous delegation using its `thread_id`. Codex still holds the earlier context, so
this is far cheaper than re-sending it.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `thread_id` | string | required | Reported by a previous `codex_delegate`. |
| `prompt` | string | required | The follow-up instruction. |
| `model` | string | the thread's model | Override for this turn. Required for a thread this server has no record of, unless a default model is configured. |
| `reasoning_effort` | `low` … `ultra` | the thread's effort | Override for this turn. When `model` changes, defaults to the configured or model default instead. |
| `sandbox` | see above | configured default, else `read-only` | Applied as a config override; `resume` has no sandbox flag. |
| `auto_approve` | boolean | `false` | Not supported: `true` is refused and nothing runs. |
| `working_dir` | string | the thread's directory | Absolute directory to resume in. |
| `timeout_seconds` | integer | `1800` | |

A resumed Codex session does not keep its model or effort: without them, Codex takes both from the
configuration of the directory it resumes in, switches model mid-thread and compacts the history.
So every follow-up states the model, effort and directory explicitly. The server remembers what each
thread it ran used — for up to 500 threads, in memory — and restates it; overrides go through the
same allow-list, effort ceiling and clamping as a new delegation. For a thread started by another
server process, or before a restart, there is no record: pass the `model` the original delegation
used, or the call is refused (unless `CODEX_SUBAGENT_DEFAULT_MODEL` is set).

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

At most eight run concurrently. Finished jobs are kept for an hour, and at most the 100 most recent,
then discarded. All running jobs
are cancelled when the server shuts down, so nothing keeps burning quota with nobody reading the
result.

Jobs live only in the server process: restarting Claude Code loses them. See the
[roadmap](ROADMAP.md).
