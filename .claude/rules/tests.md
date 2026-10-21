---
paths:
  - "test/**"
---

# Tests

- The unit suite runs offline and never invokes the Codex CLI. Behaviour that depends on it is
  tested through pure functions (`diagnose`, `buildCodexArgs`, `parseCatalog`) with fixtures
  captured from real CLI output, home paths and timezone replaced.
- For acceptance tests, declare new API with `throw new Error('not implemented')` bodies so tests
  fail by assertion, not by compilation.
- `test/delegation-cycle.test.ts` runs a whole delegation without Codex, credentials or quota. The
  stand-in in `test/fixtures/` exploits the argv always starting with `exec`: the runner is pointed
  at `process.execPath` with a temporary directory as the child's cwd, and a CommonJS file named
  `exec` there becomes Node's entry point, so the Codex flags land in `process.argv`. A shebang
  script does not run on Windows and `resolve.ts` rejects a `.cmd` shim by design, so do not
  "simplify" this with `shell: true` or a `.cmd`.
