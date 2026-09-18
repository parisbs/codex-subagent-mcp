import assert from "node:assert/strict";
import { test } from "node:test";

import { ThreadRegistry, type ThreadSettings } from "../src/threads.ts";
import type { TokenUsage } from "../src/types.ts";

const settings = (model: string): ThreadSettings => ({
  model,
  reasoningEffort: "low",
  workingDir: "/repo",
  skipGitRepoCheck: false,
});

test("returns what a thread last ran with", () => {
  const threads = new ThreadRegistry();
  threads.record("t", settings("first"));
  threads.record("t", { ...settings("second"), reasoningEffort: "high" });

  assert.deepEqual(threads.get("t"), { ...settings("second"), reasoningEffort: "high" });
  assert.equal(threads.get("unknown"), undefined);
});

test("keeps the last cumulative usage beside a thread's settings", () => {
  const threads = new ThreadRegistry();
  const total: TokenUsage = {
    inputTokens: 123_432,
    cachedInputTokens: 96_512,
    outputTokens: 601,
    reasoningOutputTokens: 200,
  };

  threads.record("t", settings("model"), total);

  assert.deepEqual(threads.getTotalUsage("t"), total);
  assert.equal(threads.getTotalUsage("unknown"), undefined);
});

test("forgets the least recently used thread beyond the limit", () => {
  const threads = new ThreadRegistry(2);
  threads.record("a", settings("a"));
  threads.record("b", settings("b"));
  // Touching "a" again makes "b" the oldest.
  threads.record("a", settings("a"));
  threads.record("c", settings("c"));

  assert.equal(threads.get("b"), undefined);
  assert.ok(threads.get("a"));
  assert.ok(threads.get("c"));
});
