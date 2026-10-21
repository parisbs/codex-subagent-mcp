---
status: accepted
date: 2026-10-20
---
# 32. Scope instructions with path rules and hooks

Amends [ADR 18](0018-keep-agent-instructions-in-claude-md-alone.md): the instructions stay out of
`AGENTS.md`, but they no longer live in `CLAUDE.md` alone.

## Context

`CLAUDE.md` had grown to 254 lines and 17,722 bytes, about 4,400 tokens, loaded into every Claude
Code session in this repository whatever the task. Claude Code's guidance is to stay under 200 lines,
because a longer file costs context and lowers adherence, and to move what matters only for part of
the codebase into path-scoped rules. Measured against the code on 2026-10-20, about half of the file
mattered only when touching one area: the Codex CLI traps and session-file format (`src/codex/`), the
termination and shutdown budget (three files and their tests), the test stand-in (`test/`) and the
release procedure. A review of the same file found three statements the code contradicted: that an
MCP listing failure is fail-open, that `src/server.ts` owns all user-facing formatting and that the
model fallback exists only when the CLI cannot be reached.

Some rules were also deterministic, so text was the weakest way to hold them. `CHANGELOG.md` changes
only on a release branch, which an agent can be told but a hook can enforce, and a session started on
a `build/` older than `src/` runs stale code through `.mcp.json` without saying so.

Path-scoped rules are files in `.claude/rules/` with a `paths` front matter field. Claude Code loads
one only when it reads or edits a matching file, and Codex does not read `.claude/rules/` at all, so
they do not reopen the problem ADR 18 solved: a delegated run still loads no repository instructions
of its own. The workflow's hooks read `CLAUDE.md` only: `task-package` copies its Invariants and
Conventions sections and its `Verify:` line into a delegation, and `controlplane` reads its
`Human merge:` line.

## Decision

`CLAUDE.md` keeps what every session needs: the verify command, the invariants, the architecture
summary, the conventions and the workflow lines, in the formats the hooks parse. Detail that matters
for one area moves to a path-scoped rule in `.claude/rules/`, and the invariant that needs it points
to the rule by path, so a delegation package built from `CLAUDE.md` still names it and a delegate can
read it in the checkout. History that explains a rule but does not change what to do, such as issue
numbers, is dropped or kept in HTML comments, which Claude Code strips before loading.

A rule that a program can check is enforced by a hook in `.claude/hooks/`, registered in
`.claude/settings.json` and tested in `test/claude-hooks.test.ts`, and `CLAUDE.md` keeps only a line
naming it. A hook that cannot decide lets the action through: these hooks guard conventions, not
secrets. `.claude/hooks/` joins the `Human merge:` line, since an agent could otherwise weaken a
control that applies to itself.

**Alternatives considered.**

- *Keep everything in `CLAUDE.md` and shorten it.* Rejected: the area-specific detail is what keeps
  those areas correct, and shortening it loses the facts; scoping keeps them at no cost elsewhere.
- *Move the detail to skills.* Rejected: a skill loads when invoked or judged relevant to the prompt,
  not when the file is touched, and these rules must be present while editing those files.
- *`@` imports from `CLAUDE.md`.* Rejected: imported files load at launch, so they organise the file
  without reducing its cost.
- *Move the invariants themselves into rules.* Rejected: `task-package` reads only `CLAUDE.md`, so a
  delegation package would lose them. Only detail behind an invariant moves.
- *Enforce the changelog rule in CI instead of a hook.* Not chosen for now: it would need a new
  required check in the ruleset; the hook stops the agents that are the practical source of the
  mistake. Edits made through the shell bypass it.

## Consequences

Every session here starts with about 6,200 bytes of `CLAUDE.md` instead of 17,700. Touching every
scoped area at once loads about 9,000 bytes more, still below the old total.

An orchestrator building a package for a task in `src/codex/` must carry `.claude/rules/codex-cli.md`
or tell the delegate to read it; the invariant in `CLAUDE.md` says so. `CONTRIBUTING.md` keeps the
human-facing form of the hard rules.

The project hooks run for every contributor who uses Claude Code here. They are written for Node
only, with no shell syntax beyond `$CLAUDE_PROJECT_DIR`, and fail open.

ADR 18's front matter status and its index row name this record as amending its decision; ADR 18's
body is not edited.
