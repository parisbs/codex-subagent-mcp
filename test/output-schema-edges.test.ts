import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { JobRegistry } from "../src/jobs.ts";
import { describeFailure, schemaRejectionHint } from "../src/outcome.ts";
import { parseStructuredResult, writeSchemaFile } from "../src/codex/schema.ts";
import type { AppliedSettings, DelegationResult } from "../src/types.ts";

/**
 * Edge cases of output schemas (#28) found by an independent audit of the
 * implementation, after the acceptance tests were frozen.
 */

/** Everything Codex recorded matching what was requested: the ordinary case. */
function applied(): AppliedSettings {
  const confirmed = (value: string) => ({ requested: value, applied: value, state: "confirmed" as const });
  return {
    source: "rollout",
    reason: null,
    model: confirmed("m"),
    reasoningEffort: confirmed("low"),
    sandbox: confirmed("read-only"),
    workingDir: confirmed("/repo"),
    approvalPolicy: "never",
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
    inherited: null,
    stderr: "",
    ...overrides,
  };
}

test("a job cancelled after Codex finished reports its result as cancelled, not as a structured result", async () => {
  const registry = new JobRegistry();
  const controller = new AbortController();
  let finish: (value: DelegationResult) => void = () => {};
  const jobId = registry.start({
    model: null,
    reasoningEffort: null,
    controller,
    run: () => new Promise((resolve) => (finish = resolve)),
  });

  // The pipes have already closed, so the runner has nothing left to stop and
  // its result says the run was not cancelled; the job was, before it read it.
  registry.cancel(jobId);
  finish(result({ finalMessage: '{"n":7}', agentMessages: ['{"n":7}'], structured: { ok: true, json: '{"n":7}' } }));
  for (let i = 0; i < 20 && registry.snapshot(jobId).finishedAt === null; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(registry.snapshot(jobId).state, "cancelled");
  const delivered = registry.result(jobId);
  assert.equal(delivered.cancelled, true);
  assert.match(describeFailure({ ...delivered, structured: null }) ?? "", /cancelled/);
});

test("an in-band error on a schema turn with no answer reports that error, not only the missing result", () => {
  const failure = describeFailure(
    result({ finalMessage: "", agentMessages: [], errors: ["upstream disconnected"], structured: parseStructuredResult("", false) }),
  );
  assert.match(failure ?? "", /upstream disconnected/);
});

test("a schema file whose write and cleanup both fail reports the write failure and logs the cleanup", (t) => {
  const original = { writeFileSync: fs.writeFileSync, rmSync: fs.rmSync };
  // A private parent: the mocked removal fails, so the directory mkdtemp made
  // really stays behind, and it must not stay in the system's temporary directory.
  const parent = fs.mkdtempSync(join(tmpdir(), "schema-edges-"));
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logged.push(args.join(" ")));
  fs.writeFileSync = () => {
    throw new Error("disk full while writing");
  };
  fs.rmSync = () => {
    throw new Error("permission denied while removing");
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeSchemaFile("{}", parent), /disk full while writing/);
  } finally {
    fs.writeFileSync = original.writeFileSync;
    fs.rmSync = original.rmSync;
    syncBuiltinESMExports();
    fs.rmSync(parent, { recursive: true, force: true });
  }
  assert.ok(logged.some((line) => /could not remove/.test(line) && /permission denied/.test(line)), logged.join("\n"));
});

test("the schema-rejection hint needs the API's error code, not the words anywhere in a message", () => {
  const structured = { ok: false as const, error: "no answer" };
  assert.equal(
    schemaRejectionHint(
      result({ exitCode: 1, turnFailure: "Network failed while fetching documentation about invalid_json_schema", structured }),
    ),
    null,
  );
  assert.equal(schemaRejectionHint(result({ exitCode: 1, errors: ["see invalid_json_schema"], structured })), null);
  // The envelope as codex-cli 0.159.2 prints it, compact or indented.
  assert.notEqual(
    schemaRejectionHint(result({ exitCode: 1, turnFailure: '{"error":{"code":"invalid_json_schema"}}', structured })),
    null,
  );
});

test("a final message is JSON only if JSON.parse accepts it once JSON's own whitespace is removed", () => {
  assert.equal(parseStructuredResult("﻿{}", false).ok, false);
  assert.equal(parseStructuredResult(" {}", false).ok, false);
  assert.deepEqual(parseStructuredResult(' \t\r\n{"a":1}\r\n', false), { ok: true, json: '{"a":1}' });
});
