import assert from "node:assert/strict";
import { test } from "node:test";

import { describeFailure, describeSandboxBreach, schemaRejectionHint } from "../src/outcome.ts";
import type { AppliedSettings, DelegationResult } from "../src/types.ts";

/** Everything Codex recorded matching what was requested: the ordinary case. */
function applied(overrides: Partial<AppliedSettings> = {}): AppliedSettings {
  const confirmed = (value: string) => ({ requested: value, applied: value, state: "confirmed" as const });
  return {
    source: "rollout",
    reason: null,
    model: confirmed("m"),
    reasoningEffort: confirmed("low"),
    sandbox: confirmed("read-only"),
    workingDir: confirmed("/repo"),
    approvalPolicy: "never",
    ...overrides,
  };
}

function result(overrides: Partial<DelegationResult>): DelegationResult {
  return {
    finalMessage: "Done.",
    threadId: "t",
    model: "m",
    reasoningEffort: "low",
    sandbox: "read-only",
    workingDir: "/repo",
    applied: applied(),
    commandCount: 0,
    commands: [],
    fileChanges: [],
    agentMessages: ["Done."],
    errors: [],
    warnings: [],
    turnFailure: null,
    turnUsage: null,
    threadUsage: null,
    durationMs: 1,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    structured: null,
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

test("fails a failed turn even when the process exited zero and something was said", () => {
  const failure = describeFailure(result({ turnFailure: "stream disconnected" }));
  assert.match(failure ?? "", /turn as failed: stream disconnected/);
});

test("names the turn failure rather than only the exit code", () => {
  // A usage limit exits 1; the exit code alone said nothing about why.
  const failure = describeFailure(result({ exitCode: 1, turnFailure: "You've hit your usage limit." }));
  assert.match(failure ?? "", /exit code 1.*usage limit/);
});

test("fails a clean exit that produced no answer at all", () => {
  assert.match(describeFailure(result({ finalMessage: "", agentMessages: [] })) ?? "", /without producing an answer/);
});

test("does not fail an answered run that only carried notices", () => {
  assert.equal(describeFailure(result({ warnings: ["Ignored unsupported project-local config keys in x: notify."] })), null);
});

test("fails a run Codex recorded under a wider sandbox than requested", () => {
  const failure = describeFailure(
    result({
      applied: applied({
        sandbox: { requested: "read-only", applied: "workspace-write", state: "differs" },
      }),
    }),
  );
  assert.match(failure ?? "", /more permissive sandbox/);
  // The run is over by the time this is read, and the wording has to say so.
  assert.match(failure ?? "", /already over/);
});

test("does not fail a run Codex recorded under a narrower sandbox than requested", () => {
  assert.equal(
    describeFailure(
      result({
        applied: applied({
          sandbox: { requested: "workspace-write", applied: "read-only", state: "differs" },
        }),
      }),
    ),
    null,
  );
});

test("does not rank a sandbox value it does not recognise", () => {
  // An unknown name carries no ordering. It is reported as unconfirmed, not as
  // a breach, so a CLI rename cannot fail every delegation at once.
  assert.equal(
    describeSandboxBreach(
      result({
        applied: applied({
          sandbox: { requested: "read-only", applied: "container-write", state: "differs" },
        }),
      }),
    ),
    null,
  );
});

test("does not treat a different model or effort as a failure", () => {
  assert.equal(
    describeFailure(
      result({
        applied: applied({
          model: { requested: "m", applied: "other", state: "differs" },
          reasoningEffort: { requested: "high", applied: "low", state: "differs" },
        }),
      }),
    ),
    null,
  );
});

// #28: a schema turn's structured result, on top of the existing failure rules.

const SCHEMA_REJECTION =
  '{\n  "type": "error",\n  "error": {\n    "type": "invalid_request_error",\n    "code": "invalid_json_schema",\n    "message": "Invalid schema for response_format \'codex_output_schema\': In context=(), \'additionalProperties\' is required to be supplied and to be false.",\n    "param": "text.format.schema"\n  },\n  "status": 400\n}';

test("AC-2 does not fail an otherwise successful run whose final message is valid JSON", () => {
  assert.equal(describeFailure(result({ finalMessage: '{"a":1}', structured: { ok: true, json: '{"a":1}' } })), null);
});

test("AC-3 fails an otherwise successful schema turn whose final message is not JSON", () => {
  const failure = describeFailure(result({ finalMessage: "Done.", structured: { ok: false, error: "not JSON" } }));
  assert.match(failure ?? "", /structured result/i);
});

test("AC-4 keeps the original failure when a schema turn also failed otherwise", () => {
  const structured = { ok: true as const, json: '{"a":1}' };
  assert.match(describeFailure(result({ timedOut: true, exitCode: null, structured })) ?? "", /timeout/);
  assert.match(describeFailure(result({ cancelled: true, exitCode: null, structured })) ?? "", /cancelled/);
  assert.match(describeFailure(result({ exitCode: 1, structured })) ?? "", /exited with code 1/);
});

test("AC-6 hints at the strict-mode rules when OpenAI rejected a turn's schema", () => {
  const hint = schemaRejectionHint(
    result({ exitCode: 1, turnFailure: SCHEMA_REJECTION, structured: { ok: false, error: "no answer" } }),
  );
  assert.match(hint ?? "", /additionalProperties/);
  assert.match(hint ?? "", /required/);
});

test("AC-6 gives no hint for a run without a schema or for another failure", () => {
  assert.equal(schemaRejectionHint(result({ exitCode: 1, turnFailure: SCHEMA_REJECTION, structured: null })), null);
  assert.equal(
    schemaRejectionHint(result({ exitCode: 1, turnFailure: "usage limit reached", structured: { ok: false, error: "x" } })),
    null,
  );
  assert.equal(schemaRejectionHint(result({ structured: { ok: true, json: "{}" } })), null);
});
