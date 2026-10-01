# 16. Turn off the MCP servers, plugins and apps a delegation inherits

Status: Proposed

## Context

A delegated `codex exec` run inherits the user's whole Codex setup: the MCP servers in the user's
configuration and in any project configuration Codex trusts, the installed plugins, and the apps
(ChatGPT connectors to external services). This server never asked for them; they arrive because
Codex loads them for every run.

[ADR 5](0005-read-only-by-default.md) made `read-only` the default on the premise that a read-only
delegation is an investigation that cannot change anything, and the README and `SECURITY.md`
describe the sandbox as blocking writes and network access. Experiments on 2026-09-30 against
codex-cli 0.159.2 on macOS (#64) showed that premise covers shell commands only:

- A shell command writing outside the working directory under `read-only` was refused by the
  sandbox ("operation not permitted"), as documented.
- An MCP tool that wrote a file outside the working directory was refused under `read-only`, but by
  the approval policy, not the sandbox: "MCP tool call requires approval, but approval policy is
  never".
- The same tool, declaring itself read-only through the MCP `readOnlyHint` annotation, ran under
  `read-only` without any approval and wrote the file. The annotation is chosen by the tool's
  author; nothing verifies it.
- Under `workspace-write` with `--approve-for-me` (this server's `auto_approve`), the tool ran
  without approval and wrote outside the working directory, which the sandbox forbids to the shell.
- MCP servers run as their own processes, outside Codex's sandbox, with the user's full
  permissions, network included.
- By default every delegation started the computer-use plugin's process, and the plugin offered a
  tool that evaluates JavaScript. In one run the model itself declined to use it for a write outside
  the workspace; that was the model's judgement, not a control, and a differently worded or injected
  prompt need not produce it.

Project trust widens this. A repository Codex trusts can register MCP servers in its own
`.codex/config.toml`, so a hostile repository could ship a server whose tools declare themselves
read-only and run unsandboxed in a delegation this server labels read-only.

The inheritance also costs tokens. With plugins and apps disabled, a minimal run's input fell from
about 13,250 to 13,700 tokens to 11,003 per request, and every tool call re-sends that context.

Three sources are involved, each with its own control in the CLI (verified on 0.159.2):

- **MCP servers** are listed by `codex mcp list --json` in the delegation's working directory, which
  includes project-level entries. Each can be turned off for one run with
  `-c mcp_servers.<name>.enabled=false`; the recursion guard already does this for this server.
- **Plugins** are listed by `codex plugin list --json`. `--disable plugins` turns all of them off,
  and `-c plugins."<id>".enabled=false` turns off one for one run; removing a single plugin this way
  removed its instructions from what the model is offered.
- **Apps** are turned off together with `--disable apps`. A per-app control was not verified.

## Decision

A delegation runs with none of these unless the user allows them, in the MCP server environment:

- `CODEX_SUBAGENT_MCP_SERVERS`: `none` (the default), `all`, or a comma-separated list of MCP server
  names. Every listed server that is not allowed is turned off for the run, as are servers allowed
  by `all` that point back at this server (the recursion guard is unchanged).
- `CODEX_SUBAGENT_PLUGINS`: `none` (the default), `all`, or a comma-separated list of plugin ids as
  `codex plugin list` prints them (`name@marketplace`).
- `CODEX_SUBAGENT_APPS`: `off` (the default) or `on`.

The same restrictions apply to `codex_delegate` and `codex_follow_up`, in blocking and background
mode. No tool parameter can relax them: like the sandbox ceiling in
[ADR 14](0014-user-controlled-sandbox-defaults.md), they are set by the user outside the
repository, because tool arguments are written by an orchestrating model whose judgement content
it has read can influence.

The control fails closed. Plugins and apps need no listing for `none` or `off`, which are global
switches; when a plugin allow-list cannot be checked against `codex plugin list`, plugins are turned
off entirely. MCP servers can only be turned off by name, so unless `CODEX_SUBAGENT_MCP_SERVERS` is
`all`, a delegation whose `codex mcp list` cannot be read is refused with the reason rather than
run with servers nobody vetted. The listing is the one the recursion guard already performs.

Filtering is by server, plugin and app, never by tool. Tool annotations are declared by each tool's
author, so a filter on `readOnlyHint` would trust exactly the claim the experiments show cannot be
trusted.

Every result states what the run was allowed, next to what Codex applied
([ADR 13](0013-confirm-applied-settings.md)), so a user can see which servers, plugins and apps a
delegation had.

`--ignore-user-config` is not used. It would also drop the user's model providers, profiles (#30)
and project trust, and would make a delegation validated against one configuration run under
another. It remains available as a stronger level if these controls prove insufficient.

## Consequences

A fresh installation's delegations reach no MCP server, plugin or app. `read-only` again means what
the documentation says for everything a delegation can call, and the fixed context per request is
smaller.

This changes a default in a way that changes what happens, so it is breaking under
[VERSIONING.md](../VERSIONING.md) and ships in a minor release. A user whose delegations relied on
an MCP server, a plugin or an app must allow it explicitly.

A failure to list MCP servers now refuses a delegation, unless `all` is allowed, instead of running
it with the recursion guard unapplied. That is a new way to fail, and the message must say how to
allow `all` or fix the listing.

`auto_approve` remains a way to run allowed tools without approval. With nothing allowed by
default, that only matters once a user allows something, and the documentation must say so.

ADR 5 stays as written; its read-only guarantee held for the shell and did not cover tools, which
this record addresses.

To verify during implementation: that the overrides are accepted by `exec resume` and on the
0.154.0 floor (its help lists `--disable` for `exec`), and whether apps can be turned off one by
one.
