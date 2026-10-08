# 21. Report the base of a worktree run

Status: Accepted; the read of the caller's working tree with git, and the prompt names and result notes built from it, superseded by [ADR 26](0026-report-a-worktree-run-from-the-session-file-alone.md)

Extends [ADR 13](0013-confirm-applied-settings.md) to a second line of Codex's session file and to the
state of the caller's working tree, and [ADR 7](0007-inject-the-quality-contract.md) with a prompt
section, for runs with `use_worktree`. It decides nothing that
[ADR 20](0020-let-the-session-file-decide-where-a-follow-up-resumes.md) does not already decide: what
is added here is a report and a notice to Codex.

## Context

A delegation with `use_worktree` runs in a git worktree that Codex makes under
`$CODEX_HOME/worktrees/<id>/<repository>`, detached at the commit it was made from, and leaves its
edits there uncommitted. ADR 20 lets the session file decide where a follow-up of such a run resumes.
To integrate the edits, a caller needs three more facts, none of which a result carries today
([#150](https://github.com/parisbs/codex-subagent-mcp/issues/150)):

- **The worktree's path, as such.** It appears only as the working directory that differs from the
  requested one, a line meant to report a mismatch. An integration step (claude-workflow's
  `codex-integrate.mjs` takes the path as its argument) and a guard that requires a writing
  follow-up's `working_dir` to be that path both have to parse it out of that line.
- **The commit the worktree was made from.** An integration merges against it, and a caller that
  works against frozen tests needs it to know whether the worktree contains them: claude-workflow's
  ADR 0016 binds a linked worktree to an oracle only when its `HEAD` descends from the oracle commit.
- **What the worktree left out.** Codex makes it from the last commit, so uncommitted tracked
  changes, untracked files and ignored files in the caller's tree are not there. claude-workflow's
  delegation probes of 2026-10-06 (Codex CLI 0.160.1,
  `docs/experiments/2026-10-06-delegation-probes.md` section 3) confirmed a modified tracked file and an untracked file were absent, and in the same
  record Codex, missing an ignored `node_modules` dependency, rewrote production code to get around
  it. It reported what it did, but only after doing it: a note in the result arrives too late for
  that case.

Two sources exist for the base commit, and both were checked against the session files on this
machine on 2026-10-07:

- The first line of every session file is a `session_meta` line whose payload carries `git` with
  `commit_hash` (and `branch` and `repository_url` when they exist). In a worktree run its `cwd` is
  the worktree and `commit_hash` is the commit it was made from, with no `branch`, since the worktree
  is detached. Present in every worktree run found: 2 on 0.154.0 and 13 on 0.160.1. Present in 59 of
  61 sessions on 0.154.0, 45 of 60 on 0.159.2, 7 of 16 on 0.160.0 and 24 of 24 on 0.160.1; the
  sessions without it are presumed to have run outside a git repository, which was not verified.
- The caller's tree, read with git before the run. That is what was asked for, not what Codex
  applied. The worktree `54f0` was made from `d2cb9a6`, the `HEAD` of a feature branch at the
  time, not of `main`, so today the two agree. Claude Code's own subagent worktrees do not behave
  this way by default: claude-workflow's probes of 2026-10-07
  (`docs/experiments/2026-10-07-claude-worktree-probes.md`) found they start from the freshly fetched
  tip of the default remote branch, unless `worktree.baseRef` is `"head"` or there is no remote. Two
  worktree mechanisms on one machine with different bases is the trap a base that is only assumed
  would hide.

## Decision

For a delegation with `use_worktree`:

1. **Before the run**, read the caller's working tree with git, by argv and with `shell: false` as
   ADR 4 requires: `git --no-optional-locks status --porcelain=v1 -z --ignored` for what the
   worktree will not contain, and `git rev-parse --verify HEAD` for the commit the caller is on.
   `-z` keeps paths with spaces or non-ASCII characters, and renames, unambiguous;
   `--no-optional-locks` keeps the read from taking the index lock of a tree others may be using.
   An untracked directory is one entry, as git shows it, not the files inside it. The ignored
   entries are read the same way, collapsed to the top-level directories git reports.
2. **In the prompt**, tell Codex what the worktree lacks before it starts: an `execution_mode`
   section, in the slot ADR 7 already gives the read-only notice, stating that it runs in a worktree
   made from the last commit, that uncommitted changes, untracked files and ignored files such as
   installed dependencies or build output are not in it (naming the ignored top-level entries read
   in step 1, up to ten), and that a missing dependency is reported rather than worked around. This
   states facts about the run and one reporting rule in the contract's spirit; it does not choose
   what Codex should do with the task.
3. **After the run**, read the base commit from the session file's `session_meta` line, next to the
   `turn_context` line ADR 13 already reads, in `src/codex/rollout.ts`.
4. **Report**, in a line of its own, the worktree path from `turn_context` and the base commit from
   `session_meta`; a note with the count and the first ten paths the worktree left out, uncommitted
   and untracked, when there are any; the ignored top-level entries it left out, when there are any;
   and a note when the base commit differs from the `HEAD` read before the run.

ADR 13's rule holds for every part: what could not be read is reported as `unconfirmed` or as a
check that could not be made, never filled in. The base commit is never taken from the caller's
`HEAD` when `session_meta` is unreadable; that would report the request as the outcome. Nothing is
refused: whether a dirty tree or a different base should stop a run is the caller's policy
(ADR 12), and a client-side hook can enforce it before the call.

**Alternatives considered.**

- *Take the base commit from the caller's `HEAD` alone.* Rejected: it is the request, and it is
  exactly what a change in how Codex chooses the base would make wrong without any sign.
- *Read `HEAD` inside the worktree after the run.* Under `workspace-write` it would usually be the
  base, because Codex cannot commit there: the same delegation probes saw `index.lock: Operation not
  permitted` under the repository's `.git/worktrees/`. Rejected all the same: under
  `danger-full-access` Codex can commit and `HEAD` becomes its own commit, and it means running git in
  a directory Codex chose, after the fact, for a value Codex already recorded.
- *Report the missing files in the result only.* Rejected: the damaging case on record was an
  ignored dependency that Codex worked around during the run; a note after the run describes the
  damage instead of preventing it. Leaving ignored files out of the report entirely was rejected for
  the same reason.
- *List every ignored file.* Rejected: `node_modules` alone runs to tens of thousands of entries;
  the top-level directories git collapses them to are what a reader can act on.
- *Refuse a `use_worktree` run from a dirty tree.* Rejected as policy (ADR 12). claude-workflow
  already denies it in a `PreToolUse` hook; a caller without one gets the note instead of nothing.
- *Leave the path in the "applied differs" line.* Rejected: a caller that integrates worktrees would
  keep parsing a mismatch report. Which lines of a result are contract is #138's decision for 0.7.0;
  a line of its own is what that decision can then name.

## Consequences

The server reads a second line of an internal, undocumented format. The cost is small, since the
line is the first one in the file and the read already starts there, but the shape has to be
re-verified on every CLI bump like `turn_context`. `test/rollout.test.ts` pins real `session_meta`
lines from each version it already pins, a worktree run among them.

The server runs git for the first time. A missing git, a directory that is not a repository or a
failing command makes the check unavailable and the run proceeds; it is reported, not fatal. On
Windows git is a real executable, so `src/codex/resolve.ts` is not involved, and `shell: true`
remains out of the question.

The status read happens before the CLI starts, so a file changed between the read and the moment
Codex makes the worktree can be missed. The note describes the tree as it was read, and says so.

Follow-ups are unchanged: they resume where ADR 20 says, and the base line is reported for the
delegation that made the worktree. The worktree notice is not repeated on a follow-up, for the
reason ADR 7 gives for the contract: it is already in the resumed session's history.

The prompt gains a section for worktree runs, which ADR 7's layering did not name; it takes the
slot ADR 7 gives the read-only notice, and a run that is both read-only and in a worktree carries
both. ADR 7 stays as written. Paths from the caller's tree reach the prompt as file names inside a
delimited section, as `target_files` already do; they are data, not instructions.

`CLAUDE.md`'s invariant on the session file names `turn_context` alone; it gains `session_meta`.
`docs/TOOLS.md` describes the new lines.
