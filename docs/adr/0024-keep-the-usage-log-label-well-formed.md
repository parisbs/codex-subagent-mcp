# 24. Keep the usage-log label well-formed and free of bidirectional controls

Status: Proposed

Supersedes the character rule of point 4 of [ADR 22](0022-keep-an-opt-in-local-usage-log.md), which
allows any label of 1 to 64 Unicode code points with no character of category Cc. Everything else in
that point stands: the length, storing the label verbatim, never sending it to Codex, never
interpreting it, accepting it with the log on or off, and inheriting it through the in-memory thread
registry.

## Context

While the acceptance tests for [#29](https://github.com/parisbs/codex-subagent-mcp/issues/29) were
being prepared, the label rule was tried against Node 24.14 on macOS on 2026-10-07. Two kinds of
text pass it and break what ADR 22 promises about the label.

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
family, and the soft hyphen and similar marks appear in real writing. Rejecting the whole category
would refuse labels that are fine.

[ADR 12](0012-mechanism-not-policy.md) still applies: the server does not judge what a label says.
Both rules below concern how the text is encoded and displayed, not its meaning.

## Decision

A label is accepted only when all of the following hold; otherwise the call is refused before any
CLI process starts, and the message names the rule the label broke:

1. It is 1 to 64 Unicode code points long, as before.
2. It is well-formed Unicode: it contains no unpaired surrogate.
3. It contains no character of category Cc, as before.
4. It contains no character with the Unicode property Bidi_Control: U+061C, U+200E, U+200F, U+202A
   to U+202E, and U+2066 to U+2069.

Nothing else is filtered or changed. The label is not normalised and not trimmed: labels that differ
only in normalisation form or in whitespace are different labels and form different groups, and a
label made only of spaces is accepted.

**Alternatives considered.**

- *Keep the Cc rule alone.* Rejected: the promise to store the label verbatim would be false for
  unpaired surrogates, and bidirectional controls let the summary display something other than what
  the file holds.
- *Replace unpaired surrogates with U+FFFD and accept the label.* Rejected: it changes the caller's
  text without saying so and can merge two labels into one group.
- *Reject the whole Cf category.* Rejected: it refuses legitimate text, emoji sequences joined with
  U+200D among it, and filters more than display integrity needs, which drifts toward judging content.
- *Strip bidirectional controls instead of refusing.* Rejected: the stored label would differ from
  the one sent, and a refusal tells the caller what to fix.
- *Escape bidirectional controls only when `codex_usage` displays them.* Rejected: the file itself,
  read with `jq` or an editor, would still carry them, and every reader would have to escape them.
- *Normalise to NFC or trim whitespace.* Rejected: it breaks "stored verbatim", and grouping by the
  exact string is the predictable behaviour.

## Consequences

`label` has not shipped yet, so no released interface changes: it arrives in 0.6.0 with this rule.
Acceptance criterion AC-11 of #29 states it.

The Bidi_Control set is a short, fixed list. Node 22, the supported floor, recognises the property
in Unicode regular expressions and provides `String.prototype.isWellFormed`, so neither check needs
a dependency.

ADR 22 keeps its own wording of the rule, "no control characters (Unicode category Cc)", as written;
its status line names this record as the successor for that part.
