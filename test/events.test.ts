import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JsonLinesParser,
  describeEvent,
  isNotice,
  parseUsage,
  toExecutedCommand,
  toErrorMessage,
  toStreamError,
  toTurnFailure,
  type CodexEvent,
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


test("skips events with malformed fields before exposing them to consumers", () => {
  const malformed = [
    { type: 7 },
    { type: "thread.started", thread_id: {} },
    { type: "item.completed", item: { type: "file_change", changes: [null] } },
    { type: "item.completed", item: { type: "file_change", changes: {} } },
    { type: "item.completed", item: { type: "error", message: 42 } },
    { type: "item.completed", item: { type: "agent_message", text: 42 } },
    { type: "item.started", item: { type: "command_execution", command: 42 } },
    { type: "item.completed", item: { type: "command_execution", command: "ls", aggregated_output: {} } },
    { type: "item.completed", item: { type: "command_execution", command: "ls", exit_code: "zero" } },
    { type: "item.completed", item: { type: "file_change", changes: [{ path: "a", kind: {} }] } },
    { type: "turn.completed", usage: { input_tokens: "many" } },
  ];
  for (const event of malformed) {
    const parser = new JsonLinesParser();
    assert.deepEqual(parser.push(`${JSON.stringify(event)}\n`), [], JSON.stringify(event));
  }
});

test("ignores malformed fields when event helpers are called directly", () => {
  const changes = JSON.parse('{"type":"item.completed","item":{"type":"file_change","changes":[null]}}') as CodexEvent;
  assert.deepEqual(toFileChanges(changes), []);
  const error = JSON.parse('{"type":"item.completed","item":{"type":"error","message":42}}') as CodexEvent;
  assert.equal(toErrorMessage(error), null);
  assert.equal(describeEvent(error), null);
  const command = JSON.parse('{"type":"item.completed","item":{"type":"command_execution","command":"ls","aggregated_output":42}}') as CodexEvent;
  assert.equal(toExecutedCommand(command), null);
  const usage = JSON.parse('{"type":"turn.completed","usage":{"input_tokens":"many"}}') as CodexEvent;
  assert.equal(parseUsage(usage), null);
});

test("abandons oversized incomplete lines and resumes at the next newline", () => {
  const parser = new JsonLinesParser();
  for (let index = 0; index < 64; index++) {
    assert.deepEqual(parser.push("x".repeat(1024 * 1024)), []);
  }
  assert.equal(parser.truncatedLines, 1);
  assert.deepEqual(parser.push('{"type":"turn.started"}\n{"type":"turn.completed"}\n'), [
    { type: "turn.completed" },
  ]);
  assert.deepEqual(parser.flush(), []);
});

test("applies the line limit to complete lines and the final unterminated line", () => {
  const parser = new JsonLinesParser();
  const oversized = JSON.stringify({ type: "unknown", text: "x".repeat(1024 * 1024) });
  assert.deepEqual(parser.push(`${oversized}\n{"type":"turn.started"}\n`), [{ type: "turn.started" }]);
  assert.deepEqual(parser.push(oversized), []);
  assert.deepEqual(parser.flush(), []);
  assert.equal(parser.truncatedLines, 2);
  assert.deepEqual(parser.push('{"type":"turn.completed"}\n'), [{ type: "turn.completed" }]);
});

test("describes a completed web search with its query", () => {
  // Shapes captured from a real `web_search="live"` run on codex-cli 0.154.0.
  const started = {
    type: "item.started",
    item: { id: "item_0", type: "web_search", query: "", action: { type: "other" } },
  };
  const completed = {
    type: "item.completed",
    item: {
      id: "item_0",
      type: "web_search",
      query: "site:nodejs.org current latest stable release Node.js",
      action: { type: "search", query: "site:nodejs.org current latest stable release Node.js" },
    },
  };

  assert.equal(describeEvent(started), null);
  assert.equal(
    describeEvent(completed),
    "Searched the web: site:nodejs.org current latest stable release Node.js",
  );
});

// Messages captured from codex-cli 0.154.0 runs against a scratch CODEX_HOME.
const IGNORED_KEYS_NOTICE =
  "Ignored unsupported project-local config keys in /tmp/proj/.codex/config.toml: model_provider, notify. " +
  "If you want these settings to apply, manually set them in your user-level config.toml.";
const MODEL_SWITCH_NOTICE =
  "This session was recorded with model `gpt-5.5` but is resuming with `gpt-5.6-luna`. " +
  "Consider switching back to `gpt-5.5` as it may affect Codex performance.";
const USAGE_LIMIT =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit " +
  "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:20 PM.";

test("treats known configuration and resume warnings as notices, anything else as an error", () => {
  assert.equal(isNotice(IGNORED_KEYS_NOTICE), true);
  assert.equal(isNotice(MODEL_SWITCH_NOTICE), true);
  assert.equal(isNotice("Falling back from WebSockets to HTTPS transport. unexpected status 401"), true);
  assert.equal(isNotice("model overloaded"), false);
  assert.equal(isNotice(USAGE_LIMIT), false);
});

test("extracts a failed turn and top-level errors, but not reconnect progress", () => {
  assert.equal(toTurnFailure({ type: "turn.failed", error: { message: USAGE_LIMIT } }), USAGE_LIMIT);
  assert.match(toTurnFailure({ type: "turn.failed" }) ?? "", /without a reason/);
  assert.equal(toTurnFailure({ type: "turn.completed" }), null);

  assert.equal(toStreamError({ type: "error", message: USAGE_LIMIT }), USAGE_LIMIT);
  assert.equal(
    toStreamError({ type: "error", message: "Reconnecting... 2/5 (unexpected status 401 Unauthorized)" }),
    null,
  );
  assert.equal(toStreamError({ type: "item.completed", message: USAGE_LIMIT }), null);
});

test("skips top-level error fields with the wrong shape", () => {
  const parser = new JsonLinesParser();
  const events = parser.push(
    '{"type":"turn.failed","error":"not an object"}\n{"type":"error","message":42}\n{"type":"turn.failed","error":{"message":"real"}}\n',
  );
  assert.deepEqual(events, [{ type: "turn.failed", error: { message: "real" } }]);
});

test("describes failed turns, reconnects and notices for progress", () => {
  assert.match(describeEvent({ type: "turn.failed", error: { message: USAGE_LIMIT } }) ?? "", /^Codex turn failed: You've hit/);
  assert.match(describeEvent({ type: "error", message: "Reconnecting... 3/5 (timeout)" }) ?? "", /^Codex is reconnecting/);
  assert.match(
    describeEvent({ type: "item.completed", item: { type: "error", message: IGNORED_KEYS_NOTICE } }) ?? "",
    /^Codex notice:/,
  );
});
