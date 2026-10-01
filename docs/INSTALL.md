# Installation

## Requirements

- **Node.js 22 or newer.**
- **The [Codex CLI](https://developers.openai.com/codex/cli)**, installed, on `PATH`, and signed in.

You do not have to check this by hand. Run the `codex_doctor` tool — or just ask Claude to — and it
reports what is missing and the exact commands for your platform. Every tool that reaches the CLI
runs the same check first, so you never get a bare `spawn ENOENT`. Nothing is ever installed on your
behalf.

If you do not have the Codex CLI yet, install it without npm:

```bash
# macOS — recommended
brew install --cask codex
```

```bash
# macOS / Linux — standalone installer
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Then run `codex` once to sign in, and confirm with `codex login status`. On Windows, open a new
terminal first so the updated `PATH` is picked up.

Codex's sandbox depends on the platform, so two notes from OpenAI's documentation:

- **Linux and WSL2** — Codex sandboxes commands with `bubblewrap`. Install it with your package
  manager before the first delegation. Without it Codex falls back to a bundled helper that needs
  unprivileged user namespaces, which some distributions restrict. See
  [sandboxing](https://learn.chatgpt.com/docs/sandboxing).
- **Windows** — Codex runs natively, without WSL, and uses its own Windows sandbox. Windows 11 is
  recommended; Windows 10 version 1809 or newer is the practical minimum. See the
  [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) documentation.

## Why not install the Codex CLI with npm?

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
[ADR 11](adr/0011-resolve-the-executable-without-a-shell.md).

Switching is two commands, and your sign-in survives because credentials live in Codex's home
directory — `~/.codex`, or `%USERPROFILE%\.codex` on native Windows — not in the npm package:

```bash
# macOS
npm uninstall -g @openai/codex && brew install --cask codex
```

```bash
# Linux
npm uninstall -g @openai/codex && curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

```powershell
# Windows (PowerShell) — two lines, because Windows PowerShell rejects `&&`
npm uninstall -g @openai/codex
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

## Register the server

```bash
claude mcp add codex-subagent -- npx -y codex-subagent-mcp
```

That works in both the Claude Code CLI and the desktop app; they share the same configuration.

Clients that browse the
[official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.parisbs/codex-subagent-mcp)
list this server under `io.github.parisbs/codex-subagent-mcp`. That entry installs the same
`codex-subagent-mcp` npm package.

## Other ways to install

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

**Settings → Developer → Edit Config** opens the file and creates it if it does not exist. Its
documented locations are `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS
and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. The Linux desktop app is in beta, and
its documentation does not say where the file lives. If the server does not appear after a restart,
the MCP logs are in `~/Library/Logs/Claude` on macOS and `%APPDATA%\Claude\logs` on Windows. See
[Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

**From a clone**, for development:

```bash
git clone https://github.com/parisbs/codex-subagent-mcp.git
cd codex-subagent-mcp && npm ci && npm run build
```

The repository ships a `.mcp.json`, so running Claude Code from the project root picks the server
up.

Set `CODEX_BIN` if your Codex executable is not called `codex` or is not on `PATH`. On Windows,
point it at the real `codex.exe`: a `.cmd` or `.bat` shim is refused rather than run through a
shell.

## First steps

Ask Claude to check the installation:

> Check that the Codex subagent is set up correctly.

You should see `status: ok`, a version, and `signed in: yes`. Then see what you can delegate to:

> What Codex models are available, and what are they each good for?

Then try a real one; see [Safety](../README.md#safety) for the default permissions:

> Have Codex look at this repository and explain how the build is wired together.

For model selection and defaults, see [Choosing a model](../README.md#choosing-a-model).
