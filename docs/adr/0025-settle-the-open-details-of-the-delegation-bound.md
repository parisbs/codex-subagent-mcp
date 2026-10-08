# 25. Settle the open details of the delegation bound

Status: Proposed

Supersedes point 5 of [ADR 23](0023-bound-delegations-in-memory.md) for one case only: a refusal
when every slot of the hourly bound is held by calls that have not spawned their delegation process
yet, where that point requires an earliest time and none can be derived. Every other refusal keeps
point 5 as written. The rest of this record decides what ADR 23 leaves open and replaces none of it.

## Context

Before the acceptance tests for [#62](https://github.com/parisbs/codex-subagent-mcp/issues/62) were
frozen, its criteria were reviewed by Codex (gpt-6.1-sol, medium) and the parts ADR 23 depends on
were tried against the installed Codex CLI (0.160.1), Node 24.14 and Claude Code 2.1.291 on macOS,
on 2026-10-07:

- **Two calls do overlap.** The MCP SDK's `Server` dispatched a second `tools/call` while the
  handler of the first was suspended at an await, so the reservation ADR 23 puts before the first
  await is what keeps a bound of one at one.
- **A reservation can hold every slot with nothing counted.** The probes before a spawn took 26 to
  104 ms each (`--version`, `login status`, `mcp list --json`, `debug models`), but they await, and a
  follow-up may also await a read of Codex's session file. With a bound of one and one call in its
  preflight, a second call is refused while no delegation process has been spawned. ADR 23 point 5
  derives the earliest time from the oldest counted process, so in that state it has none to give.
- **The time has no format.** Every other time this server prints, in `codex_job_status` and in the
  usage log, is `Date.prototype.toISOString()`: UTC, with milliseconds and a `Z`. An orchestrator
  knows the date but not always the time of day, so an absolute time alone does not tell it how
  long to wait.
- **A client can localise a time itself.** A Claude Code `PostToolUse` hook can replace an MCP
  tool's output before the model sees it (`updatedToolOutput`), so a user who wants local times can
  rewrite a fixed format on their side, for every server at once.
- **No clock was chosen.** The runner and the job registry use `Date.now()`, which follows changes
  to the system clock and keeps running while a laptop sleeps. `mock.timers` in `node:test` fakes
  `Date` on Node 24 and, per its documentation, on Node 22, the supported floor.
- **These are the first numeric variables.** Every existing variable is an enum or a list, trimmed,
  with an empty value meaning unset (ADR 24 point 2). `Number()` accepts `+5`, `5.0` and `1e3`;
  `parseInt` reads `1e3` as 1; and integers above `Number.MAX_SAFE_INTEGER` are rounded silently.
- **A cancelled background call still starts its job.** The background branch of `codex_delegate`
  gives the job a controller of its own and does not look at the request's signal, so a client that
  cancels the call during the preflight gets no job id, while the job is created and spawns Codex
  anyway. A blocking call already passes the request's signal to the runner, which checks it before
  spawning. Found by reading `src/server.ts`, not by running it.

## Decision

1. **A refusal with nothing counted gives no time.** When the hourly bound refuses a call and every
   slot is held by a call that has not spawned yet, the refusal names the variable and its value,
   says that every slot is held by calls already admitted that have not started Codex, that no time
   can be given until they start or fail, and to wait for the results of those calls before calling
   again. It also says that this is the user's limit and to ask the user to raise it if the work
   needs more, as point 5 of ADR 23 requires for every refusal. When at least one slot is counted,
   the refusal gives the time point 5 defines and adds that a call still starting may free a slot
   sooner.
2. **The time is UTC, followed by the minutes left.** The earliest time is the spawn time of the
   oldest counted process plus 3,600,000 ms, written with `toISOString()`, followed by the whole
   minutes until then, rounded up, which is never less than one. The server does not localise it
   and has no setting for its format or time zone.
3. **The clock is the wall clock.** Spawn times and the window are read from `Date.now()`. A
   process counts while the current time minus its spawn time is less than 3,600,000 ms, so an
   entry dated in the future after the clock moves back still counts, as in ADR 24 point 8, and a
   clock moved forward releases entries early. Time asleep counts as time passed.
4. **Integers are plain decimal digits.** Both variables are trimmed, and an empty value means
   unset. Any other value must consist only of the ASCII digits 0 to 9, leading zeros allowed, and
   must lie from 1 to `Number.MAX_SAFE_INTEGER` for `CODEX_SUBAGENT_MAX_DELEGATIONS_PER_HOUR` and
   from 1 to 8 for `CODEX_SUBAGENT_MAX_BACKGROUND_JOBS`. Anything else, a sign, a decimal point,
   an exponent, a separator or a value out of range included, is a configuration error. As for
   every variable, the configuration is read once, when the server starts.
5. **A reservation ends by spawning or by failing, never by age.** A reservation becomes a counted
   entry, dated at the spawn, or is released when its call fails before spawning. It does not
   expire however long its call waits. A cancellation that arrives before the spawn is a failure
   before the spawn: the call does not spawn, and its slot is released when its handler returns, not
   at the moment the cancellation arrives.
6. **A cancelled background call creates no job.** If the request of a background `codex_delegate`
   is cancelled before its job is created, no job is created, nothing spawns and its slot is
   released. Once the job id has been returned, the job is cancelled with `codex_job_cancel`, as
   before.
7. **`codex_doctor` counts what it can see, fresh.** It reports the hourly bound (its value, or
   that there is none), the background cap (its value, or 8 by default), how many delegation
   processes the window holds now, and, separately, how many calls hold a slot without having
   spawned. The window is kept whether or not the hourly bound is set. The figures are computed on
   every call, never taken from the cached CLI diagnosis, and `codex_doctor` never reserves or
   counts a slot. An invalid value is listed as a configuration error, never shown as its default.

**Alternatives considered.**

- *Date a pending reservation from when it was made, so that a refusal always has a time.* Rejected:
  if the reservation then fails, which takes milliseconds, the caller has been told to wait an hour
  for nothing.
- *Tell the caller to retry after a fixed delay.* Rejected: the delay would be invented, which is
  policy, and a caller that obeys it retries in a loop, the behaviour the bound exists to stop.
- *Give the time in the machine's local zone, or with its UTC offset.* Rejected: it would differ
  from every other time this server prints, and the user's zone is a presentation choice a client
  can make on its own.
- *Give only the minutes left.* Rejected: it goes stale while the message waits to be read, and it
  cannot be compared with the times in `codex_job_status`.
- *A variable for the time format or zone.* Rejected: it is not a restriction, the kind of setting
  ADR 12 and ADR 14 allow; to be consistent it would have to cover every time the server prints,
  which is out of scope here; and a client rewrite already does it for every server.
- *A monotonic clock.* Rejected: whether it counts sleep differs between clocks and platforms and
  would have to be verified on each, it needs a test seam of its own, and the refusal must still
  give a wall-clock time.
- *Parse with `Number()` or `parseInt`.* Rejected on the examples above: they accept values the user
  did not mean, or read them as other values.
- *Reject leading zeros.* Rejected: `05` cannot mean anything but five.
- *Accept any length of digits and compare them exactly.* Rejected: a bound above
  `Number.MAX_SAFE_INTEGER` bounds nothing, and a user who wants no bound leaves the variable unset.
- *Release a cancelled call's slot as soon as the cancellation arrives.* Rejected: its handler is
  still awaiting, and every later step would need a guard so that a probe finishing late does not
  spawn without a slot.
- *Let a pending reservation expire after a while.* Rejected: its call may still spawn afterwards,
  and the bound would be exceeded.
- *Count pending reservations as processes in `codex_doctor`.* Rejected: they have spent nothing,
  and the count would disagree with the refusal that says so.

## Consequences

Neither variable has shipped, so no released interface changes for them; the acceptance criteria of
#62 state these rules. Point 6 changes a released behaviour: a background call cancelled before its
job exists no longer starts a job. That is a fix, and the pull request describes it.

The caller of a refusal with nothing counted gets no time to schedule against. Its admitted calls
are its own and end soon, so waiting for their results is the instruction it can follow.

A clock moved back keeps entries counted for longer than an hour, and one moved forward lets work
resume early. Both are visible in `codex_doctor`.

A user who wants local times rewrites the output in their client, for example with a Claude Code
`PostToolUse` hook; this server does not ship one.

ADR 23 keeps its wording of point 5 as written; its status line names this record as the successor
for that case.
