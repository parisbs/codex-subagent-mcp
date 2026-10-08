# 23. Bound delegations per hour, in memory

Status: Accepted; the refusal when every slot is held by calls that have not spawned superseded by [ADR 25](0025-settle-the-open-details-of-the-delegation-bound.md)

## Context

Nothing bounds how much Codex a session can spend. The only limit is eight concurrent background
jobs, a constant in `src/jobs.ts`, each allowed up to two hours, and progress notifications keep long
calls alive. An orchestrator that retries, chains follow-ups or is steered by injected content can
keep delegating, and the user may only notice when the plan's usage window is exhausted, which
happened for real during the 0.2.0 work
([#62](https://github.com/parisbs/codex-subagent-mcp/issues/62)).

The direction on #62 was restriction-only variables in line with
[ADR 12](0012-mechanism-not-policy.md) and [ADR 14](0014-user-controlled-sandbox-defaults.md): the
user sets a bound, the server enforces it, and nobody but the user can raise it. Three questions were
open: what counts, whether the count survives a restart, and what the refusal says so that the
orchestrator stops instead of retrying. The server must still never estimate or report quota
([ADR 22](0022-keep-an-opt-in-local-usage-log.md)): this counts invocations, not tokens or credits.

A delegation handler does a lot before it spawns Codex: it validates arguments, runs the preflight
(which starts the CLI for `--version` and `login status`), resolves the model (which may read the
catalog), lists inherited MCP servers and plugins, and for a background call asks the job registry
for a slot. Each of those awaits, so two calls can be in the handler at once.

## Decision

1. **`CODEX_SUBAGENT_MAX_DELEGATIONS_PER_HOUR`**, a positive integer, unset by default (no bound).
   What counts is a delegation process as ADR 22 defines it: the `codex exec` or `codex exec resume`
   process of a `codex_delegate`, blocking or background, or of a `codex_follow_up`, which is always
   blocking. The probes before it never count. The window is rolling: a delegation process counts
   from the moment it was spawned until sixty minutes later, and from exactly sixty minutes on it no
   longer counts.
2. **A slot is reserved on entry and released if nothing spawns.** After argument validation and
   before any probe or other await, the handler checks the window and reserves a slot in the same
   synchronous step, so two calls arriving together cannot both take the last slot. If the bound is
   reached the call is refused there, before any CLI process, probes included. If the call then
   fails before its delegation process is spawned, for any reason (configuration, preflight, model
   resolution, a ceiling, the background cap, schema-file creation, a spawn error or a cancellation
   that arrived first), the slot is released and nothing was counted. Once the process is spawned
   the slot is counted from that moment, whatever the run's outcome.
3. **`CODEX_SUBAGENT_MAX_BACKGROUND_JOBS`**, an integer from 1 to 8, unset by default (8). It can
   only lower the built-in cap; a value outside the range is a configuration error. It keeps the
   registry's meaning of a running job: a job stops counting when it is cancelled or settled, even
   if its process tree is still being stopped. It bounds how many background delegations a caller
   can have open, not how many processes exist at an instant.
4. **Counted in memory.** The count belongs to the server process, which Claude Code starts per
   session, and starts at zero after a restart. Two registrations are two processes, each with its
   own bound, which the user sets per registration. The bound does not depend on the usage log of
   ADR 22 and works the same with it on or off.
5. **A refusal that tells the caller to stop.** The hourly refusal fails with `isError`, naming the
   variable and its value, the earliest time the hourly bound would allow another call (when the
   oldest counted process leaves the window), and that this is the user's limit: do not retry before
   then, and ask the user to raise it if the work needs more. That time is when the bound allows a
   call, not a promise that one will be accepted: another call may take the slot first, and the
   other checks still apply. The background cap keeps its message and names the variable when it is
   set.
6. **Configuration errors follow the existing rule.** An invalid value in either variable makes the
   delegation tools refuse until it is fixed; `codex_doctor` still runs and lists it.
7. **Visible before it bites.** `codex_doctor` reports both bounds, as configured or as their
   defaults, and how many delegation processes the hourly window holds now.

**Alternatives considered.**

- *Count from the usage log when it is on.* A bound that survives restarts. Rejected: it would couple
  a restriction to an opt-in log, so the same variable would behave differently depending on another
  one, and a missing or rotated file would change the count.
- *Persist the count in a file of its own.* Rejected: a restart is when a user who hit the bound
  would want it to reset, and cross-process state needs locking that a per-session bound does not.
- *Count every CLI process, probes included.* Rejected: the probes spend no model tokens, and a
  bound of ten would allow two or three delegations.
- *Check the bound only just before spawning.* Rejected: the check and the spawn are separated by
  awaits, so concurrent calls could all pass a bound of one, and a call over the bound would still
  run the probes.
- *Count only new delegations.* Rejected: a follow-up spends as much as a delegation of the same
  size, and a retry loop is usually made of follow-ups.
- *Bound tokens instead of calls.* Rejected: tokens are known only after a run, so the bound would
  trip one run late, and a token budget reads as a quota estimate, which the server does not make.
- *Bound live process trees for the background cap.* Rejected for now: it changes what an existing
  limit means, and a tree being stopped is already on its way out under the shutdown schedule.
- *A daily or per-session total.* Rejected for now: an hour is short enough to stop a loop well
  inside the five-hour usage window of the plans this was observed on, and lets a long session
  continue at a pace the user chose. A longer window can be added later as another variable without
  changing this one.

## Consequences

A runaway loop is cut off at a number the user chose, before any CLI process starts, and the
refusal says when work can resume. A user who restarts Claude Code gets a fresh window; the bound is
a guard against loops, not an accounting of spend, which ADR 22's log provides.

Reservation adds state that must be released on every early exit; a leaked reservation would shrink
the bound until the process ends. Tests drive concurrent calls and every pre-spawn failure path
against a fake clock.

Both variables join the configuration table in the README and `server.json`, which
`test/registry.test.ts` checks, and `docs/CONTROL.md` describes them with the other restrictions.
