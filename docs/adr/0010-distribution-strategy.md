# 10. Distribute through npm, with the registry and bundles layered on top

Status: Accepted

## Context

There are four ways to get an MCP server onto someone else's machine, and they are frequently
presented as alternatives when they are actually layers:

1. **npm** hosts the artifact. Consumers run it with `npx` or install it globally.
2. **The official MCP Registry** hosts *metadata only*, not artifacts. Publishing there requires the
   package to already exist on npm, plus an `mcpName` field in `package.json` matching the server
   name in `server.json`. Namespace ownership is proven by the publishing identity: `io.github.<user>`
   is claimable only by that GitHub account. It is free and currently in preview.
3. **MCP Bundles** (`.mcpb`, formerly `.dxt`) are zip archives with a `manifest.json`, for one-click
   installation in desktop apps.
4. **Claude Code plugins** are versioned bundles of an MCP server together with its slash commands
   and skills, distributed through a marketplace.

This server has a constraint that the usual advice does not account for: it depends on an external
binary, the Codex CLI, that it does not ship and cannot install. Neither the registry nor the bundle
format can express "requires this other program"; the registry's metadata only describes environment
variables.

## Decision

Publish to npm as the single source of the artifact. Support installation with no prior install:

```bash
claude mcp add codex-subagent -- npx -y codex-subagent-mcp
```

Layer the MCP Registry on top once npm publication is in place, using GitHub-based namespace
authentication (`io.github.parisbs/...`).

Do not ship an `.mcpb` bundle. A one-click desktop install implies a self-contained server, and this
one is not: the click would succeed and every subsequent tool call would fail on a missing Codex
CLI.

Treat a Claude Code plugin as the interesting option beyond npm, because a plugin carries the slash
commands (`/verify-catalog`, `/smoke-test`) alongside the server, and those are a real part of how
this project is used.

Because no packaging format can declare the Codex dependency, the preflight in
[ADR 9](0009-preflight-the-codex-cli.md) is the only place it can be communicated. Publication is
gated on it.

## Consequences

`npx` gives the shortest path from "I read about this" to a working server, with no global install
and no version pinning to maintain.

The npm package ships compiled JavaScript only — `build/`, `package.json`, `README.md` and
`LICENSE`. Sources and tests stay out of every consumer's `node_modules`. CI asserts both halves of
this, since publishing sources without build output is the classic way to ship a broken package.

Publishing to npm distributes the code regardless of the repository's visibility. A public package
backed by a private repository leaves users unable to read the design notes, file an issue, or send
a fix — so the repository's visibility should be settled before the first publish, not after.

Declining to ship a bundle means desktop users must configure the server manually. That is the
honest trade: a one-click install that cannot work is worse than no one-click install.
