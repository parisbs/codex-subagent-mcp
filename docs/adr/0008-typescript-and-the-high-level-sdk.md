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
`tsup`. Promote `zod` to a direct dependency rather than relying on it arriving transitively through
the SDK.

Keep `@types/node` pinned to the major matching the **oldest** supported Node, not the newest
available. Typing against a newer Node than `engines` declares lets the compiler accept APIs that do
not exist on the supported floor, which converts a build error into a runtime one for exactly the
users least able to diagnose it.

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

## Update, 2026-09-11

The original decision also pinned TypeScript to a 5.x release. That was a reaction to finding
`^7.0.2` in the prototype's `package.json` and assuming it was a typo; TypeScript 7 is real, and the
pin was conservatism without evidence.

A Dependabot bump back to 7.0.2 passes the full matrix — build, typecheck and the whole suite on
Node 20, 24 and 26 across Linux, Windows and macOS — so the project now tracks TypeScript 7. The
rest of this record stands.

The lesson worth keeping: the pin was applied because a version looked wrong, not because anything
was observed to fail. Verify before constraining, the same way the CLI's behaviour is verified rather
than assumed.

## Update, 2026-09-14

The supported Node floor is now 22. Node 20 reached end-of-life on 2026-04-30, and
`docs/VERSIONING.md` now defines the floor as the oldest line that has not.

That also resolves a contradiction in this record. The `@types/node` rule above was added in #15, but
the prototype had shipped `@types/node` 22 against an `engines` floor of 20 from its first commit, and
#15 wrote the rule without correcting the value. The code never used an API newer than Node 20 —
typecheck, build and the full suite pass against `@types/node` 20.19 — so the mismatch caused no
defect. With the floor at 22, the version in use and the rule finally agree.

