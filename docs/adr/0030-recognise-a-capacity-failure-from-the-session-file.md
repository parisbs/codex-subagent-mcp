---
status: accepted
date: 2026-10-19
---
# 30. Recognise a capacity failure from the session file

Extends [ADR 13](0013-confirm-applied-settings.md): the session file it reads for the applied
settings also says why a failed turn failed, and the result reports it without deciding anything.

## Context

On 2026-10-07 a delegation on gpt-6-astra (codex-cli 0.160.1) finished its work and then failed
while requesting its final message: OpenAI answered `503 Service Unavailable` for about two minutes,
and Codex gave up with "Selected model is at capacity. Please try a different model." The result
showed a failed run with partial output. Nothing said that the cause was temporary and on OpenAI's
side, that the changes in the working directory persisted, or that resuming the thread would
recover the report ([issue #158](https://github.com/parisbs/codex-subagent-mcp/issues/158)).

Two sources can tell this failure apart from the others:

- **The `codex exec --json` stream.** It carries only free text. A failed turn ends with a top-level
  `error` event and `turn.failed`, both holding a `message` and nothing else. This was verified on
  0.162.1 with a usage limit and on 0.163.0 with a schema rejection. `src/codex/events.ts` already
  reads all of it.
- **The session file.** The `event_msg` line of type `task_complete` that closes a turn carries
  `turn_id` and, for a failed turn, `error.codex_error_info`; like every line, it sits in an
  envelope whose `timestamp` records when it was written, to the millisecond. The
  failure above recorded `"server_overloaded"`. The same shape is in local session files from
  0.154.0, 0.159.2, 0.160.1, 0.162.1 and 0.163.0, with the values `usage_limit_exceeded` and
  `other` as well. A successful turn's `task_complete` has no `error` key.

A thread's file holds every turn of the thread, because a follow-up appends to it. On 0.163.0 a turn
rejected with `other` and resumed successfully left both `task_complete` records in the file. The
record that describes a run is therefore not just the last error in the file. It is the record of
the turn that run started. Each turn writes its `turn_context` when it starts and its
`task_complete` when it ends, both with the same `turn_id`. A scan of 245 local session files found
no turn with two `turn_context` lines and no delegation file that holds turns of another thread:
Codex subagents such as `review` write files of their own.

The read ADR 13 set up has two limits that matter here. It stops at 16 MiB, so on a long thread the
last `turn_context` it sees can belong to an earlier turn. And a run that dies before its turn
writes anything leaves the previous turn as the last one in the file. In both cases the last
complete turn read is not this run's turn, and an earlier capacity failure on the same thread would
be reported again.

Five alternatives were considered and rejected.

**Match the message text.** "Selected model is at capacity" is the only signal in the stream. But it
is wording OpenAI controls and can change without notice, and a change would make recognition stop
silently, with nothing failing. The usage-limit message already embeds a time and a URL that change
from run to run. Free text is a description, not an identifier.

**Read any `task_complete` with an error, or the last one in the file.** This is simpler, but a
follow-up on a thread whose earlier turn hit capacity would report a capacity failure for a run
that failed for another reason.

**Retry, or switch to another model, when capacity is the cause.** This would recover the report
without the caller. But which model runs is the caller's decision
([ADR 12](0012-mechanism-not-policy.md)), and a retry spends quota the caller did not ask to spend,
on a service that just said it is overloaded.

**Report a capacity failure as a success with partial output.** The work may well be done, as it
was on 2026-10-07. But the run produced no final report, nothing confirms which part of the work
finished, and a result that is not an error would be taken as complete by an orchestrator that
trusts `isError`.

**Give every `codex_error_info` value a note of its own.** The mechanism would allow it. But each
value needs its own wording and its own evidence, and the usage-limit message already says when to
try again. Only `server_overloaded` has a confirmed case and a confirmed gap in what the caller is
told.

## Decision

Read the closing record of the run's own turn from the session file, and when it says
`server_overloaded`, add a note to the failed result.

1. **`src/codex/rollout.ts` reads the record in the pass it already makes.** It keeps the
   `task_complete` whose `turn_id` equals the `turn_id` of the last `turn_context` read, and returns
   its `codex_error_info` and the envelope's `timestamp` as they are, or nothing when either is
   missing or malformed. It remains the only module that touches this format, and it gives the values no
   meaning, as in ADR 13.
2. **The record must belong to this run.** It counts only if its `timestamp` is not earlier than
   the moment this run's process was spawned. That excludes an earlier turn reached because the read
   stopped at 16 MiB, or because this run's turn left nothing in the file. A follow-up cannot be
   spawned before the previous run's result exists, and that result is built after its record was
   written.
3. **The note appears only on a run that ended with `turn.failed` and whose record says
   `"server_overloaded"`.** Any other value, no value, an unreadable or unfound file, a lookup past
   its two-second bound, a timeout, a cancellation or a failure seen only in the exit code adds
   nothing. The failure is then reported as today, and the missing note says nothing either way.
   The message text is never consulted.
4. **The note changes the report and nothing else.** The result stays `isError`. `describeFailure()`
   and therefore the usage log and `codex_job_status` are unchanged. No process is started: no
   retry, no other model. The note is added where the failure is rendered, which `codex_delegate`,
   `codex_follow_up` and `codex_job_result` share, so the three never disagree. It says that the
   model was temporarily at capacity on OpenAI's side, not a problem with the task or the
   configuration; that whatever the run changed in its working directory or worktree persists; and
   that `codex_follow_up` on the reported thread can retrieve the final report, or the caller can
   retry later or choose another model.

## Consequences

The caller learns what it needs to decide its next step, without the server taking it. Whether to
resume, wait or change model stays with the caller.

`task_complete` becomes the third line of Codex's internal session format this server reads, after
`turn_context` and `session_meta`. `test/rollout.test.ts` pins real lines: the 0.160.1 capacity
record, the 0.162.1 usage-limit record as the negative case, and a 0.163.0 thread with a failed
turn followed by a successful follow-up. They are re-verified on every CLI bump like the other two.
`CLAUDE.md`'s invariant on the session file gains `task_complete`, and `docs/TOOLS.md` describes the
note.

The value `server_overloaded` has been seen only on 0.160.1. Reproducing it means waiting for
OpenAI to be overloaded, so earlier versions are unverified: if they record capacity under another
value, or 0.154.0 never does, those versions simply show no note. A rename of the value in a later
version degrades the same way. That loss is visible only to someone who knows the note exists, which
is the price of not matching text.

The time check compares two readings of the same machine's clock, the envelope `timestamp` Codex
writes and the spawn time this server records, both in milliseconds. A clock set back during a run
would hide the note, which fails in the direction of saying nothing. The `completed_at` field of the
record was not used, because it has only second precision, and a follow-up spawned within the
second its predecessor finished would have matched the earlier turn.

Until [issue #138](https://github.com/parisbs/codex-subagent-mcp/issues/138) settles which parts of
a result are contract, the wording of the note is not.
