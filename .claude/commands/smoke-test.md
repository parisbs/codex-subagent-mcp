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
   `thread_id`, the token usage and the commands run.
6. `codex_follow_up` with that `thread_id` and the same `model` — confirm Codex still has the
   earlier context.
7. Error paths: an unknown model slug, `ultra` on `gpt-5.6-luna` (must clamp to `max` with a note),
   a relative `working_dir`, and a `timeout_seconds` of 10 on a long task (must report the timeout
   and be flagged as an error).
8. Injection: with the scratchpad directory as `working_dir`, delegate a prompt containing
   `$(touch canary)`, `& echo canary > canary`, `%PATH%`, backticks and quotes, and confirm the text
   reaches Codex verbatim and no `canary` file appeared in that directory. The payload mixes POSIX
   shell and cmd.exe syntax because the server must be inert to both, and a relative path keeps the
   check the same on every platform.
9. Background: `mode: "background"`, then poll `codex_job_status` and read `codex_job_result`.

Report each step as pass or fail with the actual evidence. Do not claim a step passed if you did
not run it.
