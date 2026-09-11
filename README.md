# codex-subagent-mcp

[![CI](https://github.com/parisbs/codex-subagent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/parisbs/codex-subagent-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An MCP server that lets **Claude Code delegate coding tasks to OpenAI's Codex CLI** running on the
same machine — multi-model orchestration, locally, with the model and reasoning depth chosen per
task.

Claude stays the orchestrator. Codex becomes a subagent it can call.

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

Everything stays on your machine. The server drives the Codex CLI you already have installed and
holds no credentials of its own.

## Requirements

- **Node.js 20 or newer.**
- **The [Codex CLI](https://developers.openai.com/codex/cli)**, installed, on `PATH`, and signed in.

You do not have to check this by hand. Run the `codex_doctor` tool — or just ask Claude to — and it
reports what is missing and the exact commands for your platform. Every other tool runs the same
check first, so you never get a bare `spawn ENOENT`. Nothing is ever installed on your behalf.

If you do not have the Codex CLI yet:

```bash
# macOS — recommended
brew install --cask codex
```

```bash
# macOS / Linux — standalone installer
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

On Windows, use the installer rather than npm:
`powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`.

Then run `codex` once to sign in, and confirm with `codex login status`.

<details>
<summary>Why not install the Codex CLI with npm?</summary>

The npm package is not the program: `bin/codex.js` is a Node wrapper that spawns the real Rust
binary. That has two consequences.

**Every invocation pays a Node startup.** Measured on macOS: about 80 ms through the wrapper against
about 20 ms calling the binary directly. This server spawns the CLI once per tool call, so the cost
recurs — though it is still noise next to a delegation that runs for seconds.

**A global npm install lives inside the active Node version.** Under a version manager such as nvm
it lands in `~/.nvm/versions/node/<version>/lib/node_modules`, so switching Node versions takes
`codex` off `PATH` until you reinstall it. This is the bigger problem in practice.

On Windows there is a third, harder consequence: a global npm install produces a `codex.cmd` batch
shim, which cannot be launched without a command shell — and this server never uses one. It detects
that case and says so, but the installer avoids it entirely. See
[ADR 11](docs/adr/0011-resolve-the-executable-without-a-shell.md).

Switching is two commands, and your sign-in survives because credentials live in `~/.codex`:

```bash
npm uninstall -g @openai/codex && brew install --cask codex
```

</details>

## Install

```bash
claude mcp add codex-subagent -- npx -y codex-subagent-mcp
```

That works in both the Claude Code CLI and the desktop app; they share the same configuration.

<details>
<summary>Other ways to install</summary>

**Global install**, if you prefer not to go through `npx`:

```bash
npm install -g codex-subagent-mcp
```

Then point Claude Code at the `codex-subagent` binary.

**Claude Desktop** has no equivalent command. Add an entry to `mcpServers` in
`claude_desktop_config.json` and restart the app:

```json
{
  "mcpServers": {
    "codex-subagent": {
      "command": "npx",
      "args": ["-y", "codex-subagent-mcp"]
    }
  }
}
```

**From a clone**, for development:

```bash
git clone https://github.com/parisbs/codex-subagent-mcp.git
cd codex-subagent-mcp && npm ci && npm run build
```

The repository ships a `.mcp.json`, so running Claude Code from the project root picks the server up.

Set `CODEX_BIN` if your Codex executable is not called `codex` or is not on `PATH`.

</details>

## First steps

Ask Claude to check the installation:

> Check that the Codex subagent is set up correctly.

You should see `status: ok`, a version, and `signed in: yes`. Then see what you can delegate to:

> What Codex models are available, and what are they each good for?

Then try a real one. This is read-only, so Codex investigates and reports without touching anything:

> Have Codex look at this repository and explain how the build is wired together.

## Using it

Delegations run **read-only by default**: Codex investigates and reports, but cannot modify files.
Letting it write is a deliberate, separate request.

The examples below are the four situations where delegating beats doing it in the main conversation.
Each one has been run against the real Codex CLI — writing them is how two defects in this server
were found and fixed.

### Get a second opinion from a different model family

The value here is not a second run — it is a different set of blind spots.

> Ask Codex to review `src/server.ts` for correctness problems, focusing on error paths. Use a high
> reasoning effort and tell it to report each finding with the line and why it matters.

Claude picks the model, passes your file as the focus, and returns the findings. This is how the
`terminate()` defect in this repository's own runner was found: a delegated review spotted that two
code paths could each arm a timer while only one was ever cleared.

### Investigate without spending your context

Forty files go into the delegation; one answer comes back.

> Have Codex trace how a reasoning effort travels from the MCP tool call down to the arguments
> handed to the Codex CLI, and report just the call chain.

Codex runs its own searches and reads whatever it needs. Your conversation receives the conclusion,
not the search results.

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

Follow-ups reuse the context Codex already has, so they cost a fraction of the original:

> Ask Codex to expand on its second finding.

### Let it write, when you mean it

> Have Codex apply its first two suggestions. Let it edit files, but keep it inside a git worktree
> so my working tree stays clean.

That last clause matters: `use_worktree` confines every change to a managed git worktree under
`~/.codex/worktrees/` instead of your checkout, and the result lists every file it touched with the
path where it landed. Worktrees rely on an experimental Codex feature, which the server turns on for
that invocation only — it never changes your Codex configuration.

Whatever the sandbox, a delegation that writes reports what it wrote:

```
Files changed (2):
- [edit] src/codex/runner.ts
- [add] test/runner.test.ts
```

## Choosing a model

Read live from your installed CLI, so this list tracks whatever you have. As of Codex CLI 0.154.0:

| Slug | Positioning | Reasoning efforts | Default |
| --- | --- | --- | --- |
| `gpt-6-astra` | Most capable, for complex demanding work | low … ultra | low |
| `gpt-5.6-sol` | Reliable agentic workhorse | low … ultra | low |
| `gpt-5.6-terra` | Balanced everyday coding | low … ultra | medium |
| `gpt-5.6-luna` | Fast and affordable | low … max | medium |
| `gpt-5.5` | Previous generation | low … xhigh | medium |

Model and reasoning effort are **independent**. The model sets raw capability; the effort — `low`,
`medium`, `high`, `xhigh`, `max`, `ultra` — sets how long it deliberates before acting. `ultra`
additionally delegates subtasks automatically.

You rarely need to pick by hand. Describe the task and let the server suggest a pairing:

> Which Codex model should handle migrating this repo's tests to vitest?

The built-in matrix routes mechanical edits to the fast model at `low`, everyday work to the
balanced one at `medium`, multi-file migrations to the agentic workhorse at `high`, and hard
reasoning problems to the most capable model at `xhigh` or `ultra`. An effort the chosen model does
not support is clamped down, with a note saying so.

## Tools

| Tool | What it does |
| --- | --- |
| `codex_doctor` | Check the Codex CLI installation and report how to fix it. |
| `list_codex_models` | List available models and their reasoning-effort levels. |
| `codex_recommend` | Suggest a model and effort for a described task. |
| `codex_delegate` | Run a task, blocking or in the background. |
| `codex_follow_up` | Continue a previous delegation using its `thread_id`. |
| `codex_job_status` | Check a background delegation. |
| `codex_job_result` | Read a finished background delegation's output. |
| `codex_job_cancel` | Stop a running background delegation. |

Full parameter reference: **[docs/TOOLS.md](docs/TOOLS.md)**.

## Safety

Delegations are **read-only by default**. Writing requires an explicit `sandbox: "workspace-write"`,
and `use_worktree` can confine those writes to a managed git worktree.

The CLI is invoked with an argv array and `shell: false`, and the prompt is written to the child's
stdin — never interpolated into a command string. Shell metacharacters in a prompt cannot reach a
shell, because there is no shell in the path.

Every delegation is prefixed with a quality contract holding Codex to the same standards as the
orchestrator: stay in scope, verify before asserting, report failures faithfully, and perform no git
writes or destructive commands unless the task asks for them.

Read [SECURITY.md](SECURITY.md) before enabling writes — particularly the section on what is *not*
defended against. A prompt is untrusted input, and Codex acts on it.

## FAQ

**Does this cost money?**
It uses your existing Codex quota, the same as running `codex` yourself. This server adds nothing.
Higher reasoning efforts consume more; `codex_recommend` exists partly so you do not spend `ultra`
on work that `low` would have handled.

**Can it modify my files?**
Not by default. Delegations run read-only unless you explicitly ask for write access, and
`use_worktree` keeps even those changes out of your working tree.

**Why drive the CLI instead of calling the OpenAI API?**
Delegated coding is not a single completion — it is an agentic loop with a sandbox, an approval
model, session persistence and project instruction files. All of that lives in the Codex client, not
in the model endpoint. See [ADR 1](docs/adr/0001-use-the-local-codex-cli.md).

**Do I need Claude Code, or does Claude Desktop work?**
Either. Claude Code gets a one-line install; Claude Desktop needs a manual config entry.

**It says Codex is not installed, but `codex` works in my terminal.**
Most likely Windows with a global npm install, which produces a `codex.cmd` batch shim that cannot
be launched without a command shell. `codex_doctor` reports this as `unsupported-shim` and offers two
fixes. On macOS and Linux, check whether a Node version manager moved `codex` off `PATH`.

**Does it work on Windows?**
CI builds, tests and starts the server on Windows, macOS and Linux on every change, and checks that
the Codex CLI is resolved correctly on each. A real delegation has only been verified on macOS — the
CI runners have no Codex installation or credentials. Reports from Windows and Linux are welcome.

**Where do worktree changes end up?**
Under `~/.codex/worktrees/`, and the delegation result gives you the full path of every file it
touched. The server does not clean those worktrees up: they may hold work you have not applied yet.

## Documentation

- **[docs/TOOLS.md](docs/TOOLS.md)** — every tool and parameter.
- **[docs/adr/](docs/adr/)** — why the design is what it is, decision by decision.
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — what is planned, and what is deliberately out of scope.
- **[docs/VERSIONING.md](docs/VERSIONING.md)** — what counts as a breaking change here.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — setup, and the rules that are not negotiable.

## License

MIT. See [LICENSE](LICENSE).
