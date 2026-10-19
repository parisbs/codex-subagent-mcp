---
status: proposed
date: 2026-10-19
---
# 29. Keep the status in front matter and freeze records on acceptance

Supersedes in part [ADR 15](0015-agents-md-and-immutable-records.md), where it makes a record
immutable once merged, and [ADR 19](0019-name-the-successor-in-the-status-line.md), where it puts the
successor in a `Status:` line. What both decided otherwise stands.

## Context

ADR 15 made a record immutable once merged to `main`, with no exception. ADR 19 keeps a record's
status in a `Status:` line under its title and, when a later record replaces part or all of it, lets
that line alone change to name the successor. Nothing enforces either rule: a reviewer has to notice
an edit to a merged record, and the index has already drifted once without anyone noticing (ADR 19).

The maintainer's workflow, which this repository follows, has since changed on both points.
[claude-workflow ADR 0018](https://github.com/parisbs/claude-workflow/blob/main/docs/adr/0018-adrs-are-immutable-once-accepted-or-rejected.md)
freezes a record from the commit on `main` where its status becomes accepted or rejected, so a record
merged as proposed is still a draft.
[claude-workflow ADR 0020](https://github.com/parisbs/claude-workflow/blob/main/docs/adr/0020-standardise-adr-metadata-on-madr-4-front-matter.md)
reads the status only from the `status` field of MADR 4 YAML front matter, and its
`scripts/check-adrs.mjs` compares every record of a pull request with the base: it fails on a body
edit of a frozen record, a status that moves the wrong way, a deleted or renamed record, broken
numbering or a record missing from the index.

That check counts a `Status:` line as no status at all. Every record here, 0001 to 0028, has one, so
every record would count as missing a status and stay frozen, including its status. ADR 20 of the
workflow allows one way out: a mechanical migration that adds front matter holding the legacy status
value unchanged, removes the legacy line, and leaves every other line identical, which the check
verifies. That migration edits 28 merged records, which ADR 15 forbids with no exception.

Every record here is accepted, and none was ever merged while proposed, so moving the point of
immutability from the merge to the acceptance changes nothing for the existing records.

**Alternatives considered.**

- *Keep the `Status:` line and enforce nothing.* Rejected: ADR 15 and ADR 19 then stay rules that
  only a careful reviewer applies, and the index drift ADR 19 found shows that is not enough.
- *Teach a local copy of the check to read `Status:` lines.* Rejected: the check is copied byte for
  byte from the workflow's template so that its fixes reach this repository; a fork would drift from
  it and from the format the other repositories of the workflow use.
- *Normalise the records while migrating them*, lowercasing the status word, moving the annotations
  that name a successor out of the status, or rewriting the bodies into MADR sections. Rejected: any
  change beyond the mechanical one is a body edit of a frozen record, which ADR 15 forbids and the
  check rejects, and an annotation is the record of what a later decision replaced.
- *Keep records immutable from the merge.* Rejected: the check treats a proposed record as a draft, so
  keeping the stricter rule would need a local check, with the cost of the second alternative. A
  record that should not change after the merge is accepted before it merges.

## Decision

A record's status is the `status` field of YAML front matter at the top of the file: line 1 is
`---`, then `status:` and, in a new record, `date:` with the day it was written as `YYYY-MM-DD`, then
`---`, then the title line. No record has a `Status:` line. The status starts with one of proposed,
accepted, rejected, deprecated or superseded, in any case; an annotation may follow it.

A record is immutable from the commit on `main` where its status becomes accepted or rejected. A
proposed record on `main`, and any record in an open pull request, is a draft and may be edited. Only
an accepted record becomes deprecated, and a deprecated record only becomes superseded. The date of a
decided record changes only together with its status.

When a record supersedes another in whole or in part, the superseded record changes in its front
matter status and nowhere else, as ADR 19 decided for the status line: `status: Accepted; <part>
superseded by [ADR n](...)`, or `status: Superseded by [ADR n](...)` when nothing of the record
stands. The index keeps its status column, and it says the same as the records.

Every record from 0001 to 0028 is migrated once, mechanically, by `scripts/migrate-adrs.mjs`, in the
pull request of this record and in a commit of its own: front matter holding the legacy status value
unchanged, the `Status:` line removed, every other line identical. That is the only edit to the body
of a frozen record this repository allows, and it is not repeated.

`scripts/check-adrs.mjs` enforces these rules on every pull request, copied byte for byte from the
workflow's template together with its workflow, once the migration has merged.

The records keep the Nygard sections, Context, Decision and Consequences.

## Consequences

The migration leaves two blank lines between each migrated record's title and its first section,
where the `Status:` line was. They stay: removing one is a body edit.

The status of ADRs 15 and 19 cannot change in the pull request that migrates them, since the check
admits a migrated record only when its front matter holds the legacy value unchanged. Their status,
and their index rows, name this record in the pull request that installs the check.

A branch cut before the migration that adds a record with a `Status:` line fails the check; the
record gains front matter before it merges. A branch that edits a record's status line conflicts
with the migration and is rebased onto it.

ADR 15 still says that the status column of the index records a change, ADR 18 says the same of
ADR 15, and ADR 19 speaks of the status line throughout. They stay as written and are superseded on
those points by this record. `CLAUDE.md`, `CONTRIBUTING.md` and the introduction of the index
describe the front matter status with this record.
