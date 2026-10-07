# 19. Name the successor in a superseded record's status line

Status: Accepted

Supersedes the part of [ADR 15](0015-agents-md-and-immutable-records.md) that records a change of
status in the index alone. What ADR 15 decided about immutable records otherwise stands.

## Context

ADR 15 made merged records immutable with no exception and put a change of status in the status
column of the index. The record itself keeps saying `Status: Accepted` after a later record replaces
part or all of it.

Read on its own, such a record misleads. ADR 15 is titled "Keep agent instructions in AGENTS.md" and
says `Status: Accepted`, although ADR 18 removed `AGENTS.md`. ADRs 3, 5 and 12 are in the same
position. An agent that opens a record found by a search, or linked from code, does not see the
index, and nothing in the record tells it to look there.

The index has drifted too: ADR 12 supersedes part of ADR 3, which says so in its own preamble, but
the index row for ADR 3 named only ADR 9.

The maintainer's workflow, which this repository follows, lets a superseded record change in its
status line only, naming the record or the part that supersedes it
([claude-workflow ADR 0009](https://github.com/parisbs/claude-workflow/blob/main/docs/adr/0009-adrs-are-immutable-once-merged.md)).
A drift audit on 2026-10-06 reported the difference.

## Decision

When a record supersedes another in whole or in part, the superseded record changes in its status
line and nowhere else. The line names the successor and, for a partial supersession, the part it
replaces: `Status: Accepted; <part> superseded by [ADR n](...)`, or `Status: Superseded by [ADR n](...)`
when nothing of the record stands.

The body of a merged record stays immutable, as ADR 15 decided: a stale reference inside it stays as
written, and the record that makes it stale says so in its consequences. The index keeps its status
column, and it says the same as the status lines.

This record updates the status lines of ADRs 3, 5, 12 and 15 and corrects the index row for ADR 3.

**Alternatives considered.**

- *Keep the status in the index alone.* Rejected: a record read without the index states a decision
  that no longer holds, and the index has already drifted once without anyone noticing.
- *Edit the superseded record's body to point at its successor.* Rejected: that is the edit ADR 15
  forbade for good reason; a body that changes is no longer a record of what was decided.
- *Move superseded records to an archive directory.* Rejected: it breaks every link to them, from
  code, documents and issues.

## Consequences

Superseding a record now touches two files besides the new record: the old record's status line and
its index row. A pull request that supersedes a record and leaves either unchanged is incomplete.

Where the contributing guide and the index introduction say that only the index records the change,
they are updated with this record.

The status lines of ADRs 3, 5, 12 and 15 change in this record's pull request; their bodies do not.
ADR 15 says "the status column of the index records the change", and ADR 18 says "the status column
of the index records the change to ADR 15 and nothing else in it"; both stay as written and are
superseded on that point by this record.
