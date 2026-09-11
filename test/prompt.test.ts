import assert from "node:assert/strict";
import { test } from "node:test";

import { QUALITY_CONTRACT, assemblePrompt } from "../src/prompt.ts";

test("always leads with the quality contract", () => {
  const prompt = assemblePrompt({ task: "Do the thing" });
  assert.ok(prompt.startsWith(QUALITY_CONTRACT));
});

test("puts the task last, closest to the generation point", () => {
  const prompt = assemblePrompt({
    task: "Do the thing",
    context: "Some background",
    systemInstructions: "Be terse",
  });
  assert.ok(prompt.trimEnd().endsWith("</task>"));
  // The contract itself mentions <task>, so anchor on the real opening tag.
  const taskAt = prompt.lastIndexOf("<task>");
  assert.ok(prompt.indexOf("<context>") < taskAt);
  assert.ok(
    prompt.indexOf("<orchestrator_instructions>") < prompt.indexOf("<context>"),
  );
});

test("announces the read-only sandbox so Codex does not try to edit", () => {
  const prompt = assemblePrompt({ task: "Audit the auth module", readOnly: true });
  assert.match(prompt, /<execution_mode>/);
  assert.match(prompt, /read-only sandbox/);
});

test("omits the read-only notice when writes are allowed", () => {
  const prompt = assemblePrompt({ task: "Fix the bug" });
  assert.ok(!prompt.includes("<execution_mode>"));
});

test("numbers acceptance criteria and lists target files", () => {
  const prompt = assemblePrompt({
    task: "Fix the bug",
    targetFiles: ["src/a.ts", "src/b.ts"],
    acceptanceCriteria: ["Tests pass", "No new lint errors"],
  });
  assert.match(prompt, /- src\/a\.ts/);
  assert.match(prompt, /1\. Tests pass/);
  assert.match(prompt, /2\. No new lint errors/);
});

test("drops empty optional sections instead of emitting blank tags", () => {
  const prompt = assemblePrompt({
    task: "Fix the bug",
    context: "   ",
    systemInstructions: "",
    targetFiles: [],
    acceptanceCriteria: [],
  });
  assert.ok(!prompt.includes("<context>"));
  assert.ok(!prompt.includes("<target_files>"));
  assert.ok(!prompt.includes("<acceptance_criteria>"));
});

test("passes shell metacharacters through untouched", () => {
  const hostile = 'echo "$(whoami)" && rm -rf / # `id`';
  assert.ok(assemblePrompt({ task: hostile }).includes(hostile));
});
