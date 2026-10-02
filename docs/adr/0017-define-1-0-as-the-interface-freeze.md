# 17. Define 1.0 as the freeze of the public interface

Status: Accepted

## Context

[VERSIONING.md](../VERSIONING.md) listed four requirements for 1.0: a real delegation verified on
Windows and Linux, the recommendation matrix informed by actual usage, the tool interface unchanged
across several releases, and a settled answer on whether background jobs must survive a restart.
The 1.0.0 milestone carried two issues. Planning the releases after 0.5.0 showed that this list
could not say how far away 1.0 was, for three reasons.

**It mixed a stability promise with a quality goal.** VERSIONING.md itself says a change to the
recommendation matrix is not breaking. A requirement on the matrix therefore had nothing to do with
what 1.0 promises, and could hold the release back indefinitely.

**"Several releases" was undefined, and counting releases says little at this pace.** Five releases
shipped between 2026-09-11 and 2026-10-01. Of the last three, 0.3.0 and 0.5.0 each carried three
breaking changes and 0.4.0 none.

**It did not say which open work could still break the interface.** Without that, every open issue
was a possible blocker, and 1.0 read as wherever the project happened to arrive.

Classifying the open issues by whether they could break the interface gives a finite list. Rejecting
extra directories that are accepted today (#31), refusing a directory nobody chose (#63), giving
background jobs a different lifetime (#33) and the way a result signals it is waiting for an answer
(#125) can each break a caller. Cost accounting (#29), Codex profiles (#30), a delegation bound
(#62), a `codex doctor` summary (#69), task intents (#136) and a review tool (#27) only add surface.
What a result promises to a parser was never defined at all (#138).

Two parameters cannot be set from what the project knows today. The Codex CLI ships a stable release
about every 2.5 days and a new minor about every 4.7 days (0.134.0 to 0.160.0, May to October 2026),
stays on 0.x and does not mark breaking changes. Nothing this server uses broke between 0.154.0
and 0.160.0, which is three weeks of evidence, not a rate. How long a freeze must last, and what it
means after 1.0 when a CLI change forces the minimum supported version up, both depend on that rate.

Alternatives considered:

- **Keep the list and add issues for the missing requirements.** It keeps the matrix requirement,
  which contradicts the definition of breaking, and leaves "several releases" to be guessed.
- **Stay on 0.x until the Codex CLI reaches 1.0.** The reason for 0.x in VERSIONING.md is that the
  CLI moves underneath this server. Waiting for the CLI ties this project's promise to another
  project's schedule, and the CLI's own 1.0 would not make its releases stop removing things.
- **Date the release.** A date says nothing about whether the interface is ready to freeze.

## Decision

1.0 means one thing: the public interface is frozen. The interface is the tools, their parameters,
their defaults, the environment variables, and the parts of a result defined as contract. After 1.0,
breaking any of it is a major release.

Only what could still break the interface blocks 1.0. Changes that only add surface ship when data
justifies them, before or after 1.0, and do not wait for it.

The releases are planned in that order:

- **0.6.0** — measurement and additive changes, with cost accounting first, because later decisions
  depend on its data. No breaking change is planned.
- **0.7.0** — closing the interface. Every open item that could break it is built or closed,
  including which parts of a result are contract. It is the last release allowed to break before
  1.0.
- **The freeze** — the releases after 0.7.0, with no breaking change. It needs no milestone of its
  own.
- **1.0.0** — the declaration, with no work of its own beyond proving the freeze.

The recommendation-matrix requirement is dropped. "Unchanged across several releases" becomes the
freeze period, and the requirement for a real delegation off macOS stands (#32).

Three things stay open on purpose, each with what decides it:

- How long the freeze lasts and how it is shown to have held: a measured rate of Codex CLI changes
  that affect this server (#139).
- What a forced Codex CLI floor raise means after 1.0: the same rate (#139).
- How a delegation is verified off macOS (#32).

None of them blocks 0.6.0 or 0.7.0. All of them block declaring 1.0.

## Consequences

The distance to 1.0 becomes a list that can be read: the open items in 0.7.0, the freeze, and the
three parameters above. A milestone named after a version stays a forecast, as VERSIONING.md says;
what changed is that the content of 1.0 no longer is.

Breaking changes concentrate in 0.7.0. Work in 0.6.0 that turns out to need one either waits for
0.7.0 or makes the case for moving there.

Additive features such as task intents can ship after 1.0 as minor releases. Deferring them is not a
loss of reach, and building them is not a precondition.

The open parameters are a known gap, not a hidden one. Setting them by guess would make the freeze
arbitrary in the one place where it has to hold, and could make 1.0 promise something the Codex CLI
then breaks.
