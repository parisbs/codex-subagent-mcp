# 24. Settle the open details of the usage log

Status: Accepted

Supersedes the character rule of point 4 of [ADR 22](0022-keep-an-opt-in-local-usage-log.md), which
allows any label of 1 to 64 Unicode code points with no character of category Cc. Everything else in
that point stands: the length, storing the label verbatim, never sending it to Codex, never
interpreting it, accepting it with the log on or off, and inheriting it through the in-memory thread
registry. The rest of this record decides what ADR 22 leaves open and replaces none of it.

## Context

Before the acceptance tests for [#29](https://github.com/parisbs/codex-subagent-mcp/issues/29) were
frozen, its criteria were reviewed by Codex and ADR 22 was tried against the installed Codex CLI
(0.160.1) and Node 24.14 on macOS, on 2026-10-07. The full results are on #29. Two of them break
what ADR 22 promises about the label:

- **An unpaired surrogate** (category Cs) is not a control character, so the rule accepts it. It
  survives the JSON transport as an escape, and `JSON.parse` returns it unpaired, but writing the
  string as UTF-8 replaces it with U+FFFD: `"a\uD800b"` reached the file as the bytes `61 ef bf bd
  62`. The stored label is then not what the caller sent, which contradicts "stored verbatim", and
  two different labels can end up as one group in `codex_usage`.
- **Bidirectional controls** such as U+202E RIGHT-TO-LEFT OVERRIDE are category Cf, so the rule
  accepts them too. `codex_usage` shows labels as the caller wrote them, and an override reverses
  how the rest of its line is displayed, so one label can be made to look like another, or the
  figures printed next to it can appear in a different order. The summary is read as text by the
  orchestrator and aloud by a screen reader; either way it has to show what the file holds.

The rest of category Cf is ordinary text. U+200D ZERO WIDTH JOINER builds emoji sequences such as a
family, and the soft hyphen and similar marks appear in real writing.

Others leave a choice that two reasonable implementations, or two reasonable tests, would make
differently:

- `turn.completed` now carries a fifth counter, `cache_write_input_tokens`, which this server does
  not read; it was 0 in every run, and its relation to `input_tokens` is undocumented. The parser
  turns a missing counter into 0.
- A turn that fails at the API emits `turn.failed` with no usage, and a turn interrupted with SIGINT,
  which is how the server cancels, emits no usage at all. Codex spent tokens on both.
- `fs.rename` replaces an existing file silently, so a name that is not unique can destroy an
  archive. Within one process, two delegations that finish together could rotate in the same
  millisecond under the same pid. The obvious way to refuse a replacement, linking the file to the
  new name and then unlinking it, duplicated 16,939 lines and lost 372 in a test with six processes
  rotating at once; renaming to a unique name kept all 18,000 once each. An ISO timestamp contains
  `:`, which Windows forbids in file names.
- ADR 22 does not say what an empty value of the variable means, what happens when the rotation or
  the deletion of old archives fails rather than the append, where the duration starts, what to do
  with an entry dated in the future, or which fields the reader needs.

[ADR 12](0012-mechanism-not-policy.md) still applies: the server does not judge what a label says.
The label rules below concern how the text is encoded and displayed, not its meaning.

## Decision

1. **The label.** A label is accepted only when it is 1 to 64 Unicode code points long, well-formed
   (no unpaired surrogate), and contains no character of category Cc and none with the Unicode
   property Bidi_Control (U+061C, U+200E, U+200F, U+202A to U+202E, and U+2066 to U+2069).
   Otherwise the call is refused before any CLI process starts, and the message names the rule the
   label broke. Nothing else is filtered or changed: the label is not normalised and not trimmed, so
   labels that differ only in normalisation form or in whitespace form different groups, and a label
   made only of spaces is accepted.
2. **An empty value is unset.** `CODEX_SUBAGENT_USAGE_LOG` is trimmed, and an empty result means
   the default, `off`, as for every other variable of this server. A refusal for any other value
   lasts as long as the server runs with it; the configuration is read once, at start.
3. **Tokens are known as a whole or not at all.** An entry's tokens are known only when input,
   cached, output and reasoning all arrive as non-negative integers; otherwise every token field is
   `null`, never filled with zeros. `cache_write_input_tokens` is not recorded; a later schema
   version can add it once its meaning is established. Tokens are never read from Codex's session
   file to fill a gap: that file also carries quota figures, and it is the only internal format this
   server reads.
4. **Sums are a lower bound, and the summary says so.** When any entry in a `codex_usage` summary has
   unknown tokens, the summary states that its sums are a lower bound, because cancelled, timed-out
   and failed-turn runs report no tokens although Codex spent them. It gives no estimate of the
   missing amount.
5. **Archive names are unique by construction.** Each process writes one entry at a time, so it
   never rotates twice at once. The timestamp in `usage-<UTC timestamp>-<pid>.jsonl` is compact and
   contains no `:`; if a file with that name exists anyway, another name is chosen. Archives are
   ordered by the timestamp in their names when the oldest are deleted.
6. **A failed rotation skips the entry; a failed deletion does not.** If the rename fails, the entry
   is not written and the result says so, as for any failed write, so the current file never grows
   past its cap. If only deleting old archives fails, the entry is still written and the result says
   the archives could not be pruned: the current file stays bounded, and the next rotation tries
   again.
7. **The duration starts at the spawn.** It runs from the spawn of the delegation process to the end
   time ADR 22 defines. The preflight, catalog and listing probes before it are excluded.
8. **Entries dated in the future count.** `codex_usage` keeps every entry whose end time is at or
   after the start of the window, including any later than now, as after a clock adjustment.
9. **The reader needs a fixed set of fields.** An entry is used when it has a known schema version
   and a valid end time, duration, kind, outcome, command count, applied model and effort, label
   (`null` or text) and tokens (`null` or the four counts); the other fields are not checked. The
   set does not depend on the grouping requested, so the count of skipped lines does not either.

**Alternatives considered.**

- *Keep the Cc rule alone.* Rejected: the promise to store the label verbatim would be false for
  unpaired surrogates, and bidirectional controls let the summary display something other than what
  the file holds.
- *Replace unpaired surrogates with U+FFFD and accept the label.* Rejected: it changes the caller's
  text without saying so and can merge two labels into one group.
- *Reject the whole Cf category.* Rejected: it refuses legitimate text, emoji sequences joined with
  U+200D among it, and filters more than display integrity needs, which drifts toward judging content.
- *Strip bidirectional controls, or escape them only when displayed.* Rejected: stripping stores a
  label different from the one sent, and escaping on display leaves them in the file for every other
  reader.
- *Normalise to NFC or trim the label.* Rejected: it breaks "stored verbatim", and grouping by the
  exact string is the predictable behaviour.
- *Treat an empty value as a configuration error.* Rejected: every other variable of this server
  treats it as unset, and an environment template that exports the variable empty should not stop
  delegations.
- *Record `cache_write_input_tokens` now.* Rejected: a counter whose meaning is unknown adds nothing
  to a comparison between delegations, and the schema version makes adding it later safe.
- *Keep each known counter and null only the missing ones.* Rejected: sums and the derived uncached
  input would then mix entries with different coverage, and the CLI has never been seen sending a
  partial set.
- *Read the missing tokens from the session file.* Rejected for the reasons in point 3.
- *Add a sequence number to the archive name.* Rejected: writing one entry at a time already rules
  out a collision within a process, and it keeps ADR 22's name.
- *Link the file to the archive name and unlink it, so that no rename can replace a file.* Rejected
  on the measurement above: it duplicates and loses lines under concurrent rotation.
- *Append anyway when the rotation fails.* Rejected: a rename that keeps failing would let the file
  grow without bound.
- *Treat a failed deletion as a failed write.* Rejected: it would lose an entry when the file it
  goes to is still within its cap.
- *Start the duration at the tool call.* Rejected: the probes before the spawn depend on caches and
  configuration, so the figure would not compare like with like.
- *Drop entries dated in the future.* Rejected: they are recent work, and hiding them after a clock
  change would understate the window.
- *Check only the fields the requested grouping uses, or every field of the line.* Rejected: the
  first makes the skipped count change with the grouping; the second rejects entries whose damage
  does not affect the summary, which ADR 22 does not ask for.

## Consequences

`label` and `codex_usage` have not shipped yet, so no released interface changes: they arrive in
0.6.0 with these rules, which the acceptance criteria of #29 state.

The Bidi_Control set is a short, fixed list. Node 22, the supported floor, recognises the property
in Unicode regular expressions and provides `String.prototype.isWellFormed`, so neither check needs
a dependency.

The parser that reads `turn.completed` has to tell a missing counter from a zero one, which the
result rendering does not need today. That parser is on the `Human merge:` line.

Summaries understate what Codex spent by whatever the cancelled, timed-out and failed-turn runs
used, and say so rather than guess.

Windows behaviour of the rotation, a rename while another process holds the file open, was not
tested; the CI on Windows is the first place it runs.

ADR 22 keeps its own wording of the label rule, "no control characters (Unicode category Cc)", as
written; its status line names this record as the successor for that part.
