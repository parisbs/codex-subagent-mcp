---
status: Accepted
---
# 28. Describe the instance in server instructions, not in tool descriptions


## Context

Everything this server tells the orchestrator before a call is fixed text, written for one
configuration. Two consequences surfaced in
[issue #143](https://github.com/parisbs/codex-subagent-mcp/issues/143) and
[issue #180](https://github.com/parisbs/codex-subagent-mcp/issues/180):

- The `codex_delegate` description tells the caller to call `codex_recommend` first whenever the user
  has named no model, also when `CODEX_SUBAGENT_DEFAULT_MODEL` is set or the allow-list holds a single
  model. An orchestrator that follows it passes the matrix's model explicitly, so the user's default
  never applies. That puts the matrix back on the execution path, which
  [ADR 12](0012-mechanism-not-policy.md) removed, and brings back the round trip ADR 12 says
  `DEFAULT_MODEL` removes.
- The same description says "Set sandbox to workspace-write to let it edit files" on a registration
  capped at `read-only`, and the server sends no `instructions` at connect time. A user who runs two
  registrations with different ceilings gives the orchestrator two identical sets of tools that only
  the registered name tells apart.

Where the orchestrator reads matters. With tool search, which Claude Code enables by default, only
tool names and server instructions load at session start; a tool's description reaches the model
only once the tool is searched for or loaded. Claude Code cuts server instructions at 4,096
characters ([Claude Code docs, "Scale with MCP tool search"](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search)).
The orchestrator chooses a registration, and what to ask of it, before it has read a description.

Three alternatives were considered and rejected.

**Generate every tool and parameter description from the configuration** (#143). The descriptions
would state the ceiling directly, which also reaches clients that do not show server instructions.
But the schemas of `codex_delegate` and `codex_follow_up` are module-level constants and would become
per-configuration factories; every description would multiply the combinations to test; and each
would need a rule for what it says while the configuration has errors, when the effective values are
fallbacks. Most of that cost exists only because a description would state a configured value.

**A free-text purpose variable** appended verbatim to the instructions, so the user can say what a
registration is for in their own words. It is the only part that adds configuration surface, which
[ADR 17](0017-define-1-0-as-the-interface-freeze.md) freezes at 1.0. The stated facts already tell
two registrations apart when their configuration differs, and two registrations that differ in
nothing else are interchangeable.

**Fail at startup when the configuration has errors**, so that no fallback value is ever described.
ADR 12 already rejected it: a server that refuses to start cannot explain why, and the user sees
tools that are simply absent.

## Decision

Tool descriptions describe the tool. Server instructions describe the instance.

- **Descriptions are fixed text, true under every configuration.** Where behaviour depends on the
  configuration, a description says so and points to the server instructions; it never assumes a
  value. The sandbox guidance says that `sandbox` sets what Codex may change, up to this server's
  ceiling, which the instructions state, and that a call above it is refused.
- **One exception: the model guidance in the `codex_delegate` description.** When a default model is
  configured or implied (`impliedModel()`) and the configuration has no errors, it tells the caller
  to omit `model` so the default applies. Otherwise it keeps the guidance to call `codex_recommend`
  first. A description may depend on the configuration only where fixed text would override the
  user's policy, and this one does in every client, including those that do not show instructions.
- **The instructions are the one text generated from the configuration**, from the `ServerConfig`
  that `loadConfig()` returns, the object execution uses, never from the environment directly. They
  are fixed sentences in which only values change, in this order: what the server does, first, so
  tool search knows when to look for it; the sandbox ceiling and whether it was configured or is the
  built-in one, the distinction `checkSandbox` already makes; the default sandbox; the default model
  and effort, only when set, stated as configured rather than available, since nothing checks them
  against the catalog before a call reaches the CLI; and the inherited MCP servers, plugins and apps
  a delegation keeps, only when any are kept, by kind and count rather than by name, which keeps the
  length bounded. They do not state the effort ceiling or the allow-list: both are enforced per call
  with their own messages and do not help choose a registration.
- **A misconfigured server describes no fallback.** With any configuration error, the instructions
  say only that the server is misconfigured, that its delegation tools refuse until it is fixed, and
  that `codex_doctor` lists the errors. The server keeps starting. The descriptions need no special
  case, since they state no configured value.
- **No new environment variable.**

`createServer` loads the configuration before it constructs the `McpServer`, which takes
`instructions` at construction, and accepts an already loaded configuration so that two
configurations can run in one process.

## Consequences

In Claude Code the orchestrator sees each instance's ceiling, defaults and inherited tools before
its first call, and a configured default model is no longer overridden by the server's own text.
Running one registration per ceiling, the arrangement that keeps the read-only guarantee in the
process rather than in a client-side hook, becomes usable without routing rules in the
orchestrator's own instructions.

Clients that do not show server instructions gain only the corrected model guidance. Their
descriptions point to instructions they never display, so the orchestrator there behaves as it does
today: a write sent to a `read-only` registration is refused before Codex starts. No client is worse
off than before.

The instructions cost context in every session that loads the server, once per registration, which
is why they state only what distinguishes an instance. The stated default model may be one the
catalog no longer offers; the wording says configured, and the refusal at call time remains the
authority.

The guidance to the orchestrator remains guidance. Nothing here enforces anything: the ceilings, the
allow-list and the per-call checks are still the only controls, and a description or instruction
that a model ignores costs a refused call, not a wrong delegation.

Tests assert what the server states rather than the absence of a word, since two configurations can
share values and every `tools/list` lists all three sandbox modes in its schema.
