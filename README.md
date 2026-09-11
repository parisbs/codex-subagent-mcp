# codex-subagent-mcp

A local [MCP](https://modelcontextprotocol.io) server that lets Claude Code delegate tasks to the
OpenAI Codex CLI running on the same machine.

Claude Code stays the orchestrator. Codex becomes a callable subagent whose **model** and
**reasoning effort** you choose per task, so cheap work goes to a fast model and hard work goes to a
capable one thinking for longer — without leaving the terminal or sending anything to a third-party
service beyond the Codex CLI you already use.

## Requirements

- Node.js 20 or newer.
- The [Codex CLI](https://developers.openai.com/codex/cli) installed, on `PATH`, and signed in.

Set `CODEX_BIN` if the executable is not called `codex` or is not on `PATH`.

The server checks all of this for you: run the `codex_doctor` tool, or ask Claude to. Every other
tool runs the same check first and fails with the exact steps for your platform, so you never get a
bare `spawn ENOENT`. Nothing is ever installed on your behalf — the steps are yours to run.

If you do not have the Codex CLI yet:

```bash
# macOS — recommended
brew install --cask codex

# macOS / Linux — standalone installer
curl -fsSL https://chatgpt.com/codex/install.sh | sh

# any platform, with npm — see the caveats below
npm install -g @openai/codex
```

On Windows, use the installer rather than npm:
`powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`. A global
npm install puts a `codex.cmd` batch shim on PATH, which cannot be launched without a command shell —
and this server never uses one. `codex_doctor` detects that case and says so, but the installer
avoids it entirely.

Then run `codex` once to sign in, and confirm with `codex login status`.

### Why not npm

The npm package is not the program. `bin/codex.js` is a Node wrapper that spawns the real Rust
binary, which has two consequences:

1. **Every invocation pays a Node startup.** Measured on macOS: about 80 ms through the wrapper
   against about 20 ms calling the binary directly. This server spawns the CLI once per tool call,
   so that cost recurs — though it is still noise next to a delegation that runs for seconds.
2. **A global npm install lives inside the active Node version.** Under a version manager such as
   nvm it lands in `~/.nvm/versions/node/<version>/lib/node_modules`, so switching Node versions
   takes `codex` off `PATH` until you reinstall it. This is the bigger problem in practice.

Homebrew and the standalone installer both drop a self-contained binary in a stable location and
remove the Node dependency entirely. The Homebrew cask resolves the right architecture on both
Apple Silicon and Intel.

If you already installed through npm and want to switch:

```bash
npm uninstall -g @openai/codex
brew install --cask codex
```

Your sign-in survives: credentials live in `~/.codex/auth.json`, which is independent of how the CLI
was installed. Confirm afterwards with `codex login status`, or by running the `codex_doctor` tool.

## Install

```bash
npm ci
npm run build
```

## Register it with Claude Code

The repository ships a `.mcp.json`, so cloning it and running Claude Code from the project root is
enough. To use the server from anywhere, add it to your user configuration instead:

```bash
claude mcp add codex-subagent --scope user -- node /absolute/path/to/codex-subagent-mcp/build/index.js
```

## Tools

**`codex_doctor`** — checks whether the Codex CLI is installed, recent enough and signed in, and
reports the exact steps to fix it if not. Inspects only; installs nothing.

**`list_codex_models`** — the models available on this machine, with the reasoning-effort levels
each one supports. Read live from the Codex CLI, never hardcoded.

**`codex_recommend`** — given a task description, suggests a model and reasoning effort. Runs no
model call. Accepts a `priority` of `quality`, `balanced`, `latency` or `cost` to bias the effort.

**`codex_delegate`** — runs the task. Key parameters:

| Parameter | Default | Notes |
| --- | --- | --- |
| `prompt` | required | Self-contained: Codex cannot see the orchestrator's conversation. |
| `model` | recommended | A slug from `list_codex_models`. |
| `reasoning_effort` | model default | Clamped to what the model supports, with a note. |
| `working_dir` | CLI default | Must be absolute; validated before any model call. |
| `sandbox` | `read-only` | `workspace-write` to let Codex edit files. |
| `auto_approve` | `false` | Codex auto-approves its own commands. Implies `workspace-write`. |
| `use_worktree` | `false` | Writes land in a managed git worktree, never your working tree. |
| `timeout_seconds` | `1800` | The run is terminated past this budget. |
| `mode` | `blocking` | `background` returns a `job_id` immediately. |

`context`, `target_files`, `acceptance_criteria` and `system_instructions` are layered into the
prompt as delimited sections.

**`codex_follow_up`** — continues a delegation using the `thread_id` it reported, reusing the
context already cached in Codex. Pass the same `model` the original run used; otherwise Codex
resumes with your configured default and says so.

**`codex_job_status`**, **`codex_job_result`**, **`codex_job_cancel`** — manage background
delegations.

## Models

Read from the installed CLI at runtime. As of Codex CLI 0.154.0:

| Slug | Positioning | Reasoning efforts | Default |
| --- | --- | --- | --- |
| `gpt-6-astra` | Most capable, for complex demanding work | low … ultra | low |
| `gpt-5.6-sol` | Reliable agentic workhorse | low … ultra | low |
| `gpt-5.6-terra` | Balanced everyday coding | low … ultra | medium |
| `gpt-5.6-luna` | Fast and affordable | low … max | medium |
| `gpt-5.5` | Previous generation | low … xhigh | medium |

Model and reasoning effort are **independent** axes. The model sets raw capability; the effort
(`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`) sets how long it deliberates
before acting. `ultra` additionally delegates subtasks automatically.

The recommendation matrix in `src/recommend.ts` maps task shapes onto pairings: mechanical edits to
Luna at `low`, everyday work to Terra at `medium`, multi-file migrations to Sol at `high`, and hard
reasoning problems to Astra at `xhigh` or `ultra`.

## Safety

Delegations run **read-only by default**: Codex investigates and reports, but cannot modify files.
Writing requires an explicit `sandbox: "workspace-write"`.

The CLI is invoked with an argv array and `shell: false`, and the prompt is written to the child's
stdin — it is never interpolated into a command string, so prompt content cannot reach a shell.

Every delegation is prefixed with a quality contract (`src/prompt.ts`) that holds Codex to the same
standards as the orchestrator: stay in scope, verify before asserting, report failures faithfully,
and perform no git writes or destructive commands unless the task asks for them.

## Development

```bash
npm test           # unit tests
npm run typecheck
```

See `CLAUDE.md` for the hard rules, `docs/adr/` for the design decisions and `docs/ROADMAP.md` for
what is planned.

## License

MIT.
