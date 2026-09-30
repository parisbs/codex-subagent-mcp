# How it compares

This comparison records checks made on **2026-09-30**, by reading the published package tarballs
and running them against **Codex CLI 0.159.2**. Each section names the version checked. Facts about
other projects apply to those versions and may have changed since.

The differences concern sandbox policy, model discovery, configuration, result formatting and CLI
compatibility. This server separates model and effort, sets a sandbox default and ceiling, and
reports what Codex actually applied. The alternatives below make different choices in these areas;
two entry points did not run with the CLI version checked.

## codex-subagent-mcp 0.4.0

- Runs the locally installed Codex CLI with `spawn` and `shell: false`, writing the prompt to stdin.
- Uses the model catalog read at runtime from `codex debug models`, without a hardcoded model list.
  Model and reasoning effort are separate parameters.
- Defaults to `read-only`, with a user-set default and a ceiling. The ceiling is `workspace-write`
  unless `CODEX_SUBAGENT_MAX_SANDBOX` is set; `danger-full-access` requires that explicit opt-in.
- Checks the model, effort, sandbox and directory Codex actually applied after each run, reporting
  `applied=confirmed`, `applied=differs` or `applied=unconfirmed`.
- Has a recursion guard that disables this server inside delegated runs.
- Offers optional `output_schema` through `codex exec --output-schema`. The API's structured outputs
  constrain the final message, which is returned verbatim in a delimited block.
- Stops the commands Codex started on cancellation, timeout and shutdown.
- Is listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.parisbs/codex-subagent-mcp)
  under `io.github.parisbs/codex-subagent-mcp`, installing the same npm package.

See the [tool reference](TOOLS.md) for parameter details.

## codex-delegate-mcp 2.3.0

- Declares `mcpName` as `io.github.andreilungeanu/codex-delegate-mcp`.
- Runs every mode with `--dangerously-bypass-approvals-and-sandbox`. Its mode with a name suggesting
  read-only access therefore does not run under a sandbox.
- Returns its typed result as JSON text.
- Has a hardcoded model list. On the verification date it did not include `gpt-6.1-sol`, which
  Codex CLI 0.159.2 lists.
- Starts Codex with `--ignore-user-config --strict-config --disable hooks`, so the user's Codex
  configuration does not apply.

## codex-mcp-server 1.4.10

- Passes `--full-auto`, which Codex CLI 0.159.2 no longer accepts. Delegations fail on that CLI
  version.
- Places the prompt on the command line (argv) rather than stdin.
- Uses `shell: true` on Windows.

## Codex's own MCP mode: Codex CLI 0.159.2

Codex CLI 0.159.2 rejects `codex mcp-server` as an unrecognized subcommand.
