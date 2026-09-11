import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JsonLinesParser,
  describeEvent,
  parseUsage,
  toExecutedCommand,
  toFileChanges,
} from "../src/codex/events.ts";

// Captured verbatim from `codex exec --json` against codex-cli 0.154.0.
const STREAM = [
  '{"type":"thread.started","thread_id":"01a08e10-64e5-7a92-b832-6ad44f9f995f"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will list the directory."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"src\\npackage.json\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"DONE"}}',
  '{"type":"turn.completed","usage":{"input_tokens":27443,"cached_input_tokens":15872,"cache_write_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":18}}',
].join("\n");

test("parses a complete stream split at arbitrary chunk boundaries", () => {
  const parser = new JsonLinesParser();
  const events = [];
  for (let index = 0; index < STREAM.length; index += 7) {
    events.push(...parser.push(STREAM.slice(index, index + 7)));
  }
  events.push(...parser.flush());

  assert.equal(events.length, 7);
  assert.equal(events[0]?.type, "thread.started");
  assert.equal(events[0]?.thread_id, "01a08e10-64e5-7a92-b832-6ad44f9f995f");
  assert.equal(events.at(-1)?.type, "turn.completed");
});

test("ignores the CLI's plain-text notices interleaved in stdout", () => {
  const parser = new JsonLinesParser();
  const events = parser.push(
    'Reading additional input from stdin...\n{"type":"turn.started"}\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "turn.started");
});

test("ignores malformed JSON lines without throwing", () => {
  const parser = new JsonLinesParser();
  const events = parser.push('{"type":"turn.started"\n{"type":"turn.completed"}\n');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "turn.completed");
});

test("extracts token usage from turn.completed", () => {
  const parser = new JsonLinesParser();
  const events = parser.push(`${STREAM}\n`);
  const usage = parseUsage(events.at(-1)!);
  assert.deepEqual(usage, {
    inputTokens: 27443,
    cachedInputTokens: 15872,
    outputTokens: 100,
    reasoningOutputTokens: 18,
  });
});

test("extracts executed commands only from completed command items", () => {
  const parser = new JsonLinesParser();
  const events = parser.push(`${STREAM}\n`);
  const commands = events
    .filter((event) => event.type === "item.completed")
    .map(toExecutedCommand)
    .filter((command) => command !== null);

  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.command, "/bin/zsh -lc ls");
  assert.equal(commands[0]?.exitCode, 0);
});

test("truncates long command output in the preview", () => {
  const command = toExecutedCommand({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "cat big.log",
      aggregated_output: "x".repeat(5000),
      exit_code: 0,
      status: "completed",
    },
  });
  assert.ok(command);
  assert.ok(command.outputPreview.includes("truncated, 5000 chars total"));
  assert.ok(command.outputPreview.length < 5000);
});

test("describes only the events worth showing as progress", () => {
  assert.match(
    describeEvent({ type: "thread.started", thread_id: "abc" }) ?? "",
    /session started/,
  );
  assert.equal(describeEvent({ type: "item.started", item: { type: "agent_message" } }), null);
  assert.equal(describeEvent({ type: "some.future.event" }), null);
});

test("extracts the files a completed change item touched", () => {
  // Captured from a real `--worktree` run: writes land outside the working tree,
  // so the reported path is the only way the caller learns what changed.
  const changes = toFileChanges({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "file_change",
      status: "completed",
      changes: [
        { path: "/Users/x/.codex/worktrees/024d/repo/WORKTREE_PROOF.txt", kind: "add" },
        { path: "src/server.ts", kind: "edit" },
      ],
    },
  });
  assert.equal(changes.length, 2);
  assert.equal(changes[0]?.kind, "add");
  assert.equal(changes[1]?.path, "src/server.ts");
});

test("ignores change items that are still in progress", () => {
  assert.deepEqual(
    toFileChanges({ type: "item.started", item: { type: "file_change", changes: [{ path: "a", kind: "add" }] } }),
    [],
  );
});

test("tolerates a change entry without a path", () => {
  assert.deepEqual(
    toFileChanges({ type: "item.completed", item: { type: "file_change", changes: [{ kind: "add" }] } }),
    [],
  );
});

test("describes file changes for progress reporting", () => {
  const description = describeEvent({
    type: "item.completed",
    item: { type: "file_change", changes: [{ path: "src/a.ts", kind: "edit" }] },
  });
  assert.match(description ?? "", /Changed 1 file\(s\): edit src\/a\.ts/);
});
