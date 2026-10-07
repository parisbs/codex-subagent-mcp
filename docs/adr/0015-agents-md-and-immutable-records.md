# 15. Keep agent instructions in AGENTS.md and records immutable

Status: Accepted; the instructions in `AGENTS.md` superseded by [ADR 18](0018-keep-agent-instructions-in-claude-md-alone.md), and the status kept in the index alone by [ADR 19](0019-name-the-successor-in-the-status-line.md)

Supersedes the exception in the contributing guide that allowed an accepted record to be edited to
correct a statement of fact that had become untrue.

## Context

The project instructions lived in `CLAUDE.md`, which only Claude Code reads. This server exists so
that Claude Code can delegate to Codex, and Codex reads `AGENTS.md`, so a delegated run in this
repository worked without the hard rules unless its prompt repeated them. Pull request #93 moved the
instructions to `AGENTS.md` and made `CLAUDE.md` import it with `@AGENTS.md`.

That pull request also edited the body of [ADR 13](0013-confirm-applied-settings.md), repointing a
reference from `CLAUDE.md` to `AGENTS.md`, under the contributing guide's exception for facts that
had become untrue. The exception is a judgement call: the line between correcting a fact and
rewriting the reasoning of a past decision is not sharp, and each edit makes a record less
trustworthy as history. Other repositories maintained with the same workflow treat merged records as
immutable without exception.

## Decision

The instructions any coding agent needs live in `AGENTS.md`; `CLAUDE.md` imports it and adds only
what is specific to Claude Code.

A record is immutable once merged to `main`, with no exception. A changed decision, or a fact that
has become untrue, is recorded in a later record that supersedes it and links back, and the status
column of the index records the change. A record in an open pull request is still a draft and can be
edited.

The edit #93 made to ADR 13 stays as it is: reverting it would be a second edit of the same record.
Where ADR 13 says `AGENTS.md`, it said `CLAUDE.md` when it was accepted.

## Consequences

The contributing guide, `AGENTS.md` and the index state the rule without the exception. Stale
references inside merged records stay as written; the record that makes them stale says so, as this
one does for ADR 13.
