@AGENTS.md

## Claude Code

- `/smoke-test` runs the end-to-end verification against the real Codex CLI, on the cheapest model
  and effort because delegations spend real quota.
- `/verify-catalog` checks the model catalog code against the installed CLI after an OpenAI model
  release.
- `.mcp.json` registers this checkout's build as `codex-subagent`, so sessions in this repository
  exercise the code under development rather than a published version. Run `npm run build` after
  changing the server, and restart the session to load it.
