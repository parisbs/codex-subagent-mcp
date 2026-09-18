# 7. Inject the quality contract into the prompt

Status: Accepted

## Context

A delegated subagent that does not share the orchestrator's standards produces work the orchestrator
has to redo. The specific failures that matter are predictable: silently expanding or narrowing
scope, asserting things it did not verify, inventing APIs or file paths, claiming a build passed
without running it, and making unrequested git commits.

Codex reads an `AGENTS.md` file from the working directory automatically, which is the idiomatic way
to give it project rules. But this server points at *other people's repositories*. Writing a file
into a target repository as a side effect of being asked to analyse it is the wrong behaviour: it
mutates a tree the caller asked us to read, shows up in their `git status`, and may contradict an
`AGENTS.md` they already maintain.

## Decision

Prepend a fixed `<delegation_contract>` block to every delegation prompt, covering scope discipline,
truthfulness, code style, safety and reporting. Never write `AGENTS.md` or any other file into the
target repository.

Layer the caller's own material on top as delimited sections, in a fixed order: the contract, then
the execution mode when read-only, then `system_instructions` from the orchestrator, then `context`,
`target_files` and `acceptance_criteria`, and finally the task — last, so it sits closest to the
model's generation point.

Addendum, 0.3.0: a short instruction telling a delegated run not to delegate further now sits
immediately after the contract, before the execution mode. It is a second layer behind the MCP
configuration override that actually prevents recursion, and is labelled as an instruction rather
than a control where it is defined.

## Consequences

The contract travels with every delegation regardless of which repository it targets, and the server
leaves no trace in the caller's tree.

Because the orchestrator's `system_instructions` are layered on top rather than replacing the
contract, a caller cannot accidentally drop the baseline by supplying a persona.

An existing `AGENTS.md` in the target repository is still read by Codex, as it should be. The
contract sits alongside project rules rather than competing with them — though a project whose
`AGENTS.md` contradicts the contract will produce ambiguity the server cannot resolve.

The contract costs input tokens on every call. It is heavily cached by the CLI across a session, and
the alternative — re-doing work that was done to the wrong standard — is far more expensive.

A follow-up turn does not repeat it: the contract is already in the resumed session's history.
