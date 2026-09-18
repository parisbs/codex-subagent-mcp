# 13. Confirm what Codex applied instead of re-implementing its configuration

Status: Accepted

## Context

This server passes the model, the reasoning effort and the sandbox explicitly on every invocation,
and until now it reported those requested values back as if they were the outcome. They usually are.
They are not always: Codex resolves the settings of a run from several layers, and the command line
is only the topmost one.

Verified against codex-cli 0.154.0, three ways a run can end up with something else:

- **Managed requirements.** `/etc/codex/requirements.toml` (and its Windows and MDM equivalents) can
  cap what a machine is allowed to use. OpenAI's managed-configuration documentation describes a
  value outside the allowed set as falling back to a compatible one, with a notification.
- **A model that does not support the effort.** The effort reaches the CLI as a config key, not as a
  validated flag, so the pairing is resolved inside Codex.
- **Resume drift.** A resumed session takes anything it is not given from the configuration of the
  directory it runs in. That is fixed for this server's own follow-ups (they restate model, effort
  and directory), but it is exactly the class of problem the request cannot see.

Two options were considered.

**Re-implement Codex's configuration resolution.** Read `~/.codex/config.toml`, the trusted
project's `.codex/config.toml`, the profile, the managed requirements, apply the documented
precedence and predict the outcome. This is a second implementation of someone else's resolver,
maintained against a moving target, and wrong in the one case that matters — when Codex behaves
differently from what its documentation says. A prediction that disagrees with reality is worse than
no prediction, because it reads exactly like a measurement.

**Observe what actually ran.** Codex writes a session file per thread under
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl`, and every turn appends a
`turn_context` line carrying `cwd`, `model`, `effort`, `sandbox_policy.type` and `approval_policy`.
The line is written before the turn runs and survives a turn that later fails. It is absent only for
`--ephemeral`, which this server does not use.

## Decision

Read the thread's `turn_context` after the child exits, compare it field by field against what was
requested, and report the comparison. The file is read forward from its start and the last context
found is used, with the read bounded at 16 MiB — on a thread long enough to pass that bound, the
comparison describes an earlier turn than the one just run. That is a known limit of reading a
format nobody promised, not a silent one: it is stated here and in `src/codex/rollout.ts`. `src/codex/rollout.ts` does the reading;
`src/outcome.ts` decides what a difference means.

Three rules give the comparison teeth without making it a new source of failures:

1. **A sandbox recorded as more permissive than requested fails the delegation**, with wording that
   says the run is already over and its commands already ran under that sandbox. The sandbox is what
   bounds an untrusted prompt; a silent widening is a security event, not a note.
2. **A different model, a different effort, a narrower sandbox or a different working directory are
   reported prominently and do not fail the run.** A shallower answer is still an answer. Failing it
   would teach the orchestrator to ignore `isError`.
3. **Anything unreadable is reported as `unconfirmed`, never as confirmed.** A missing file, an
   unparseable line, a sandbox name this server does not recognise: each says what it could not
   establish. `unconfirmed` is also what the caller sees when the lookup takes too long, which is
   bounded at two seconds.

A ceiling observed to have been exceeded after the fact (`ALLOWED_MODELS`, `MAX_EFFORT`) is reported
as a policy breach. The ceilings are enforced when the invocation is built; this says when something
downstream disagreed.

## Consequences

The server now depends on an internal, undocumented format. That dependency is deliberately shallow:
nothing about a delegation changes when the read fails, the parser tolerates unknown shapes, and the
result is a report rather than a decision — with the single exception of the sandbox rule, which
only fires on values this server recognises. A rename in that format degrades every delegation to
`unconfirmed`, visibly, rather than silently reporting the request as the outcome.

It has to be re-verified on every Codex CLI version bump, alongside the flag checks already listed in
`CLAUDE.md`. `test/rollout.test.ts` pins a real 0.154.0 line as a fixture, so a format change shows
up as a failing assertion rather than as a quiet loss of confirmation.

The read costs one directory walk and one file read per delegation, measured at 1–7 ms against a
real `~/.codex` — the day directories are searched newest first, which is where a fresh run's file
always is, and an older one is found by walking back.

What this does not do is prevent anything. Confirmation arrives after the run, because that is when
the evidence exists. Preventing a wider sandbox from ever being applied is not this server's to do:
it belongs to the managed requirements described in [SECURITY.md](../../SECURITY.md).
