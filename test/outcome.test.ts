import assert from "node:assert/strict";
import { test } from "node:test";

import { describeFailure } from "../src/outcome.ts";
import type { DelegationResult } from "../src/types.ts";

function result(overrides: Partial<DelegationResult>): DelegationResult {
  return {
    finalMessage: "Done.",
    threadId: "t",
    model: "m",
    reasoningEffort: "low",
    sandbox: "read-only",
    commands: [],
    fileChanges: [],
    agentMessages: ["Done."],
    errors: [],
    usage: null,
    durationMs: 1,
    exitCode: 0,
    timedOut: false,
    stderr: "",
    ...overrides,
  };
}

test("treats a clean exit with an answer as success", () => {
  assert.equal(describeFailure(result({})), null);
});

test("fails a timed-out run even though the exit code is null", () => {
  assert.match(describeFailure(result({ timedOut: true, exitCode: null })) ?? "", /timeout/);
});

test("fails a timed-out run whose process had already exited zero", () => {
  // Since the timeout settles on its own deadline, exitCode can be 0 here.
  assert.match(describeFailure(result({ timedOut: true, exitCode: 0 })) ?? "", /timeout/);
});

test("fails a non-zero exit and carries stderr", () => {
  assert.match(describeFailure(result({ exitCode: 2, stderr: "auth required" })) ?? "", /code 2.*auth required/);
});

test("fails an in-band error that left no answer", () => {
  const failure = describeFailure(result({ finalMessage: "  ", errors: ["model overloaded"] }));
  assert.match(failure ?? "", /model overloaded/);
});

test("does not fail a run that reported an error and still answered", () => {
  assert.equal(describeFailure(result({ errors: ["Truncated Codex output: discarded 1 line."] })), null);
});
