# 26. Report a worktree run from the session file alone

Status: Accepted

Supersedes the parts of [ADR 21](0021-report-the-base-of-a-worktree-run.md) that read the caller's
working tree with git: step 1, the ignored entries named in the prompt in step 2, and the notes of
step 4 built from that read (the entries the worktree left out, the ignored entries, and the
comparison of the base commit with the `HEAD` read before the run). What stands from ADR 21: the
worktree path from `turn_context` and the base commit from `session_meta` in a line of their own,
never filled in from the request; an `execution_mode` section in the slot
[ADR 7](0007-inject-the-quality-contract.md) gives the read-only notice, not repeated on a
follow-up; and nothing refused.

## Context

Before the acceptance tests for [#150](https://github.com/parisbs/codex-subagent-mcp/issues/150)
were written, the issue and ADR 21 were reviewed against the installed Codex CLI (0.162.0) and git
2.56.0 on macOS, on 2026-10-08, with a second, independent review by Codex (`gpt-6.1-sol` at `high`,
read-only). The problem ADR 21 describes is still there, but the part of its design that runs git
costs more than it returns:

- **The worktree still lacks what ADR 21 says.** A delegation with `use_worktree` from a scratch
  repository with a modified tracked file, an untracked file and ignored `node_modules/` and `dist/`
  ran in `$CODEX_HOME/worktrees/425f/wtprobe`, where the tracked file held its committed content and
  the other three were absent. The session file's `session_meta` line carried
  `git.commit_hash` equal to the caller's `HEAD` (`0b3396c`), so the source ADR 21 chose for the
  base commit holds on 0.162.0.
- **The git read depends on the user's configuration, not on a git version.** The oldest option
  ADR 21 uses is `--no-optional-locks`, from git 2.15 (2017), so the version is not the constraint.
  The configuration is: in this repository the same `status --porcelain=v1 -z --ignored` returned 6
  entries with `status.showUntrackedFiles=normal`, 4,360 with `all` (every file under `node_modules/`
  listed one by one) and none with `no`. ADR 21 promises one entry per untracked directory and
  rejects listing every ignored file; the argv it fixes keeps neither promise. `-unormal` restores the
  collapsed form, but `core.fsmonitor` runs a hook command on `status`, and inherited `GIT_*`
  variables can point the read at another repository or index. Each is a new input the server would
  have to neutralise, on top of a timeout, an output limit and executable resolution on Windows,
  which ADR 21 dismisses without a test.
- **Names from the caller's tree are not inert in a prompt.** A delimited section wraps text; it does
  not escape it. A file name may contain a newline or the section's closing tag, so the names ADR 21
  puts in the prompt would need escaping and a size budget of their own.
- **What the read can say is narrower than ADR 21 claims.** A modified tracked file is in the
  worktree, with its committed content, and a deleted one comes back; neither is "not in the
  worktree". The "top-level" ignored entries are not top-level: git reports collapsed directories at
  any depth (`pkg/node_modules/`) and single ignored files deep in the tree (`docs/.DS_Store`).
- **The caller ADR 21 cites already has the inventory.** The maintainer's workflow, claude-workflow,
  denies a `use_worktree` run from a dirty tree in its `guard-codex` hook, computes the base itself
  with `git merge-base` in `codex-integrate.mjs`, and requires the delegation package to say what the
  worktree lacks. For a caller without such a hook, the damage on record (Codex rewriting production
  code around a missing ignored dependency) is prevented by telling Codex which kinds of files are
  absent and what to do about a missing one; the names add precision but no different instruction.

The same review found two facts of the current code that any version of this report must handle:
a background result is rendered with no notes (`src/server.ts`, `codex_job_result`), and the
session-file lookup in `src/codex/rollout.ts` fails as a whole when no `turn_context` line is found,
so a second field read from the same file would be lost with it.

## Decision

For a delegation with `use_worktree`:

1. **In the prompt**, an `execution_mode` section in the slot ADR 7 gives the read-only notice, with
   a fixed text and no data from the caller's tree. It states that the run is in a git worktree made
   from a commit; that uncommitted changes to tracked files, untracked files and ignored files in the
   caller's tree, such as installed dependencies or build output, are not carried over, and a tracked
   file holds its committed content; and that a missing dependency or file the task needs is
   reported, with the verification it prevents, rather than worked around by changing production
   code, unless the task asks for that change. A run that is also read-only carries both notices. A
   follow-up does not repeat it: it is already in the resumed session's history.
2. **After the run**, read `session_meta.git.commit_hash` in the same pass over the session file that
   reads `turn_context`, in `src/codex/rollout.ts`. Each field is confirmed on its own: a file with
   no readable `turn_context` still yields the base commit, and the other way round.
3. **Report**, in a line of its own, the worktree path from `turn_context` and the base commit from
   `session_meta`, each `unconfirmed` when it cannot be read. The line appears in blocking and
   background results alike.
4. **The server does not run git.** It reads no status of the caller's tree and no `HEAD`, so there
   is nothing to fill an unreadable base commit from, and nothing to compare it with.

**Alternatives considered.**

- *Keep ADR 21 and fix it*: `-unormal`, `-c core.fsmonitor=false`, a cleaned environment, escaped
  and bounded names, independent failure reports for `status` and `rev-parse`. Rejected: it makes the
  server depend on a second executable and on its configuration to produce a list that the main
  caller already enforces and that changes no instruction to Codex. If a caller needs the inventory
  from the server, that is a new record with its own evidence.
- *Compare the base commit with the caller's `HEAD`, without the status read*: one `git rev-parse`.
  Rejected: it still crosses the executable boundary, for a mismatch that does not occur today
  (Codex made the worktree from the caller's `HEAD` in the run ADR 21 cites and in the probe
  above). The line reports the applied base; a caller that cares about the difference has its own `HEAD`.
- *Read `HEAD` inside the worktree after the run.* Rejected for ADR 21's reason: under
  `danger-full-access` Codex can commit, and the value is already in the session file.
- *Read `.git` directly instead of running git.* Rejected: resolving a commit means handling
  gitfiles, `commondir`, packed refs and reftable, and a status needs the index and the ignore rules;
  it reimplements git to avoid running it.
- *Ask Codex to report the path and base in its answer.* Rejected as the source: it is an agent's
  statement, which ADR 13 does not accept for what was applied. It can still say so in its report.
- *Leave it all to client hooks.* Rejected: a caller without a hook gets nothing, and the notice has
  to reach Codex before the run, which only the prompt can do.

## Consequences

The server still never runs git. A delegation with `use_worktree` gains no failure mode before Codex
starts, and nothing in it depends on the user's git configuration or on how Windows resolves `git`.

A result no longer says which of the caller's files the worktree left out, nor whether the base
differs from the caller's `HEAD`. A caller that needs either reads its own tree, which is the tree
the server would have read.

The notice is a fixed text, so a unit test can prove it is present, not that Codex follows it.
Whether it prevents the workaround on record can only be seen in real runs.

`session_meta` becomes the second line of Codex's internal session format this server reads.
`test/rollout.test.ts` pins real `session_meta` lines, a worktree run on 0.162.0 among them, and they
are re-verified on every CLI bump like `turn_context`. `CLAUDE.md`'s invariant on the session file
gains `session_meta`, and `docs/TOOLS.md` describes the new line and the notice.

ADR 21 stays as written, including its first decision step, its claim that git on Windows needs no
resolution and its reference to "top-level" ignored entries; its status line and index row name this
record. The roadmap paragraph on worktree runs, which describes the git read, and the acceptance
criteria of #150 change with this record.
