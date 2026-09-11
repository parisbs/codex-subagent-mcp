# Architecture Decision Records

Each record captures one decision, the situation that forced it, and what it costs. Format follows
Michael Nygard's: Context, Decision, Consequences.

A record is not edited once accepted — it is superseded by a later one, which links back. That way
the reasoning behind a past choice stays readable even after the choice changes.

| # | Title | Status |
| --- | --- | --- |
| [0001](0001-use-the-local-codex-cli.md) | Use the local Codex CLI instead of the OpenAI API | Accepted |
| [0002](0002-model-and-effort-are-independent.md) | Treat model and reasoning effort as independent axes | Accepted |
| [0003](0003-read-the-catalog-from-the-cli.md) | Read the model catalog from the CLI at runtime | Accepted |
| [0004](0004-spawn-with-argv-and-stdin.md) | Invoke the CLI with argv and deliver the prompt on stdin | Accepted |
| [0005](0005-read-only-by-default.md) | Default to a read-only sandbox | Accepted |
| [0006](0006-two-execution-modes.md) | Offer blocking and background execution modes | Accepted |
| [0007](0007-inject-the-quality-contract.md) | Inject the quality contract into the prompt | Accepted |
| [0008](0008-typescript-and-the-high-level-sdk.md) | Build on TypeScript and the high-level MCP SDK | Accepted |
