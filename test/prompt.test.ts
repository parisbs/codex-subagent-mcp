import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NO_FURTHER_DELEGATION_INSTRUCTION,
  QUALITY_CONTRACT,
  STRUCTURED_OUTPUT_INSTRUCTION,
  assemblePrompt,
  followUpPrompt,
} from "../src/prompt.ts";

test("always leads with the quality contract", () => {
  const prompt = assemblePrompt({ task: "Do the thing" });
  assert.ok(prompt.startsWith(QUALITY_CONTRACT));
});

test("adds a clearly labelled instruction not to delegate further", () => {
  const prompt = assemblePrompt({ task: "Do the thing" });
  assert.ok(prompt.includes(NO_FURTHER_DELEGATION_INSTRUCTION));
  assert.match(prompt, /<delegation_instruction>\nInstruction:/);
  assert.match(prompt, /Do not delegate work to other agents/);
  assert.ok(prompt.indexOf(NO_FURTHER_DELEGATION_INSTRUCTION) > prompt.indexOf(QUALITY_CONTRACT));
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

test("explains read-only verification and network limits without hiding real permission defects", () => {
  const prompt = assemblePrompt({ task: "Audit the auth module", readOnly: true });
  assert.match(prompt, /temporary, cache, or build files may fail/);
  assert.match(prompt, /verification could not be completed/);
  assert.match(prompt, /Do not dismiss permission failures that are themselves the behaviour under investigation/);
  assert.match(prompt, /Shell commands have no network access/);
  assert.match(prompt, /web-search tool if it is enabled/);
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

const PROSE_SUMMARY = "End with a short, concrete summary";

test("AC-9 tells a schema delegation to end with only the JSON, and stops asking for a prose summary", () => {
  const prompt = assemblePrompt({ task: "List the findings.", structuredOutput: true });
  assert.ok(prompt.includes(STRUCTURED_OUTPUT_INSTRUCTION));
  assert.ok(!prompt.includes(PROSE_SUMMARY), "the contract still asks a schema turn for prose");
  assert.ok(prompt.includes(NO_FURTHER_DELEGATION_INSTRUCTION));
  assert.ok(prompt.trimEnd().endsWith("</task>"), "the task stays last");
});

test("AC-9 leaves a delegation without a schema exactly as before", () => {
  const prompt = assemblePrompt({ task: "List the findings." });
  assert.ok(!prompt.includes(STRUCTURED_OUTPUT_INSTRUCTION));
  assert.ok(prompt.includes(PROSE_SUMMARY));
  assert.ok(prompt.startsWith(QUALITY_CONTRACT));
});

test("AC-9 gives a schema follow-up the instruction, since earlier turns asked for prose", () => {
  const prompt = followUpPrompt("Now as JSON, please.", true);
  assert.ok(prompt.includes(STRUCTURED_OUTPUT_INSTRUCTION));
  assert.ok(prompt.includes("Now as JSON, please."));
});

test("AC-9 sends a follow-up without a schema unchanged", () => {
  assert.equal(followUpPrompt("And the next file?", false), "And the next file?");
});

test("AC-9 says the instruction supersedes earlier ones and never carries a schema", () => {
  assert.match(STRUCTURED_OUTPUT_INSTRUCTION, /supersedes/);
  assert.doesNotMatch(STRUCTURED_OUTPUT_INSTRUCTION, /"type"|additionalProperties/);
});

// #150: a use_worktree run is told what its worktree lacks before it starts (ADR 26).

const WORKTREE_NOTICE = /not carried over/;

const executionModeSections = (prompt: string): string[] =>
  prompt.match(/<execution_mode>[\s\S]*?<\/execution_mode>/g) ?? [];

/** The one `execution_mode` section that carries the worktree notice, so content is checked inside it. */
function worktreeSection(prompt: string): string {
  const found = executionModeSections(prompt).filter((section) => WORKTREE_NOTICE.test(section));
  assert.equal(found.length, 1, `expected one execution_mode section with the worktree notice:\n${prompt}`);
  return found[0]!;
}

test("AC-4 (#150) tells a worktree run what its worktree lacks and to report a missing dependency", () => {
  const section = worktreeSection(assemblePrompt({ task: "Fix the bug", worktree: true }));
  for (const fact of [
    /git worktree/i,
    /uncommitted changes/i,
    /untracked files/i,
    /ignored files/i,
    /installed dependencies/i,
    /committed content/i,
    /missing dependency/i,
    /reported/i,
    /production code/i,
  ]) {
    assert.match(section, fact);
  }
});

test("AC-4 (#150) puts the worktree notice in the slot of the read-only notice", () => {
  const prompt = assemblePrompt({ task: "Fix the bug", systemInstructions: "Be terse", worktree: true });
  const notice = prompt.indexOf(worktreeSection(prompt));
  assert.ok(notice > prompt.indexOf(NO_FURTHER_DELEGATION_INSTRUCTION));
  assert.ok(notice < prompt.indexOf("<orchestrator_instructions>"));
});

test("AC-4 (#150) gives a read-only worktree run both notices, each in its own section and slot", () => {
  const prompt = assemblePrompt({ task: "Audit it", systemInstructions: "Be terse", readOnly: true, worktree: true });
  const readOnly = executionModeSections(prompt).filter((section) => /read-only sandbox/.test(section));
  assert.equal(readOnly.length, 1, prompt);
  const worktree = worktreeSection(prompt);
  assert.notEqual(readOnly[0], worktree, "the two notices share one section");
  for (const section of [readOnly[0]!, worktree]) {
    const at = prompt.indexOf(section);
    assert.ok(at > prompt.indexOf(NO_FURTHER_DELEGATION_INSTRUCTION));
    assert.ok(at < prompt.indexOf("<orchestrator_instructions>"));
  }
});

test("AC-5 (#150) leaves a run without a worktree with no worktree notice or section", () => {
  for (const parts of [{}, { worktree: false }, { readOnly: true }, { readOnly: true, worktree: false }]) {
    const prompt = assemblePrompt({ task: "Fix the bug", ...parts });
    assert.doesNotMatch(prompt, WORKTREE_NOTICE, JSON.stringify(parts));
    assert.deepEqual(
      executionModeSections(prompt).filter((section) => /worktree/i.test(section)),
      [],
      JSON.stringify(parts),
    );
  }
});
