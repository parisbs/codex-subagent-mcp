---
paths:
  - "src/codex/**"
  - "src/threads.ts"
  - "scripts/check-codex-compat.ts"
  - ".github/workflows/codex-compat.yml"
  - "docs/reference/**"
  - "test/{args,catalog,codex-compat,codex-readback,doctor,doctor-extended,doctor-report,events,inherited,mcp,probe-context,resolve,rollout,threads}.test.ts"
---

# Codex CLI behaviour

Traps already found against the real binary, each covered by tests. Check a new one with
`codex exec --help`, `codex exec resume --help`, `codex features list` and `codex debug models`.

- `codex exec resume` rejects `--color`, `--sandbox`, `--approve-for-me`, `--cd`, `--add-dir` and
  `--search`; anything it still needs goes through `-c` overrides.
- `--approve-for-me` implies the workspace-write sandbox and cannot be combined with `--sandbox`; it
  replaces the flag.
- `--worktree` needs `--enable worktrees` on the same invocation: experimental and off by default in
  0.154.0, the floor; on by default from 0.159.2.
- `--search` belongs to `codex`, not `codex exec`, which exits 2 on it. Web search is
  `-c web_search="live"`, which also keeps the argv starting with `exec`, as the test stand-in needs.
  Check a flag's position against `--help`, not only its presence in the argv.
- Warnings arrive as failures and failures arrive outside items. Configuration warnings are
  `item.completed` items of type `error`, printed twice before `turn.started`; a usage limit or a lost
  connection is a top-level `error` event followed by `turn.failed`. `src/codex/events.ts` downgrades
  only known warning shapes and treats `turn.failed` as fatal: add a new warning's shape there rather
  than loosen the rule.
- `codex doctor --json` exits 1 whenever any check fails, a network probe included, after printing a
  complete report, so `src/codex/doctor-report.ts` classifies by content first. It takes seconds to
  over a minute, probing every enabled HTTP MCP server. Never drop `--json`: a CLI without the
  subcommand would read `doctor` as a prompt and start the TUI (ADR 27).
- A resumed session does not keep its model or effort: without them on the argv, `codex exec resume`
  takes both from the config of the directory it runs in. Follow-ups always restate model, effort and
  directory (`src/threads.ts`).
- Configuration resolves against the working directory, so a probe's answer belongs to a directory,
  not the machine. `runDoctor` and `getCatalog` take a `cwd` and cache per directory, and the
  delegation tools pass their `working_dir` to both.
- What a run applied is not what it asked for. The session file
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` has a `turn_context` line per turn
  (model, effort, sandbox, cwd), a `session_meta` line with `git.commit_hash`, and a `task_complete`
  line with the turn id and error info (ADR 30). The format is internal and undocumented: on every
  CLI bump add that release's real lines to `test/rollout.test.ts`, and keep every failure path
  reporting "unconfirmed". A read changes only the report, except the directory a follow-up resumes
  in after a registry miss or a `use_worktree` run; an unconfirmed read there degrades to the old
  behaviour or to a refusal, never to a guessed directory (ADR 20).
- Codex starts its MCP servers with almost no environment unless an entry lists `env_vars`, so an
  environment marker cannot tell this server it runs inside a delegation. The recursion guard finds
  this server in `codex mcp list --json`, run in the delegation's working directory, and passes
  `-c mcp_servers.<name>.enabled=false` (`src/codex/mcp.ts`). Recognition is by shape: the
  `codex-subagent-mcp` string, a `codex-subagent` executable basename, or this process's exact entry
  script path. If the listing fails, the delegation is refused unless `CODEX_SUBAGENT_MCP_SERVERS` is
  `all`; under `all` it runs and reports that the guard could not be applied (ADR 16). The prompt's
  instruction not to delegate further is an instruction, not a control.

`.github/workflows/codex-compat.yml` runs every argv shape `buildCodexArgs` can produce with `--help`
appended against the newest release each day, without credentials; a removed flag is the negative
control. `test/codex-compat.test.ts` fails when an option in `src/codex/args.ts` is missing from
`argvShapes` in `scripts/check-codex-compat.ts`. `NEWEST_VERIFIED_CODEX_VERSION` moves only after
`/smoke-test` passes on that release, and it also decides how remote plugins are excluded (ADR 31).
