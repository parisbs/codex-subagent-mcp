# 22. Keep an opt-in local usage log

Status: Accepted

## Context

A blocking result reports the tokens the CLI counted for the run: input, cached, output and
reasoning, and on a follow-up the tokens of that turn, since `turn.completed` is cumulative on
resume. Some of it is held for a while: a finished background job keeps its result for an hour, and
the thread registry keeps each thread's cumulative total in memory. None of it survives the process,
and nothing adds runs up, so there is no view across delegations and no way to notice a pattern such
as `xhigh` effort spent on work that `low` would have handled
([#29](https://github.com/parisbs/codex-subagent-mcp/issues/29)). The roadmap puts this first in
0.6.0 because later decisions depend on its data: whether background jobs must survive a restart
(#33), whether task intents are worth building (#136), and whether wrapping `codex exec review` is
(#27).

Three constraints were already settled on #29:

- **Local only.** Nothing is sent anywhere.
- **Tokens only.** The server never reports or estimates subscription quota, credit conversions or
  remaining allowance. The CLI's session files carry usage-window percentages, but plan limits and
  credit rates are OpenAI's to change without notice, and a figure this server printed would go
  wrong silently.
- **Grouping without classifying.** Deciding what kind of task a prompt is would be the server
  making policy ([ADR 12](0012-mechanism-not-policy.md)).

Until now the server writes nothing that outlives a call: the only file it creates is the temporary
schema file of a structured run. A usage log is the first persistent state, on a machine that is
the user's. claude-workflow's measurement plan, written independently, reaches the same shape for
its own event log: optional, off by default, counts and enumerations only, never prompts, code or
paths.

A delegation starts more than one CLI process. Before the run, the preflight runs `--version` and
`login status`, model resolution may read the catalog, and the inheritance guard lists MCP servers
and plugins. Only the `codex exec` or `codex exec resume` process does the work the user pays for.

## Decision

1. **Off unless the user turns it on.** `CODEX_SUBAGENT_USAGE_LOG` takes `on` or `off`, default
   `off`; any other value is a configuration error, with the same effect as any other variable's:
   the delegation tools refuse until it is fixed, and `codex_doctor` still diagnoses and lists it.
   With it off, no usage-log file or directory is created. Other files the server already writes,
   such as the temporary schema file, are unaffected.
2. **One JSON line per delegation process.** A delegation process is the `codex exec` or
   `codex exec resume` process of a `codex_delegate` (blocking or background) or a
   `codex_follow_up` (blocking; follow-ups have no background mode). The preflight, catalog and
   listing probes are not delegation processes and are never logged. A call that fails before its
   delegation process is spawned, for any reason, writes nothing.

   The line is written when the outcome is final: for a blocking call, when the result is built;
   for a background job, after the job registry has settled it, so a cancellation that arrives after
   the process closed its pipes is recorded as cancelled. The end time and the duration are taken
   then. A timed-out run is recorded with what was collected when the timeout settled it, without
   waiting for the process tree to finish dying.

   Each line carries a schema version and:
   - the end time and the duration;
   - the kind (delegation or follow-up) and the mode (blocking or background);
   - the thread id Codex reported, or for a follow-up the thread id it was asked to resume; `null`
     when neither exists, as when a delegation fails before Codex starts a thread;
   - the caller's label, or `null` (point 4);
   - the model, effort and sandbox as passed to the CLI, after defaults and clamping, and separately
     those applied as ADR 13 reads them, with `unconfirmed` kept as such and never filled in from
     the requested values;
   - for `use_worktree`, `target_files`, `acceptance_criteria` and `output_schema`, whether the call
     set it: `true` for `use_worktree: true` or a non-empty value, `false` otherwise;
   - the number of commands Codex was observed to complete, which can undercount a run that was cut
     off;
   - this turn's tokens (input, cached, output, reasoning) and the uncached input derived from them,
     or `null` when they are unknown, never zero in their place;
   - the outcome as this server reports it, not the exit code: `cancelled`, `timeout`, `failure` or
     `success`, in that precedence when more than one applies;
   - the sandbox ceiling this instance runs with, and the server and CLI versions.

   Text fields the server takes from the CLI (model slugs, versions, applied values) are cut to 128
   characters, so a line stays far below 4 KiB.

   The server never records content from its own inputs or outputs: no prompt, context, system
   instructions, file names, paths, working directory, command text or command output.
3. **Where it lives.** The directory is `$XDG_STATE_HOME/codex-subagent-mcp` when `XDG_STATE_HOME`
   is an absolute path; otherwise `~/Library/Application Support/codex-subagent-mcp` on macOS,
   `~/.local/state/codex-subagent-mcp` on Linux, and `%LOCALAPPDATA%\codex-subagent-mcp` on Windows
   when `LOCALAPPDATA` is an absolute path. An empty or relative value is ignored rather than
   resolved against the working directory; on Windows without a usable `LOCALAPPDATA` the log cannot
   be written, and each result says so. The current file is `usage.jsonl`.

   When the server creates the directory it uses mode `0700`, and `0600` for files. An existing
   directory or file is used as it is, without changing its permissions. Windows has no modes: the
   files inherit the permissions of their directory, which the user's profile normally restricts.
4. **A label the caller chooses.** `codex_delegate` and `codex_follow_up` take an optional `label`:
   1 to 64 Unicode code points, with no control characters (Unicode category Cc), stored verbatim
   and never sent to Codex. The server does not interpret it. It is the caller's own text, so the
   promise in point 2 does not cover it: whatever a caller writes there is recorded and shown back by
   `codex_usage`. It is accepted whether the log is on or off, so turning the log on or off breaks no
   caller.

   A follow-up without a label uses the one its thread has in this server's thread registry; a
   follow-up with a label records it and becomes what later follow-ups inherit. The registry is in
   memory: after a restart, after the thread is evicted, or when the thread's settings were
   recovered from Codex's session file, there is nothing to inherit and the entry's label is `null`.
5. **Rotation without overwriting.** Before a write that would take `usage.jsonl` past 10 MiB, the
   process renames it to `usage-<UTC timestamp>-<pid>.jsonl`, a name no other process uses, and then
   deletes the oldest archives until the archives together hold at most 50 MiB. No rename replaces
   another file, so two processes that rotate at once do not destroy each other's data; the worst
   case is an archive smaller than 10 MiB. The caps are approximate: concurrent appends between a
   size check and a rename can exceed them by a few lines.
6. **Appends are best effort.** Each entry is one complete line, serialised first and written with a
   single append call on a file opened for appending. POSIX appends of a line this short from two
   processes are not interleaved in practice on local file systems; Windows documents no such
   guarantee for concurrent appends. A failed or partial write is not retried. The log is a
   statistical record, and the reader below is built to survive a damaged line.
7. **A failed write never fails a delegation.** The result's outcome and `isError` stay what they
   would have been, and the result says the entry was not written and why.
8. **A tool to read it.** `codex_usage` summarises the log over a window, `since_hours`, a finite
   number greater than 0 and at most 8,760, default 168, grouped by one field: applied model and
   effort (default, with `unconfirmed` as its own value), label, outcome or kind. It reads
   `usage.jsonl` and every archive. Per group it reports the count, the outcomes, the commands, the
   total and median duration, and token sums over the entries whose tokens are known, together with
   how many entries had known and unknown tokens; a group with none known shows no sums rather than
   zeros. It also reports the oldest entry it found, so a window longer than the retained history is
   visible as such, and that the summary combines every registration that writes to the file.

   An entry is used only when it has a known schema version and every field it needs has the right
   type; anything else, including a line that does not parse, is skipped and counted. A file that
   does not exist is not an error; a file that exists and cannot be read is reported by name. With
   the log off it says so, naming the variable, and still summarises files left from before. Like
   the job tools it reads this server's own state and runs no CLI preflight.

**Alternatives considered.**

- *On by default.* More data from every installation. Rejected: the server would start writing to
  the user's disk without anyone asking, and the data is wanted by the people who will turn it on.
- *Summarise inside `codex_doctor`.* No new tool. Rejected: it mixes accounting into diagnosis, and
  `codex_doctor` runs the CLI preflight, which reading a local file does not need.
- *The file alone, read with `jq`.* The smallest surface. Rejected: the orchestrator could not see
  its own spending, which is what #29 asks for.
- *Group only by the recorded fields.* No new parameter. Rejected: a review and an implementation can
  share model, effort and flags, and #136 needs to tell them apart.
- *Classify the prompt, or filter the label for content.* Rejected by ADR 12: the server would be
  judging the caller's text.
- *Log every CLI process, probes included.* Rejected: the probes cost no model tokens, and counting
  them would make a delegation look like several.
- *Rotate to a single fixed backup name.* Simpler. Rejected: two processes rotating at once could
  rename a fresh file over the backup the other had just written and lose a whole file.
- *A lock file around rotation.* Exact caps. Rejected: stale locks after a crash need recovery logic,
  and Windows and POSIX locking differ, for a guarantee a statistical log does not need.
- *Store under `$CODEX_HOME`.* Rejected: that directory is Codex's, and this server only reads it.
- *Quota or credits next to tokens.* Rejected on #29, for the reason above; it stays rejected.

## Consequences

The server writes persistent state for the first time, only when asked. The schema version lets a
later release change the line without misreading old files.

Two registrations of the server share one set of files, and the summary mixes them. The sandbox
ceiling on each entry tells registrations apart only when their ceilings differ. Per-instance
accounting would need an identifier the server does not have today, and no one has asked for it.

What is lost is bounded and stated: a damaged line on a concurrent append, a few lines past a cap,
the history beyond the archive cap, and every entry of a run whose write failed, which its result
reports. A summary is a count of the entries that survived, and says how far back they go.

`codex_usage` and `label` are public interface added in 0.6.0, so 0.7.0 has to decide which of their
output is contract, with the rest of the result (#138).

`CODEX_SUBAGENT_USAGE_LOG` joins the configuration table in the README and `server.json`, which
`test/registry.test.ts` checks. `docs/TOOLS.md` documents `codex_usage` and `label`, and
`docs/CONTROL.md` says what the log holds, what it never holds, and that the label is the caller's
text.
