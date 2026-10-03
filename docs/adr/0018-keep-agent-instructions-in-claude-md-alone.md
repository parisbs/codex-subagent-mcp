# 18. Keep agent instructions in CLAUDE.md alone

Status: Accepted

Supersedes the part of [ADR 15](0015-agents-md-and-immutable-records.md) that put the instructions in
`AGENTS.md`. What ADR 15 decided about immutable records stands.

## Context

ADR 15 moved the instructions to `AGENTS.md` because Codex reads that file, so a delegated run in this
repository would otherwise work without the hard rules unless its prompt repeated them. The premise
was checked on 2026-10-02 against Codex CLI 0.160.0 and `gpt-6.1-sol`, through this server and
directly with `codex exec`, in scratch directories with a planted `AGENTS.md`. Each probe is a single
low-effort run, so it shows that a behaviour exists, not how often.

- The file is loaded into a delegated run: a marker it asked for appeared in the answer, through the
  server and directly.
- An explicit instruction in the prompt wins over it. "Always answer REPO" lost to a prompt asking
  for TASK, with and without a sentence saying the prompt overrides.
- When the prompt is silent the file is obeyed. "Run `pwd` before any task" made a task that asked
  only for "DONE" run a command and doubled its input tokens.

The effect is additive, and for this repository it is concrete. `AGENTS.md` carries the workflow of a
human contributor: the full verify, the Codex review of argv construction, ADRs, the release
procedure. A delegated review or research task here would pick those obligations up, and the
orchestrator that wrote the task cannot see them. The server does not expose a way to switch project
documents off (`-c project_doc_max_bytes=0` works in a direct `codex exec`), and adding one would be
policy, which [ADR 12](0012-mechanism-not-policy.md) rules out. On the Claude Code side, `/init` and
`/import` write into `CLAUDE.md`, so a `CLAUDE.md` that only imports `AGENTS.md` tends to end up with
two diverging copies.

The same finding was recorded for the maintainer's workflow in its ADR 0012. This server stays neutral
toward other people's repositories: [ADR 7](0007-inject-the-quality-contract.md) still holds that an
existing `AGENTS.md` in a target repository is read by Codex.

## Decision

The instructions live in `CLAUDE.md` alone. There is no `AGENTS.md` in this repository.

The orchestrator passes a delegate what the task needs in the prompt, which ADR 7's contract already
requires of every delegation. A delegated run here finds no repository instructions of its own to add
to that prompt.

The lines the maintainer's workflow reads, `Verify:`, `Review:`, `Implement:` and `Human merge:`, are
in the Workflow section of `CLAUDE.md`.

**Alternatives considered.**

- *Keep ADR 15 as it is.* Rejected: a delegated run loads obligations the orchestrator did not ask
  for, and the duplication with `/init` and `/import` remains.
- *Keep `AGENTS.md` and give the server an option that switches project documents off.* Rejected: it
  is a policy decision the server should not take (ADR 12), and it leaves a file whose only reader is
  Claude Code through an import.
- *Keep `AGENTS.md` for neutral facts and `CLAUDE.md` for the rest.* Rejected: a delegate obeys any
  fact written there, so the file cannot be kept neutral.
- *Symlink `CLAUDE.md` to `AGENTS.md`.* Rejected: it breaks on Windows clones without
  `core.symlinks` and keeps the loading problem.

## Consequences

Codex run directly in this repository, and any tool that reads only `AGENTS.md`, gets no repository
instructions. If one is used here, that is a new decision.

A delegation that needs a hard rule says so in its prompt. A Codex review of a change to argv
construction, the event parser or the catalog carries the relevant invariants in its prompt; it no
longer finds them in the repository.

A global `~/.codex/AGENTS.md`, if one exists, is still loaded into every delegation and is outside
this repository's control.

Where ADR 13 says `AGENTS.md`, it said `CLAUDE.md` when it was accepted, and it reads `CLAUDE.md`
again now; ADR 15 acknowledged only that edit. ADRs 7, 8, 9 and 14 were also edited after they were
merged, all before the immutability rule of 2026-09-29 (#95); this record states it so the history is
complete. The status column of the index records the change to ADR 15 and nothing else in it.
