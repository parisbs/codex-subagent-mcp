# codex-subagent-mcp

[![CI](https://github.com/parisbs/codex-subagent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/parisbs/codex-subagent-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/codex-subagent-mcp)](https://www.npmjs.com/package/codex-subagent-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An MCP server that lets **Claude Code delegate coding tasks to OpenAI's Codex CLI** running on the
same machine, with the model and reasoning depth chosen per task. Claude stays the orchestrator.
Codex becomes a subagent it can call.

An independent project. Not affiliated with, endorsed by, or supported by OpenAI or Anthropic.

## Quick start

Requires **Node.js 22+** and the **[Codex CLI](https://developers.openai.com/codex/cli)** installed,
on `PATH`, and signed in.

```bash
claude mcp add codex-subagent -- npx -y codex-subagent-mcp
```

Ask Claude to run `codex_doctor` if anything is missing. See **[docs/INSTALL.md](docs/INSTALL.md)**
for platform setup, Claude Desktop and other installation options, and [Safety](#safety) before
enabling writes.

## What you get

- You pick the model and the reasoning effort per task, from the catalog your Codex CLI reports
  live.
- Read-only by default, with a sandbox ceiling no tool call can exceed.
- Every result states what Codex actually applied (model, effort, sandbox, directory), not only what
  was asked.
- Optional `output_schema` returns JSON that matches your schema, for results Claude can act on
  directly.
- Cancelling, timing out or shutting down stops Codex and every command it started.

A real read-only delegation asking for the package name, captured 2026-09-30:

```text
codex-subagent-mcp
Commands run (1 total):
- [exit 0] /bin/zsh -lc "sed -n '1,80p' package.json"
model=gpt-5.6-luna | effort=low | sandbox=read-only | working_dir=/Users/you/project | applied=confirmed | duration=8s | tokens=in 35701 (cached 28160, uncached 7541) / out 88 (reasoning 9) | thread_id=01a0f419-9fd2-79e2-8248-91436f04e297
```

## Why this exists

A single model doing everything has three recurring problems, and delegation solves each one:

**Your context window is finite.** Having Claude read forty files to answer one question spends
context you need for the actual work. Delegating the investigation returns the answer instead of the
forty files.

**One model has one set of blind spots.** A second opinion is worth most when it comes from a
different model family — different training, different failure modes. Asking the same model twice
mostly gets you the same answer twice.

**Not every task deserves the same reasoning budget.** Renaming a variable and diagnosing a race
condition are not the same job. Here they are separate dials: the *model* sets raw capability, the
*reasoning effort* sets how long it deliberates. Cheap work goes to a fast model; a hard problem
gets the capable one thinking for as long as it needs.

The server runs on your machine and drives the Codex CLI you already have installed; it holds no
credentials of its own. Prompts reach OpenAI through Codex, exactly as when you run `codex`
yourself.

See [How it compares](docs/COMPARISON.md) for a versioned comparison with other Codex MCP servers.

## Using it

### Write a bounded delegation

A delegation gets expensive when repeated commands keep adding output to the context carried into
later requests. Name the exact question, likely files, stopping condition and evidence the answer
must contain; choose higher effort for ambiguity rather than by habit.
**[Writing a delegation](docs/DELEGATING.md)** gives the measured cost model, ranked rules and
weak-versus-strong examples using the real tool parameters. Background goes in `context` and a
persona or extra rules in `system_instructions`, both layered on the built-in quality contract; see
the [tool reference](docs/TOOLS.md#codex_delegate).

### Get a second opinion from a different model family

The value here is not a second run — it is a different set of blind spots.

> Ask Codex to review `src/server.ts` for correctness problems, focusing on error paths. Use a high
> reasoning effort and tell it to report each finding with the line and why it matters.

A delegated review like this found the `terminate()` defect in this repository's own runner: two
code paths could each arm a timer while only one was ever cleared.

### Investigate without spending your context

Forty files go into the delegation; one answer comes back. Codex runs its own searches and reads
whatever it needs; your conversation receives the conclusion.

> Have Codex trace how a reasoning effort travels from the MCP tool call down to the arguments
> handed to the Codex CLI, and report just the call chain.

### Run long work in the background while you keep going

> Kick off a Codex run in the background that writes unit tests for `src/jobs.ts`, then keep helping
> me with the API layer.

You get a `job_id` immediately. Ask for the status whenever you want, and read the result when it is
done. Up to eight can run at once.

### Buy deep reasoning for one hard problem

Raising the reasoning effort for the whole conversation is expensive. Raising it for one delegation
is not.

> This intermittent test failure has beaten me twice. Ask Codex to work out the root cause at
> maximum reasoning effort, give it `test/runner.test.ts` and the CI log, and tell it not to change
> anything — I want the diagnosis first.

### Keep the thread going

> Ask Codex to expand on its second finding.

Follow-ups reuse Codex's context, so they cost a fraction of the original. The server restates the
same model, effort and directory on every follow-up because Codex itself does not keep them on
resume.

### Let it write, when you mean it

> Have Codex apply its first two suggestions. Let it edit files, but keep it inside a git worktree
> so my working tree stays clean.

`use_worktree` sends the run's edits to `~/.codex/worktrees/`; results list the files it touched and
where each landed, up to a thousand distinct files, then report the omitted count. The server does
not clean worktrees up: they may hold unapplied work. The experimental feature is enabled only for
that invocation; your Codex configuration is unchanged. See [Safety](#safety) for the write
boundary.

Whatever the sandbox, a delegation that writes reports what it wrote:

```text
Files changed (2):
- [edit] src/codex/runner.ts
- [add] test/runner.test.ts
```

## Safety

This server runs another program on your machine, so it is worth two minutes before you enable
writes.

### What protects you

Delegations are **read-only by default**. Writing requires an explicit `sandbox: "workspace-write"`
or a user-set default. `use_worktree` sends edits to a managed git worktree instead of your
checkout; the sandbox and `add_dirs` bound where it can write at all. Unsandboxed runs are
unavailable unless you explicitly opt into that ceiling.

The confinement is the operating system's own sandbox: Seatbelt on macOS, `bubblewrap` on Linux and
WSL2, and a native sandbox on Windows. The table was measured on macOS;
[SECURITY.md](SECURITY.md#what-the-sandbox-does-and-does-not-cover) records the measurement details.
Linux and Windows have not been measured here, and OpenAI's Windows documentation notes that
sandboxed commands can fail to read some directories, so reads may be stricter there:

| | `read-only` | `workspace-write` | `danger-full-access` |
| --- | --- | --- | --- |
| Write inside the working directory | no | yes | yes |
| Write outside it (your home) | no | no | yes |
| Network access | no | no | yes |
| **Read outside the working directory** | **yes** | **yes** | yes |

There is no shell in the server's invocation path: the CLI is spawned with an argv array and the
prompt is written to its stdin, never interpolated into a command string. Shell metacharacters in a
prompt are inert.

### What does not protect you

**Reads are not confined.** Codex can read anything your user account can, in every mode — your SSH
keys, your cloud credentials. That was measured on macOS, and it is the safe assumption on every
platform. Sandboxed network access is blocked so it cannot send them anywhere, but its report comes
back to you, and that is a channel.

**A prompt is untrusted input, and Codex acts on it.** Content you did not write — an issue body, a
web page, a log, a file from someone else's repository — can carry instructions. With
`workspace-write` it can direct Codex to modify your repository; even read-only it can direct Codex
to read something sensitive and put it in the answer. The sandbox bounds *where* Codex can write. It
does not judge *what* it should write, or why it was asked. This is prompt injection, and it is the
risk that matters here.

**The result is not sanitised.** What comes back is text from a model that just read your files.
Treat it as data, not as instructions; review what a delegation did rather than assuming it did what
you asked.

### Reducing the risk

- Leave the built-in default alone. Read-only handles investigation, review and diagnosis, which is
  most delegation.
- If you never want writes, cap it: `CODEX_SUBAGENT_MAX_SANDBOX=read-only`. No conversation can
  argue past a ceiling. Register it outside the repository (Claude Code's default `local` scope,
  `--scope user`, or Claude Desktop's config), not in a project `.mcp.json` that a write-enabled
  delegation could edit. See [Configuration](docs/TOOLS.md#configuration).
- When you enable writes, add `use_worktree` so changes land somewhere you can inspect before they
  touch your branch.
- Do not assemble delegation prompts from untrusted content when you intend to act on the answer.
- If this threat matters seriously to you, run Codex under an account or container with no access to
  your secrets. That solves it at the root instead of bounding it.

[SECURITY.md](SECURITY.md) has the full threat model, what a `deny_read` policy could add, and how
to report a vulnerability.

## Configuration

Everything is optional, and set through environment variables on the MCP server:

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `CODEX_SUBAGENT_DEFAULT_MODEL` | Slug from `list_codex_models` | Unset: refused with a suggestion | Model when a call specifies none. |
| `CODEX_SUBAGENT_DEFAULT_EFFORT` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | Model's default | Effort when a call specifies none. |
| `CODEX_SUBAGENT_ALLOWED_MODELS` | Comma-separated slugs from `list_codex_models` | Unrestricted | Anything else is refused; a single entry acts as the default model. |
| `CODEX_SUBAGENT_DEFAULT_SANDBOX` | `read-only`, `workspace-write`, `danger-full-access` | `read-only` | Sandbox when a call specifies none; cannot exceed the ceiling. |
| `CODEX_SUBAGENT_MAX_SANDBOX` | `read-only`, `workspace-write`, `danger-full-access` | `workspace-write` | Calls above it are refused; `danger-full-access` needs explicit opt-in. |
| `CODEX_SUBAGENT_MAX_EFFORT` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | Unrestricted | Higher effort is lowered to a supported level, or refused if none fits. |
| `CODEX_BIN` | Executable path | `codex` on `PATH` | Override CLI resolution; see [Installation](docs/INSTALL.md). |

A model supports a subset of efforts; an unsupported effort is adjusted to the closest supported one
with a note. See **[docs/TOOLS.md#configuration](docs/TOOLS.md#configuration)** for full semantics
and [Safety](#safety) for the sandbox boundary.

Claude decides when to delegate; each run sends its prompt to OpenAI and spends your Codex usage, in
any conversation where the server is available. **[docs/CONTROL.md](docs/CONTROL.md)** covers client
permission prompts, server ceilings, version ranges and your own `CLAUDE.md` escalation rules. Those
rules stay yours; see [ADR 12](docs/adr/0012-mechanism-not-policy.md) and
[ADR 14](docs/adr/0014-user-controlled-sandbox-defaults.md) for the policy split.

## Choosing a model

Use `list_codex_models` for the live catalog from your installed CLI. Model and reasoning effort are
**independent**: the model sets raw capability; the effort sets how long it deliberates. `ultra`
additionally delegates subtasks automatically.

**The server does not choose for you.** A task's model depends on your budget and how costly a wrong
answer is. Without a model in the call or configuration, it refuses with a recommendation for you to
decide on.

With no default, tool descriptions tell Claude to call `codex_recommend` first, announce the
suggested model and effort, then delegate with both explicit. This is guidance to a model, not
enforcement. For advice, ask: “Which Codex model should handle migrating this repo's tests to
vitest?” The suggestion respects your model allow-list and effort ceiling; see
[the recommendation reference](docs/TOOLS.md#codex_recommend).

To skip that step on later delegations, set a default from `list_codex_models` once:

```bash
claude mcp add codex-subagent -e CODEX_SUBAGENT_DEFAULT_MODEL=gpt-5.6-terra -- npx -y codex-subagent-mcp
```

## Tools

| Tool | What it does |
| --- | --- |
| `codex_doctor` | Check the Codex CLI installation and report how to fix it. |
| `list_codex_models` | List available models and their reasoning-effort levels. |
| `codex_recommend` | Suggest a model and effort for a described task. |
| `codex_delegate` | Run a task, blocking or in the background, optionally returning JSON that matches a schema. |
| `codex_follow_up` | Continue a previous delegation using its `thread_id`, with or without a schema. |
| `codex_job_status` | Check a background delegation. |
| `codex_job_result` | Read a finished background delegation's output. |
| `codex_job_cancel` | Stop a running background delegation. |

Full parameter reference: **[docs/TOOLS.md](docs/TOOLS.md)**.

## FAQ

**Does this cost money?**
It uses your existing Codex quota, as running `codex` yourself does. This server adds nothing and
has no visibility into the cost. Higher efforts consume more, and `ultra` also delegates subtasks;
`codex_recommend` helps avoid spending `ultra` on `low` work.

**Why drive the CLI instead of calling the OpenAI API?**
Delegated coding is not a single completion — it is an agentic loop with a sandbox, an approval
model, session persistence and project instruction files. All of that lives in the Codex client, not
in the model endpoint. See [ADR 1](docs/adr/0001-use-the-local-codex-cli.md).

**Do I need Claude Code, or does Claude Desktop work?**
Either. Claude Code gets a one-line install; Claude Desktop needs a manual config entry.

**It says Codex is not installed, but `codex` works in my terminal.**
Most likely Windows with a global npm install, which produces a `codex.cmd` batch shim that cannot
be launched without a command shell. `codex_doctor` reports this as `unsupported-shim` and offers
two fixes. On macOS and Linux, check whether a Node version manager moved `codex` off `PATH`.

**Does it work on Windows and Linux?**
CI builds, tests and starts the server on Windows, macOS and Linux on every change, and checks that
the Codex CLI is resolved correctly on each. A real delegation has only been verified on macOS — the
CI runners have no Codex installation or credentials. Reports from Windows and Linux are welcome.
On Windows, install the Codex CLI with the PowerShell installer rather than npm; on Linux, install
`bubblewrap` for Codex's sandbox. See [Installation](docs/INSTALL.md#requirements).

## Documentation

- **[docs/INSTALL.md](docs/INSTALL.md)** — installation, platform notes and troubleshooting.
- **[docs/CONTROL.md](docs/CONTROL.md)** — permissions, ceilings and when Claude delegates.
- **[docs/DELEGATING.md](docs/DELEGATING.md)** — how to scope a delegation, with measured costs and
  worked prompts.
- **[docs/TOOLS.md](docs/TOOLS.md)** — every tool and parameter.
- **[docs/COMPARISON.md](docs/COMPARISON.md)** — versioned comparisons with other Codex MCP servers.
- **[docs/adr/](docs/adr/)** — why the design is what it is, decision by decision.
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — what is planned, and what is deliberately out of scope.
- **[Issues](https://github.com/parisbs/codex-subagent-mcp/issues)** — what is actually open right
  now.
- **[docs/VERSIONING.md](docs/VERSIONING.md)** — what counts as a breaking change here.
- **[CHANGELOG.md](CHANGELOG.md)** — what changed in each release, and the Codex CLI version it
  was verified against.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — setup, and the rules that are not negotiable.

## Disclaimer

**Not an official product.** This is an independent, community project. It is not affiliated with,
endorsed by, sponsored by or supported by OpenAI or Anthropic. "Codex", "ChatGPT" and "OpenAI" are
trademarks of OpenAI; "Claude" and "Claude Code" are trademarks of Anthropic. They are used here
only to describe what this software interoperates with, which is nominative use — no claim is made
to any of them. Neither company is responsible for this software, and problems with it should be
reported here rather than to them.

**No warranty.** The software is provided "as is", without warranty of any kind, as stated in
[LICENSE](LICENSE). You use it at your own risk.

Read [Safety](#safety) before enabling writes; delegations spend your own Codex usage.

## License

MIT. See [LICENSE](LICENSE).
