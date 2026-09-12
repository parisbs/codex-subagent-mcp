import assert from "node:assert/strict";
import { test } from "node:test";

import { runCodex } from "../src/codex/runner.ts";
import { createFakeCodex, jsonl, type Scenario } from "./fixtures/fake-codex.ts";

/**
 * End-to-end coverage of a delegation on every platform CI runs.
 *
 * The existing termination tests in `runner.test.ts` are POSIX-only because
 * they depend on signals Windows does not have. Everything else about a run —
 * spawning, writing the prompt to stdin, streaming JSONL back, exit codes,
 * stderr — is platform-independent behaviour that was previously verified on
 * macOS alone. `docs/VERSIONING.md` names that gap as a blocker for 1.0.
 *
 * These tests use no Codex quota and need no credentials: the child is Node
 * running a stand-in. See `fixtures/fake-codex.ts` for why that is portable.
 */

async function runAgainst(
  scenario: Scenario,
  overrides: { invocation?: Partial<Parameters<typeof runCodex>[0]["invocation"]> } = {},
) {
  const fake = createFakeCodex(scenario);
  try {
    const { result } = runCodex({
      invocation: {
        kind: "exec",
        sandbox: "read-only",
        ...overrides.invocation,
        // The child's cwd is what makes the stand-in resolvable, so it is not
        // something a caller may override.
        workingDir: fake.workingDir,
      },
      prompt: "irrelevant",
      codexPath: fake.codexPath,
      timeoutSeconds: 60,
    });
    return { outcome: await result, received: fake.received() };
  } finally {
    fake.dispose();
  }
}

test("completes a delegation and reports every part of the run", async () => {
  const { outcome } = await runAgainst({
    chunks: [
      jsonl(
        { type: "thread.started", thread_id: "thread-abc" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "npm test",
            exit_code: 0,
            status: "completed",
            aggregated_output: "90 passing",
          },
        },
        { type: "item.completed", item: { type: "agent_message", text: "Done." } },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 1200,
            cached_input_tokens: 400,
            output_tokens: 300,
            reasoning_output_tokens: 900,
          },
        },
      ),
    ],
    exitCode: 0,
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.threadId, "thread-abc");
  assert.equal(outcome.finalMessage, "Done.");
  assert.equal(outcome.commands.length, 1);
  assert.equal(outcome.commands[0]?.command, "npm test");
  assert.equal(outcome.usage?.inputTokens, 1200);
  assert.ok(outcome.durationMs >= 0);
});

test("delivers the prompt through stdin byte for byte", async () => {
  // Shell metacharacters are the point: if any of this were ever interpolated
  // into a command line, this is the payload that would show it. It must arrive
  // as literal text instead. `test/args.test.ts` guards the argv; this guards
  // the whole path on the platform actually running.
  const prompt = [
    'double "quotes" and \'single\'',
    "backticks `whoami` and $(touch /tmp/canary)",
    "a trailing backslash \\",
    "unicode: acentuación, 日本語, 🙂",
    "%PATH% and %CD% for cmd.exe",
  ].join("\n");

  const fake = createFakeCodex({ chunks: [jsonl({ type: "thread.started", thread_id: "t" })] });
  try {
    const { result } = runCodex({
      invocation: { kind: "exec", sandbox: "read-only", workingDir: fake.workingDir },
      prompt,
      codexPath: fake.codexPath,
      timeoutSeconds: 60,
    });
    await result;
    assert.equal(fake.received().stdin, prompt);
  } finally {
    fake.dispose();
  }
});

test("passes the built argv to the child unchanged", async () => {
  const { received } = await runAgainst(
    { chunks: [jsonl({ type: "thread.started", thread_id: "t" })] },
    {
      invocation: {
        kind: "exec",
        sandbox: "read-only",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
      },
    },
  );

  assert.deepEqual(received.argv.slice(0, 3), ["--json", "--color", "never"]);
  assert.ok(received.argv.includes("--model"));
  assert.equal(received.argv[received.argv.indexOf("--model") + 1], "gpt-5.6-luna");
  assert.equal(
    received.argv[received.argv.indexOf("--config") + 1],
    'model_reasoning_effort="low"',
  );
  assert.equal(received.argv[received.argv.indexOf("--sandbox") + 1], "read-only");
});

test("reassembles JSON lines split across stdout writes", async () => {
  const line = JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Reassembled." },
  });
  const cut = Math.floor(line.length / 2);

  const { outcome } = await runAgainst({
    chunks: [
      '{"type":"thread.started","thre',
      'ad_id":"split-thread"}\n',
      line.slice(0, cut),
      `${line.slice(cut)}\n`,
    ],
    chunkDelayMs: 5,
  });

  assert.equal(outcome.threadId, "split-thread");
  assert.equal(outcome.finalMessage, "Reassembled.");
});

test("keeps non-ASCII text intact across the stream", async () => {
  const text = "acentuación, ñ, 日本語, emoji 🙂, and a tab\there";
  const { outcome } = await runAgainst({
    chunks: [jsonl({ type: "item.completed", item: { type: "agent_message", text } })],
  });

  assert.equal(outcome.finalMessage, text);
});

test("ignores noise on stdout without losing the surrounding events", async () => {
  // The CLI prints the occasional non-JSON line. One bad line must not abort a
  // run that is otherwise fine.
  const { outcome } = await runAgainst({
    chunks: [
      "warning: something human-readable\n",
      "{not valid json at all}\n",
      jsonl({ type: "item.completed", item: { type: "agent_message", text: "Survived." } }),
      "\n",
    ],
  });

  assert.equal(outcome.finalMessage, "Survived.");
});

test("propagates a non-zero exit code and captures stderr", async () => {
  const { outcome } = await runAgainst({
    chunks: [jsonl({ type: "thread.started", thread_id: "t" })],
    stderr: "codex: authentication required\n",
    exitCode: 3,
  });

  assert.equal(outcome.exitCode, 3);
  assert.match(outcome.stderr, /authentication required/);
});

test("surfaces an in-band error item even when the process exits zero", async () => {
  // Codex reports some failures as an item rather than through the exit code.
  const { outcome } = await runAgainst({
    chunks: [
      jsonl(
        { type: "thread.started", thread_id: "t" },
        { type: "item.completed", item: { type: "error", message: "model overloaded" } },
      ),
    ],
    exitCode: 0,
  });

  assert.equal(outcome.exitCode, 0);
  assert.ok(
    outcome.errors.some((message) => message.includes("model overloaded")),
    `expected the error item to be collected, got ${JSON.stringify(outcome.errors)}`,
  );
});

test("handles a long stream without dropping events", async () => {
  const events = Array.from({ length: 500 }, (_, index) => ({
    type: "item.completed",
    item: { type: "agent_message", text: `message ${index}` },
  }));

  const { outcome } = await runAgainst({ chunks: [jsonl(...events)] });

  assert.equal(outcome.agentMessages.length, 500);
  assert.equal(outcome.finalMessage, "message 499");
});

test("reports a run with no output at all rather than hanging", async () => {
  const { outcome } = await runAgainst({ chunks: [], exitCode: 0 });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.finalMessage, "");
  assert.equal(outcome.threadId, null);
});


test("survives malformed event fields and keeps subsequent valid output", async () => {
  const { outcome } = await runAgainst({ chunks: [jsonl(
    { type: "item.completed", item: { type: "file_change", changes: [null] } },
    { type: "item.completed", item: { type: "file_change", changes: {} } },
    { type: "item.completed", item: { type: "error", message: 42 } },
    { type: "item.completed", item: { type: "agent_message", text: 42 } },
    { type: "item.completed", item: { type: "agent_message", text: "Survived." } },
  )] });
  assert.equal(outcome.finalMessage, "Survived.");
  assert.deepEqual(outcome.fileChanges, []);
  assert.deepEqual(outcome.agentMessages, ["Survived."]);
});

test("reports discarded oversized lines and retains the next valid message", async () => {
  const { outcome } = await runAgainst({ chunks: [
    "x".repeat(2 * 1024 * 1024),
    `\n${jsonl({ type: "item.completed", item: { type: "agent_message", text: "Recovered." } })}`,
    "x".repeat(2 * 1024 * 1024),
  ] });
  assert.equal(outcome.finalMessage, "Recovered.");
  assert.ok(outcome.errors.some((message) => /truncat.*line/i.test(message)));
});

test("bounds retained message text while preserving the final answer", async () => {
  const events = Array.from({ length: 24 }, () => ({
    type: "item.completed", item: { type: "agent_message", text: "x".repeat(64 * 1024) },
  }));
  const { outcome } = await runAgainst({ chunks: [jsonl(...events,
    { type: "item.completed", item: { type: "agent_message", text: "Final answer." } },
  )] });
  assert.ok(outcome.agentMessages.reduce((total, message) => total + message.length, 0) <= 1024 * 1024);
  assert.equal(outcome.finalMessage, "Final answer.");
  assert.equal(outcome.errors.filter((message) => /truncat.*message/i.test(message)).length, 1);
});

test("bounds retained empty messages as well as message text", async () => {
  const events = Array.from({ length: 2000 }, () => ({
    type: "item.completed", item: { type: "agent_message", text: "" },
  }));
  const { outcome } = await runAgainst({ chunks: [jsonl(...events)] });
  assert.ok(outcome.agentMessages.length <= 1000);
  assert.ok(outcome.errors.some((message) => /truncat.*message/i.test(message)));
});
