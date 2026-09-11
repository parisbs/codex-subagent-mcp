import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveCodexExecutable } from "../src/codex/resolve.ts";

test("hands a bare name to spawn unchanged on POSIX", () => {
  // spawn already searches PATH there; second-guessing it only adds ways to be wrong.
  const resolved = resolveCodexExecutable("codex", "darwin");
  assert.equal(resolved.kind, "executable");
  assert.equal(resolved.path, "codex");
});

test("reports a non-existent explicit path as not found on POSIX", () => {
  const resolved = resolveCodexExecutable("/nonexistent/codex", "linux");
  assert.equal(resolved.kind, "not-found");
  assert.equal(resolved.path, null);
});

test("accepts an existing executable given by path on POSIX", () => {
  // /bin/sh exists and is executable on every POSIX system this runs on.
  const resolved = resolveCodexExecutable("/bin/sh", "linux");
  assert.equal(resolved.kind, "executable");
  assert.equal(resolved.path, "/bin/sh");
});

test("reports not-found when nothing matches on Windows", () => {
  const previous = process.env.PATH;
  process.env.PATH = "";
  try {
    const resolved = resolveCodexExecutable("codex", "win32");
    assert.equal(resolved.kind, "not-found");
  } finally {
    process.env.PATH = previous;
  }
});
