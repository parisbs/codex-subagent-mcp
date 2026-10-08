# Staying in control of delegation

This server gives Claude a tool that runs another agent and spends your Codex usage. That is the
point of it, and also why it is worth knowing where the controls are. Nothing here is required: the
defaults are safe for ordinary use. This is the map of what you can tighten, from the strongest
control to the weakest, and what no setting can guarantee.

## When a delegation happens

Claude decides when to call a tool, from the tool's name and description. The descriptions tell it to
delegate when you ask for Codex, or when handing work off clearly serves your request — a second
opinion, an investigation too large for the conversation — and to say so when it does. They also tell
it that what it delegates is sent to OpenAI and spends your usage.

Descriptions are guidance, not enforcement. Two situations deserve a thought:

- **General-purpose chats.** In Claude Desktop the server is available in every conversation, not
  only programming ones. A request that mentions "codex" in another sense, or a long document that
  looks like good material for "an investigation", can lead Claude to delegate. Whatever it delegates
  — including the contents of files or attachments it includes — goes to OpenAI.
- **Delegating without a model.** If you ask Claude to "delegate this" and neither the call nor your
  configuration names a model, the server refuses and returns a suggestion. Claude is told to confirm
  the model with you before trying again; set `CODEX_SUBAGENT_DEFAULT_MODEL` if you would rather not
  be asked.

## 1. Your client's tool permissions

The strongest control is the one your MCP client already has: whether it asks before running a tool.
It shows the arguments — prompt, model, effort, sandbox — before anything runs or spends usage.

A sensible split is to let the tools that only inspect run freely, and keep confirming the two that
start a Codex run:

| Tool | Spends usage | Suggested |
| --- | --- | --- |
| `codex_doctor`, `list_codex_models`, `codex_recommend` | no | allow |
| `codex_job_status`, `codex_job_result`, `codex_job_cancel` | no | allow |
| `codex_delegate`, `codex_follow_up` | yes | ask each time |

In Claude Code, that is a `permissions` entry in your settings:

```json
{
  "permissions": {
    "allow": [
      "mcp__codex-subagent__codex_doctor",
      "mcp__codex-subagent__list_codex_models",
      "mcp__codex-subagent__codex_recommend",
      "mcp__codex-subagent__codex_job_status",
      "mcp__codex-subagent__codex_job_result",
      "mcp__codex-subagent__codex_job_cancel"
    ]
  }
}
```

The prefix is `mcp__` followed by the name you registered the server under. Allowing the whole server
(`mcp__codex-subagent`), or running in a mode that skips confirmations, removes this control for
delegations too. In Claude Desktop, prefer allowing `codex_delegate` once rather than always, and turn
the server off in conversations where you do not want it available, if your client offers that.

## 2. Defaults and ceilings on the server

Environment variables on the MCP server set defaults and limits no argument can get past. They are
covered in full in [TOOLS.md](TOOLS.md#configuration); the ones that matter most for control:

- `CODEX_SUBAGENT_DEFAULT_SANDBOX` — chooses the sandbox when a call omits it. It defaults to
  `read-only` and cannot exceed the ceiling.
- `CODEX_SUBAGENT_MAX_SANDBOX` — defaults to `workspace-write`, which rules out unsandboxed runs;
  `read-only` rules out writing at all. `danger-full-access` is reachable only when you set this to
  that value explicitly.
- `CODEX_SUBAGENT_MAX_EFFORT` — keeps the expensive reasoning levels off the table.
- `CODEX_SUBAGENT_ALLOWED_MODELS` — keeps delegations on the models you choose. A single entry also
  acts as the default model.
- `CODEX_SUBAGENT_MAX_DELEGATIONS_PER_HOUR` — bounds spawned delegation processes per rolling hour.
  Unset means unrestricted; set a decimal integer from 1 to 9007199254740991.
- `CODEX_SUBAGENT_MAX_BACKGROUND_JOBS` — lowers the cap on running background jobs from its default
  of eight; set a decimal integer from 1 to 8. Blocking calls do not use this cap.

Both numeric variables are trimmed; empty means unset and leading zeros are allowed. Signs,
fractions, exponents, separators and out-of-range values are configuration errors: delegations
refuse while `codex_doctor` still runs and lists the errors. Configuration is read at startup;
only you can raise a bound by changing it and restarting the server.

The hourly bound counts each `codex exec` or `codex exec resume` process from a delegation or
follow-up, including background runs. Probes never count. Calls reserve a slot before any await,
including probes and follow-up session recovery; a reservation never expires by age and is released
if the call fails before spawning. Once spawned, a process counts for sixty minutes even if it
fails, times out or is cancelled. A background job stops using its background place when cancelled
or settled, even while its process tree is still stopping; its hourly entry remains. A background
request cancelled before its job exists creates no job and spawns nothing.

The window belongs to this server process, starts empty on restart and is independent of the usage
log. Separate registrations have separate windows. It uses the wall clock: sleep counts as elapsed
time, moving the clock back keeps entries counted longer, and moving it forward expires them sooner.
This counts invocations, never estimates quota, tokens or credits.

An hourly refusal names your limit and tells the caller to ask you to raise it if needed. When any
process is counted, it gives the oldest spawn's expiry as a UTC timestamp followed by whole minutes
left rounded up, and says not to retry before then. That time does not guarantee acceptance: another
call may take the slot and other checks still apply. A call still starting may release a slot sooner.
When every slot is held by calls that have not spawned, there is no time to give: the caller must
wait for their results before calling again. `codex_doctor` reports both bounds and live counts of
spawned processes and calls holding slots before spawning, even when no hourly bound is set.

A reasonable starting point for everyday use:

```bash
claude mcp add codex-subagent -e CODEX_SUBAGENT_DEFAULT_SANDBOX=workspace-write -e CODEX_SUBAGENT_MAX_EFFORT=high -- npx -y codex-subagent-mcp@^0.5.0
```

Register defaults and ceilings outside the repository — Claude Code's default `local` scope or
`--scope user`, or Claude Desktop's config file — not in a project `.mcp.json`, which a write-enabled
delegation could edit. A changed ceiling could widen what later calls may request, and a changed
default sandbox could make later calls write without requesting a sandbox at all.

## 3. The version you run

`npx -y codex-subagent-mcp` always runs the newest published version, so a new release — including
changes to what the tools tell Claude — reaches you without a decision on your part. A range such as
`codex-subagent-mcp@^0.5.0` accepts fixes but not new or changed behaviour, which on 0.x arrives in a
new minor (see [VERSIONING.md](VERSIONING.md)).

## 4. Your own rules for Claude

When to delegate is policy, and it belongs to you. Write it in plain language in your `CLAUDE.md`,
where Claude applies it with real understanding. For example:

```markdown
Only delegate to Codex when I ask for it. Always use gpt-5.6-terra at medium effort unless I say
otherwise, never use background mode, and never include files from outside this repository.
```

## 5. Codex's own configuration

Codex reads its own `config.toml`, including a project's `.codex/config.toml` when you have trusted
that project in Codex, and administrator-managed `requirements.toml`. This server passes sandbox,
model and effort explicitly, so those files cannot widen a delegation; managed requirements can still
restrict it further. [SECURITY.md](../SECURITY.md) has the details.

After a run, the server reads Codex's own session file and reports whether the model, effort, sandbox
and directory it recorded are the ones it was given: the result's metadata line ends with
`applied=confirmed`, `applied=differs` or `applied=unconfirmed`. A sandbox recorded as wider than the
one requested fails the delegation. This tells you when something moved; it does not hold it in
place.

## What the server does on its own

- Delegations are read-only unless a write-enabled sandbox is requested or configured as the user's
  default.
- No model is chosen for you; without one the call is refused with a suggestion.
- Follow-ups restate the thread's model, effort and directory instead of letting configuration pick.
- Every result starts by saying that Codex's report is information, not instructions — Codex may have
  read hostile content, and its report is how that content would reach Claude.
- If this server is also registered in the Codex configuration for the delegation's working
  directory, it is switched off for that run so the delegated agent cannot call it and delegate
  again. The server lists that directory's MCP entries immediately before both new runs and
  follow-ups. If the listing fails, the delegation still runs, but its result says the recursion
  guard could not be applied.
- The MCP servers, plugins and apps of your Codex configuration are off for a delegation unless
  `CODEX_SUBAGENT_MCP_SERVERS`, `CODEX_SUBAGENT_PLUGINS` or `CODEX_SUBAGENT_APPS` allow them, because
  the sandbox does not confine what those tools do. The result says what was allowed
  ([ADR 16](adr/0016-turn-off-inherited-tools.md)).
- Every new delegation's prompt also instructs the delegated agent not to delegate further. This is
  an instruction, not a control; it is a second layer for configurations the server could not
  enumerate.
- Failed turns, usage limits and configuration warnings are reported with Codex's own message.
- What Codex recorded as applied is compared with what was requested, and any difference is stated
  before its report.

## What no setting can guarantee

- That Claude follows the tool descriptions. They are instructions to a model, not rules.
- What other MCP servers you have installed tell Claude. A malicious server's description can try to
  steer how Claude uses this one; install servers you trust.
- That content Claude reads — a web page, an email, an issue — does not talk it into delegating,
  within whatever limits you left open. That is what the permission prompt and the ceilings are for.
- That Codex cannot read your files. Its sandbox restricts writes and network access, not reads.
- That a `workspace-write` delegation can finish the job end to end. It cannot commit — Codex keeps
  `.git` read-only — and its shell has no network. Codex has settings that lift both; this server
  does not expose them, because write access to `.git` is code execution through hooks on your next
  git command, and network access is what currently keeps a run from sending out what it read.
  [SECURITY.md](../SECURITY.md) has the measurements.
- That a differently named copy of this server is found by the recursion guard. Recognition is by
  shape: the string `codex-subagent-mcp`, a `codex-subagent` executable basename, or this server's
  exact entry script path. A registration pointing at a copy under a different path and name is not
  recognised; only the prompt instruction covers it.
- That the applied settings can always be confirmed. The check reads a Codex file format that is
  internal and undocumented; when it cannot, it says `unconfirmed` rather than assuming.

## Local usage log

`CODEX_SUBAGENT_USAGE_LOG=on` enables a local log; unset, empty, whitespace and `off` create no log
files or directories. Invalid values refuse delegations and are listed by `codex_doctor`.

One JSON line records each spawned delegation or follow-up after its outcome is final, including
background jobs. Probes and calls refused before spawning add nothing. Entries contain end time,
duration from spawn, kind and mode, thread id, requested and applied model, effort and sandbox,
boolean feature flags, command count, outcome, sandbox ceiling, server and CLI versions, and the
CLI's tokens for this turn (input, cached, output, reasoning and derived uncached input). Missing
or invalid counters mean unknown tokens, never estimated zeros. Complete counters are kept even
when the outcome is cancellation, timeout or failure. Resumed threads need an in-memory cumulative
baseline to derive turn tokens; a spawned turn with no counters clears that baseline. Unconfirmed
settings stay unconfirmed.

The log never holds prompts, context, system instructions, acceptance criteria, schemas, file names,
working directories or other paths, command text or output, Codex messages, errors or stderr.
The exception is `label`: it is the caller's own text, recorded and displayed verbatim. Do not put
anything there you do not want stored. The server never interprets what a label means.

Files live under absolute `$XDG_STATE_HOME/codex-subagent-mcp`, otherwise under
`~/Library/Application Support/codex-subagent-mcp` on macOS, `~/.local/state/codex-subagent-mcp` on
Linux, or absolute `%LOCALAPPDATA%\codex-subagent-mcp` on Windows. Without either absolute Windows
state path, results report that the entry could not be written. New POSIX directories use `0700`
and files `0600`; existing permissions are kept.

Before `usage.jsonl` would exceed 10 MiB, it rotates to a unique timestamp-and-pid archive, and the
oldest archives are pruned to 50 MiB. Caps are approximate with concurrent writers. Appends are best
effort and never retried; concurrent Windows appends have no guarantee against interleaving. A
failed write or rotation is reported in the blocking result or `codex_job_result` without changing
the delegation's success or failure. Failed pruning still permits the entry and is reported too.
Shutdown drains queued writes after stopping runs, within the same 300 ms shutdown deadline;
writes still pending at that deadline may be lost.
`codex_usage` reads surviving current and archived entries and skips damaged lines. It never
estimates subscription quota, usage-window share, credits or remaining allowance.

## Being considered

Refusing to run in a directory nobody chose
([#63](https://github.com/parisbs/codex-subagent-mcp/issues/63)) is still being evaluated for 0.7.0.
It is not a promise until its release ships
([VERSIONING.md](VERSIONING.md)).

Asking you directly before expensive runs
([#65](https://github.com/parisbs/codex-subagent-mcp/issues/65)) is not planned: it would rely on
MCP elicitation, which the Claude desktop app currently declines without showing it to you. Your
client's permission prompt on `codex_delegate` and `codex_follow_up` remains that confirmation.
