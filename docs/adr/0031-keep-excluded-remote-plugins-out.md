---
status: accepted
date: 2026-10-19
---
# 31. Keep excluded remote plugins out, or turn every plugin off

Amends [ADR 16](0016-turn-off-inherited-tools.md): its per-plugin control does not reach remote
plugins on recent CLIs, and this record decides how a plugin allow-list still fails closed.

## Context

ADR 16 lets a user allow some plugins with `CODEX_SUBAGENT_PLUGINS` and turns every other installed
plugin off for the run with `-c plugins.<id>.enabled=false`, verified on codex-cli 0.159.2. Remote
plugins are installed per ChatGPT account from the `openai-curated-remote` marketplace
(`source.source` is `remote` in `codex plugin list --json`), and their skills reach the model like
any other plugin's.

On 2026-10-19 `/smoke-test` step 10 failed on 0.163.0
([issue #189](https://github.com/parisbs/codex-subagent-mcp/issues/189)): a delegation allowed only
`pdf@openai-primary-runtime`, its result said so, and its session file still offered the model the
skills of four remote plugins the server had turned off. The investigation ran five delegations on
`gpt-5.6-luna` at `low`, under the same Codex home and the same allow-list, and read the skills each
was offered from its session file:

- 0.160.0 with the server's argv: system skills and pdf only.
- 0.163.0 with the server's argv: pdf plus the skills of `plugin-management`, `sites`,
  `write-like-me` and `work-pets`. The regression is in the CLI, not in the account's remote state.
- 0.163.0 with the server's argv plus `-c plugins._default.enabled=true`: system skills and pdf only.
- 0.163.0 with `-c plugins._default.enabled=false` and the allowed plugin set to `true`, without the
  per-plugin overrides: the remote skills went away, but every local plugin stayed, because the
  user's `config.toml` sets `enabled = true` for each of them and an explicit entry beats the
  default.
- 0.163.0 with the server's argv plus `--disable remote_plugin`: the same leak as without it.

The Codex source explains the results. In `codex-rs/core-plugins/src/loader.rs`, a remote installed
plugin's configuration replaces the configured entry and keeps only its `mcp_servers`, so an
`enabled=false` override on a remote plugin is overwritten by the account's state; that code is the
same in 0.160.0, 0.160.1, 0.162.0, 0.162.1 and 0.163.0. Version 0.163.0 added `plugins._default`
and `PluginsConfigToml::allows_plugin` (`codex-rs/config/src/types.rs`), absent from those four
earlier tags; the `_default` key in their `types.rs` belongs to apps. Without `_default` every plugin
is allowed, as before; with it, the configured `plugins.<id>.enabled`, read before the remote
merge, decides, and the loader combines it with the merged state by a logical and. An explicit
setting cannot enable a plugin its source disabled. Why 0.160.0 kept the remote skills out is not
established: no 0.160.0 run in this Codex home ever offered a remote skill, with or without
overrides. Whether 0.160.1 to 0.162.1 leak was not checked.

A review on 2026-10-20 repeated three runs on 0.163.0 under the same home and allow-list: the
server's argv offered the four remote plugins' skills again, adding `_default=true` left pdf alone,
and `features.plugins=false` left the system skills alone.

On 0.160.0, `codex debug prompt-input` accepts `-c plugins._default.enabled=true` silently, and a
per-plugin override next to it still removes that plugin. `codex plugin list --json` lists every
remote plugin as enabled under any of these overrides, on 0.160.0 and on 0.163.0, so the listing
cannot confirm a remote plugin is off; only the session file can. The listing can also be incomplete
without failing: without network, `codex plugin list --json` exits 0, lists the local plugins only,
and prints `failed to list remote marketplace plugins` on stderr. A run that then reaches the
catalog loads remote plugins that no override names. With network, the listing's stderr was empty.
The daily compatibility check runs without credentials and has no remote plugins, so it cannot see
any of this.

The lesson for ADR 16's fail-closed rule is that a control on remote plugins can stop working in a
CLI release with nothing failing: the override is accepted, the run succeeds, and the result states
the policy, not what Codex applied.

Seven alternatives were considered and rejected.

**`--disable remote_plugin`.** It changed nothing on 0.163.0. Had it worked, it would also have
turned off remote plugins the user allowed.

**`_default=false` with the allowed plugins set to `true`, as a native allow-list.** It would keep
out plugins installed after the listing, but an explicit `enabled = true` in the user's
configuration wins over the default, so it kept every local plugin the user had enabled. Before
0.163.0 it has no effect at all.

**Trust `_default` on every CLI from 0.163.0 on.** That fails open on the next silent change to the
same code, which is exactly how #189 happened.

**Keep the versions before 0.163.0 that ran clean.** 0.160.0 and 0.159.2 kept remote skills out in
some runs, but without `_default` and for reasons not established; no 0.160.0 run in this home ever
offered a remote skill at all, so its clean runs prove nothing about the override.

**Turn every plugin off whenever an excluded plugin is remote, on every CLI.** Safe, but remote
curated plugins are installed per account, so for most ChatGPT users a plugin allow-list would never
keep anything.

**Refuse the delegation.** ADR 16 already turns every plugin off, instead of refusing, when one
plugin cannot be addressed by name; a refusal would stop work that needs no plugin at all, for a
cause the user can only fix by changing the CLI or the policy.

**Check the session file after the run and report a leak.** The model has already been offered the
skills by then, so it detects the failure without preventing it.

## Decision

The plugin allow-list keeps its per-plugin overrides and adds three rules.

1. Whenever a run turns at least one plugin off by name, its argv also carries
   `--config plugins._default.enabled=true`, on `exec` and on `exec resume`. It allows nothing
   Codex would not allow without it and makes the per-plugin overrides apply to remote plugins on the
   CLIs that know the key. Older CLIs read it as a plugin entry that matches no installed plugin. A
   plugin whose id is `_default` cannot be turned off by name, and is handled like any other id
   that cannot be addressed.
2. An excluded remote plugin is turned off by name only on a CLI version known to honour it: the
   version the preflight reports for this call is a plain release version (three dot-separated
   numbers) between 0.163.0, the first release with `_default`, and
   `NEWEST_VERIFIED_CODEX_VERSION`. On any other version, or when the version is not known, the run
   turns every plugin off with `features.plugins=false`, and its result names the allowed plugins
   that were turned off too and the reason. A plugin counts as remote when any listed row for its
   id has a `source.source` other than exactly `local`, missing included.
3. A plugin listing that prints anything on stderr is incomplete and counts as unreadable, so a
   plugin allow-list turns every plugin off, as ADR 16 does for a listing that fails.

`none` and `all` are unchanged. The rules cover plugins only: no MCP server or app of a remote
plugin was seen to leak, and apps stay off unless `CODEX_SUBAGENT_APPS` is `on`.

`NEWEST_VERIFIED_CODEX_VERSION` moves only after `/smoke-test` passes on that release, step 10
included, with a remote plugin excluded and checked in the run's session file. Without an installed
remote plugin to exclude, step 10 cannot verify this and says so, and the constant does not move.
A run that passes because it fell back to turning every plugin off verifies nothing about the
named control, so a candidate release is checked with the constant already moved to it, on the
branch that moves it.

## Consequences

A plugin allow-list again keeps every excluded plugin out on 0.163.0, remote ones included.

On a CLI newer than the newest verified one, a user who allows some plugins and has a remote plugin
installed outside the list gets no plugins until a release of this server verifies that CLI. The
result says why, and the preflight already warns about an unverified CLI. This is the cost of
failing closed on a control that has broken silently once.

`NEWEST_VERIFIED_CODEX_VERSION` stops being only a warning threshold: it now decides how a
delegation runs. A version moved too early widens what a run can reach.

On a CLI older than 0.163.0, the same user gets no plugins either, although some of those versions
may never have leaked. Until `NEWEST_VERIFIED_CODEX_VERSION` reaches 0.163.0 (#187), that holds on
every version.

The control works on a snapshot. A plugin installed or enabled between the listing and the run has
no override, and `_default=true` lets it load; ADR 16 already had this limit for local plugins. A
listing whose stderr carries an unrelated warning turns plugins off needlessly; the note quotes it.

The plugin inventory has to read each plugin's `source.source` and the listing's stderr, and the
inheritance decision needs the CLI version of the current call as an input, on follow-ups too. The
argv changes touch `src/codex/args.ts`, which is on the `Human merge:` line and calls for a Codex
review.

`/smoke-test` step 10 changes: remote plugins are judged by the run's session file, the listing is
not expected to show them disabled, and the step states the CLI it was verified on.

ADR 16 stays as written. Its statement that `-c plugins."<id>".enabled=false` turns off one plugin
for one run still holds for local plugins, but not for remote plugins on 0.163.0; for remote plugins
this record applies, and ADR 16's front matter status and index
row say so.
