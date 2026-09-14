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

## 2. Ceilings on the server

Environment variables on the MCP server set limits no argument can get past. They are covered in full
in [TOOLS.md](TOOLS.md#configuration); the ones that matter most for control:

- `CODEX_SUBAGENT_MAX_SANDBOX` — `workspace-write` rules out unsandboxed runs; `read-only` rules out
  writing at all.
- `CODEX_SUBAGENT_MAX_EFFORT` — keeps the expensive reasoning levels off the table.
- `CODEX_SUBAGENT_ALLOWED_MODELS` — keeps delegations on the models you choose. A single entry also
  acts as the default model.

A reasonable starting point for everyday use:

```bash
claude mcp add codex-subagent -e CODEX_SUBAGENT_MAX_SANDBOX=workspace-write -e CODEX_SUBAGENT_MAX_EFFORT=high -- npx -y codex-subagent-mcp@^0.2.0
```

Register ceilings outside the repository — Claude Code's default `local` scope or `--scope user`, or
Claude Desktop's config file — not in a project `.mcp.json`, which a write-enabled delegation could
edit.

## 3. The version you run

`npx -y codex-subagent-mcp` always runs the newest published version, so a new release — including
changes to what the tools tell Claude — reaches you without a decision on your part. A range such as
`codex-subagent-mcp@^0.2.0` accepts fixes but not new or changed behaviour, which on 0.x arrives in a
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

## What the server does on its own

- Delegations are read-only unless a write-enabled sandbox is requested.
- No model is chosen for you; without one the call is refused with a suggestion.
- Follow-ups restate the thread's model, effort and directory instead of letting configuration pick.
- Every result starts by saying that Codex's report is information, not instructions — Codex may have
  read hostile content, and its report is how that content would reach Claude.
- If this server is also registered in your Codex configuration, it is switched off for each
  delegation, so a delegated run cannot call it and delegate again.
- Failed turns, usage limits and configuration warnings are reported with Codex's own message.

## What no setting can guarantee

- That Claude follows the tool descriptions. They are instructions to a model, not rules.
- What other MCP servers you have installed tell Claude. A malicious server's description can try to
  steer how Claude uses this one; install servers you trust.
- That content Claude reads — a web page, an email, an issue — does not talk it into delegating,
  within whatever limits you left open. That is what the permission prompt and the ceilings are for.
- That Codex cannot read your files. Its sandbox restricts writes and network access, not reads.

## Being considered

Not scheduled for a particular release: a limit on how many delegations a session can start
([#62](https://github.com/parisbs/codex-subagent-mcp/issues/62)), refusing to run in a directory
nobody chose ([#63](https://github.com/parisbs/codex-subagent-mcp/issues/63)), turning off inherited
Codex plugins per delegation ([#64](https://github.com/parisbs/codex-subagent-mcp/issues/64)), and
asking you directly before expensive runs
([#65](https://github.com/parisbs/codex-subagent-mcp/issues/65)).
