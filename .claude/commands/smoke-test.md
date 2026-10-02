---
description: Run the end-to-end verification pass over the MCP server
allowed-tools: Bash, Read, Write, Edit
---

Verify the server works against the real Codex CLI. Delegations cost quota, so use
`gpt-5.6-luna` at `low` effort throughout and keep the prompts trivial.

1. `npm run build && npm test`.
2. Write a temporary MCP stdio client under the scratchpad directory that connects to
   `node build/index.js`, and use it for the rest of this checklist. Delete it when finished — it
   must not be committed.
3. `list_codex_models` — the slugs must match `codex debug models`, and none may be a stale
   fallback (a fallback prints a WARNING line).
4. `codex_recommend` on a mechanical task and on a hard debugging task — the tiers must differ.
5. `codex_delegate` with `sandbox: "read-only"` against this repository, asking Codex to read one
   file and report a fact. Confirm progress notifications arrive, and that the result reports a
   `thread_id`, the token usage and the commands run. The metadata line must end with
   `applied=confirmed`: that is the check that Codex's session file is still where and what
   `src/codex/rollout.ts` expects on this CLI version. With no inheritance variables set, the result
   must also say `Allowed from Codex: MCP servers none; plugins none; apps off.` (ADR 16).
6. `codex_follow_up` with that `thread_id` and no `model` — confirm Codex still has the earlier
   context, that the argv restated the original model and effort, that no "recorded with model"
   notice appears, and that this run also reports `applied=confirmed` (a resumed thread appends to
   the session file of the day it started, so this exercises the multi-day search).
7. Error paths: an unknown model slug, `ultra` on `gpt-5.6-luna` (must clamp to `max` with a note),
   a relative `working_dir`, an empty `working_dir` (must be refused, not treated as omitted), a
   `sandbox` of `danger-full-access` with no ceiling configured (must be refused, naming the built-in
   ceiling rather than a setting nobody made), and a `timeout_seconds` of 10 on a long task (must
   report the timeout and be flagged as an error).
8. Injection: with the scratchpad directory as `working_dir`, delegate a prompt containing
   `$(touch canary)`, `& echo canary > canary`, `%PATH%`, backticks and quotes, and confirm the text
   reaches Codex verbatim and no `canary` file appeared in that directory. The payload mixes POSIX
   shell and cmd.exe syntax because the server must be inert to both, and a relative path keeps the
   check the same on every platform.
9. Background: `mode: "background"`, then poll `codex_job_status` and read `codex_job_result`.
10. Inheritance against the real Codex home (#129): the daily compatibility check reads overrides
    back in a scratch home, but only this machine has real plugins, the MCP servers they provide
    and the names the user actually chose. Pick one name from
    `codex mcp list --json --config features.plugins=false` other than this server, and one
    `pluginId` that `codex plugin list --json` shows installed and enabled. Restart the client with
    `CODEX_SUBAGENT_MCP_SERVERS` and `CODEX_SUBAGENT_PLUGINS` set to them in the transport's `env`
    (the SDK's stdio transport passes the server only a few default variables, not the parent's
    environment, so variables set on the client process alone never reach it), together with the
    `CODEX_HOME` the listings above used, if one is set, and run one more
    read-only delegation with a trivial prompt. It must start (an override Codex cannot load fails
    the run before the model is called) and its result must name exactly that server and that
    plugin. That line states the policy, not what Codex applied, so read the result back in the
    same directory and home with the overrides the server builds (raw keys, as in
    `src/codex/args.ts`): `codex mcp list --json --config features.plugins=false` plus
    `--config mcp_servers.<name>.enabled=false` for every other listed server, and
    `codex plugin list --json` plus `--config plugins.<id>.enabled=false` for every other enabled
    plugin. Both must load and show the chosen server and plugin enabled and every other one
    disabled, except plugins whose `source.source` is `remote`: on 0.159.2 their listed state
    ignores config overrides although the run honours them. For those, check the run's session file
    instead: its skills instructions must name no skill from a plugin other than the chosen one.
    With no MCP server or no plugin to pick, say so and check the other half.

Report each step as pass or fail with the actual evidence. Do not claim a step passed if you did
not run it.

When every step passes on a CLI newer than `NEWEST_VERIFIED_CODEX_VERSION` in `src/codex/doctor.ts`,
move that constant to it in a pull request, together with a `turn_context` line and a `codex exec
--json` stream captured from that version (home paths and timezone replaced, as in the existing
fixtures) and the `exec`, `exec resume` and `exec review` help under `docs/reference/`.
