# 20. Let the session file decide where a follow-up resumes

Status: Proposed

Supersedes the part of [ADR 13](0013-confirm-applied-settings.md) that makes the read of Codex's
session file a report and never a decision, for the directory a follow-up resumes in. What ADR 13
decided about observing applied settings, the sandbox rule and reporting `unconfirmed` stands.

## Context

ADR 13 reads the `turn_context` line of a thread's session file after each run and reports what
Codex applied. Its consequences call the dependency deliberately shallow: nothing about a delegation
changes when the read fails, and the result is a report rather than a decision, with the sandbox
rule as the single exception. `CLAUDE.md` states the same as an invariant: never let a read of it
change anything but the report.

Two later behaviours need more than a report, and only one of them was recorded:

- **Thread recovery (#87).** When this server has no record of a thread (it restarted, or another
  process started the thread), a follow-up recovers the model, effort and directory from the session
  file and resumes with them. That is a decision taken on the read, and it shipped without a record.
- **Worktree runs (#149).** A delegation with `use_worktree` runs in a managed git worktree under
  `~/.codex/worktrees/`, whose path Codex chooses and this server learns only from the session file. The
  thread was recorded with the directory the caller asked for, and `codex exec resume` has no
  `--worktree`, so a follow-up without `working_dir` resumed in the original working tree. With
  `sandbox: workspace-write` its edits landed there, which is what `use_worktree` exists to prevent.
  Reproduced on Codex CLI 0.160.1.

The worktree path is not knowable from the request: the CLI picks it. A follow-up that resumes in the
right place has to learn it from the source this server already reads.

## Decision

The read of the session file may decide the directory a follow-up resumes in, in these two cases and
no others:

1. **Recovery.** On a registry miss, a complete record (model, effort and a directory that passes the
   same validation as a caller's `working_dir`) is used; a partial or invalid one is ignored and the
   follow-up behaves as if nothing were recorded.
2. **Worktree runs.** When a delegation ran with `use_worktree`, the thread is recorded with the
   directory Codex applied if the read confirms one that differs from the requested directory. If the
   applied directory could not be confirmed, the thread is marked so, and a follow-up without
   `working_dir` is refused before any CLI process starts, naming the requested directory and asking
   for `working_dir`.

A `working_dir` passed by the caller always wins over anything recorded or read.

The rule that makes this safe is the one ADR 13 already applies to reporting: an unreadable or
unrecognised record never turns into a guess. A failed read degrades to the behaviour that existed
without it (recovery) or to a refusal (worktree runs), never to a directory the read did not confirm.

**Alternatives considered.**

- *Keep the read a report and always refuse a follow-up of a worktree run without `working_dir`.* The
  caller would copy the path from the delegation's report into every follow-up. Rejected: the server
  already holds that path, a manual step on every follow-up is a step an orchestrator will get wrong,
  and the refusal is still available for the case where the path could not be confirmed.
- *Predict the worktree path.* Rejected for the reason ADR 13 rejected re-implementing Codex's
  configuration: the location is Codex's choice, undocumented and free to change, and a prediction
  that is wrong reads exactly like a measurement.
- *Resume in the requested directory, as before, and document it.* Rejected: it silently sends a
  correction past the isolation the caller asked for, and in an orchestrated workflow it skips the
  check that integrates a worktree.

## Consequences

The session file now decides something besides the sandbox verdict, so a change in its format has a
behavioural effect rather than only a reporting one. The effect is bounded: a format change makes the
directory unconfirmed, so worktree follow-ups without `working_dir` are refused and recovery stops
recovering. Both fail visibly. Re-verifying the format on every CLI bump, as ADR 13 requires, matters
more than before.

The invariant in `CLAUDE.md` that a read of the session file changes nothing but the report is
reworded to name these two exceptions. ADR 13's consequences ("nothing about a delegation changes
when the read fails", "a report rather than a decision") stay as written and are superseded on the
directory a follow-up resumes in by this record.

`docs/TOOLS.md` states where a follow-up of a worktree run resumes, and when it is refused.
