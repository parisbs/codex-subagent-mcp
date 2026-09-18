# Writing a delegation

This guide is about shaping one delegation. The [README](../README.md) explains when delegation is
useful, and the [tool reference](TOOLS.md) defines every parameter.

The measurements below are tendencies, not laws. They come from 34 real sessions under
`CODEX_HOME` and controlled pairs run on one macOS machine on 2026-09-17 with Codex CLI 0.154.0.
Repositories, configuration, cache state and later CLI versions can change the result. Every token,
request, command, duration and prompt-size figure in this guide is from that dated measurement set.

## The cost model

Cost is roughly requests multiplied by the context carried into each request. A request is each
command Codex runs, plus one for the answer. The context grows with everything Codex has already
read or produced, because it is sent again on later requests. In the most expensive measured
session, 159,000 tokens of accumulated command output became 3,320,000 input tokens across 30
requests. A delegation also had a measured floor of about 14,000 input tokens, roughly 10,000 of
them cached, before useful work began. Saving an unnecessary search or command usually matters more
than polishing a few sentences out of the prompt.

## Rules, in measured order

### 1. Bound the search and name the stopping condition

Give Codex the exact question, likely paths and the form of the answer. In one controlled narrow
question, naming `target_files` reduced the run from 65,808 input tokens and 17,424 uncached tokens
across two commands to 30,415 input tokens and 6,351 uncached tokens across one command. This was
one pair measured on 2026-09-17 with Codex CLI 0.154.0, not a promise that every file list halves a
run.

Use `target_files` as a focus list. Put decisive excerpts in `context`, especially when they are
short. State what Codex may leave unexplored and what evidence the answer must include.

### 2. Spend reasoning effort where the question is genuinely open

On a narrow question, changing `reasoning_effort` from `low` to `high` changed almost nothing except
the answer length: 30,415 versus 30,464 input tokens in the 2026-09-17 Codex CLI 0.154.0 pair. On an
open-ended investigation, the same prompt used 31,112 uncached tokens and five commands at `low`,
against 99,290 uncached tokens and 11 commands at `high`; the high-effort run found a real defect the
low-effort run missed. High effort is therefore a quality budget for ambiguity and defect recall,
not a default for every task.

### 3. Reuse a thread for a real continuation

A measured follow-up on 2026-09-17 with Codex CLI 0.154.0 used 10,949 uncached tokens, against
14,497 for a fresh delegation answering the same question. It was slower, however: 28 seconds
against 12. Use `codex_follow_up` when the next question depends on what the thread already learned;
start fresh when independence or latency matters more.

### 4. Choose the model for capability, not as the first cost lever

For one narrow, well-scoped question measured on 2026-09-17 with Codex CLI 0.154.0,
`gpt-5.6-luna` used 30,415 input tokens and `gpt-5.6-sol` used 33,567. That small difference does not
generalise to harder work. Pick a model that can do the task, then control breadth and effort.

### 5. Do not micro-optimise ordinary prompt prose

The complete prompt assembled by this server measured between 1,100 and 4,500 tokens in every one
of the 34 sessions recorded on 2026-09-17 with Codex CLI 0.154.0, including the session that reached
3,320,000 input tokens. Prompt prose was not the lever in that sample; repeated tool turns and
growing output were.

Do remove repetition that obscures the task. Do not remove constraints, evidence requirements or a
short decisive excerpt merely to save prompt tokens.

## Worked pairs

These examples use the real `codex_delegate` parameter names. Model slugs are examples from the
catalog used for the 2026-09-17 Codex CLI 0.154.0 measurements; call `list_codex_models` or
`codex_recommend` against the target `working_dir` before copying them.

### Review a change

Weak: broad scope, duplicated quality exhortations and no definition of a finding.

```json
{
  "prompt": "Review the recent changes. Be thorough and do not hallucinate.",
  "model": "gpt-5.6-sol",
  "reasoning_effort": "high",
  "system_instructions": "Act as a senior engineer. Be thorough. Do not hallucinate.",
  "working_dir": "/Users/me/project",
  "sandbox": "read-only"
}
```

Strong: the same review has a boundary, failure modes and an answer shape.

```json
{
  "prompt": "Review the timeout change for correctness. Trace success, timeout, cancellation and child-process close paths. Report only actionable defects, each with file and line, the failing sequence, and the smallest safe fix. If no defect is supported by the code, say so. Do not edit files.",
  "model": "gpt-5.6-sol",
  "reasoning_effort": "high",
  "target_files": [
    "src/codex/runner.ts",
    "test/runner.test.ts"
  ],
  "acceptance_criteria": [
    "Every finding identifies a reachable failure sequence.",
    "Tests are checked for coverage of each reported sequence."
  ],
  "working_dir": "/Users/me/project",
  "sandbox": "read-only"
}
```

### Investigate across a repository

Weak: Codex must invent both the question and the stopping point.

```json
{
  "prompt": "Understand this repository and find problems.",
  "model": "gpt-6-astra",
  "reasoning_effort": "high",
  "working_dir": "/Users/me/project",
  "sandbox": "read-only"
}
```

Strong: the task is still repository-wide, but each search serves one concrete explanation.

```json
{
  "prompt": "Trace how a requested reasoning effort moves from the MCP call to the Codex CLI argv and then into the reported applied settings. Identify every validation or clamping step. Stop after the complete call chain is established; do not review unrelated code or edit files.",
  "model": "gpt-6-astra",
  "reasoning_effort": "high",
  "target_files": [
    "src/server.ts",
    "src/codex/catalog.ts",
    "src/codex/args.ts",
    "src/codex/rollout.ts"
  ],
  "acceptance_criteria": [
    "The answer gives the call chain in order with file and symbol names.",
    "It distinguishes requested, resolved and observed effort."
  ],
  "working_dir": "/Users/me/project",
  "sandbox": "read-only"
}
```

Keep high effort here when missing a subtle branch would be costly. Lower it when the call chain is
already known and only needs to be transcribed.

### Make a mechanical edit across many files

Weak: the run has to discover the file set, infer the replacement and attempt a commit it cannot
make under `workspace-write` because Codex keeps `.git` read-only.

```json
{
  "prompt": "Update all the old option names everywhere, test it, and commit the result.",
  "model": "gpt-5.6-sol",
  "reasoning_effort": "high",
  "working_dir": "/Users/me/project",
  "sandbox": "workspace-write"
}
```

Strong: the transformation and file set are explicit, the cheap effort matches the task, and
verification stops the edit from becoming an unbounded review.

```json
{
  "prompt": "In the listed files, rename the JSON field `timeoutMs` to `timeout_ms` in schemas, fixtures and assertions. Do not change the internal TypeScript property `timeoutMs`. Run the focused server test, then report the files changed and the command result. Do not commit.",
  "model": "gpt-5.6-luna",
  "reasoning_effort": "low",
  "target_files": [
    "src/server.ts",
    "test/server.test.ts",
    "test/fixtures/request.json",
    "docs/TOOLS.md"
  ],
  "acceptance_criteria": [
    "Only the external JSON field is renamed.",
    "The focused server test passes.",
    "No listed file retains the old external field name."
  ],
  "working_dir": "/Users/me/project",
  "sandbox": "workspace-write"
}
```

`target_files` is guidance, so verification should still search for missed occurrences when the
acceptance criteria require completeness.

## Things these parameters do not mean

These are common but incorrect claims:

- **`target_files` confines reads.** It does not. It is a section of the prompt, nothing more.
- **`working_dir` confines reads.** It selects the execution and configuration context. The sandbox
  restricts writes and shell networking, not reads.
- **`read-only` controls cost.** It is a safety control. It can also prevent Codex from verifying its
  answer when a test suite needs temporary files. In the same 2026-09-17 Codex CLI 0.154.0 setup,
  Codex's web-search tool worked in a read-only sandbox while shell networking did not; neither
  behaviour makes the sandbox a token budget.
- **Pointing at a file is always cheaper than pasting it.** What Codex reads is added to context and
  sent again on later requests. Referencing wins when Codex reads selectively or late. Paste a
  short, decisive excerpt instead of making Codex search for it.
- **Higher effort is always better.** It can buy defect recall on open questions and buy only a
  longer answer on narrow ones, as the dated pairs above show.
- **Shortening ordinary prose is a meaningful saving.** In the dated sample above, the server's
  whole prompt remained small beside accumulated command output.

Persona instructions such as "act as a senior engineer" and repeated exhortations such as "be
thorough" or "do not hallucinate" add nothing here. The server already prepends the quality
contract in `src/prompt.ts`: stay within scope, disclose blocked work, avoid unrelated changes,
verify claims against real files and commands, report failures faithfully, match project style,
reuse existing helpers, avoid destructive operations and unrequested git or machine changes, and
finish with a concise account of changes and verification. Use `system_instructions` only for a
rule or perspective that contract does not contain.

## Open questions

The measurements do not answer these yet:

- Pasted versus referenced context for the same large artefact, with the task held constant.
- Whether explicit acceptance criteria improve defect recall enough to justify any extra requests
  they cause.
- Model-by-effort grids evaluated on answer quality as well as tokens.
