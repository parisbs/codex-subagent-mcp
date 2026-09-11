# 8. Build on TypeScript and the high-level MCP SDK

Status: Accepted

## Context

The prototype used the SDK's low-level `Server` class with hand-written JSON Schema literals and a
single `CallToolRequestSchema` handler that dispatched on tool name. Arguments arrived as
`Record<string, unknown>` and were coerced with `String(args.prompt || "")`, so every parameter was
validated by hand, inconsistently, or not at all.

The package also declared `typescript: ^7.0.2` and carried `tsup` as a dependency that no script
used, while `build` ran plain `tsc`.

## Decision

Use the SDK's high-level `McpServer` with `registerTool`, defining each tool's input as a Zod shape.
The SDK derives the advertised JSON Schema from it and validates arguments before the handler runs,
so handlers receive typed, validated input.

Compile with `tsc` under `strict` plus `noUncheckedIndexedAccess`, targeting NodeNext ESM. Remove
`tsup`. Pin TypeScript to a 5.x release. Promote `zod` to a direct dependency rather than relying on
it arriving transitively through the SDK.

Run unit tests with Node's built-in test runner, loaded through `tsx` so the `.js` specifiers that
NodeNext ESM requires resolve against the TypeScript sources.

## Consequences

Parameter validation is declarative and lives next to the description the model reads, so the schema
and the documentation cannot drift apart. Invalid arguments are rejected by the SDK with a useful
message instead of being coerced into something plausible.

`noUncheckedIndexedAccess` forced explicit handling of absent array elements throughout the catalog
and recommendation code — noisier, but it is exactly the class of bug that turns a missing model into
a crash.

One dependency and one build tool were removed. The toolchain is `tsc` and nothing else.

Node's type stripping alone cannot run the tests, because it does not rewrite `.js` specifiers to
`.ts`. `tsx` covers that. It is a dev dependency, not a runtime one, so the published artifact stays
plain compiled JavaScript.
