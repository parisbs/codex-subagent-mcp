import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCodexArgs } from "../src/codex/args.ts";

test("builds a minimal read-only exec invocation", () => {
  const args = buildCodexArgs({ kind: "exec", sandbox: "read-only" });
  assert.deepEqual(args, ["exec", "--json", "--color", "never", "--sandbox", "read-only"]);
});

test("passes reasoning effort through the config key, not a flag", () => {
  const args = buildCodexArgs({
    kind: "exec",
    model: "gpt-6-astra",
    reasoningEffort: "xhigh",
    sandbox: "read-only",
  });
  assert.ok(args.includes("--model"));
  assert.equal(args[args.indexOf("--model") + 1], "gpt-6-astra");
  assert.equal(args[args.indexOf("--config") + 1], 'model_reasoning_effort="xhigh"');
});

test("never places the prompt on the argv", () => {
  const args = buildCodexArgs({ kind: "exec", sandbox: "read-only" });
  assert.ok(args.every((arg) => arg.startsWith("-") || !arg.includes(" ")));
});

test("omits --approve-for-me under a read-only sandbox", () => {
  const args = buildCodexArgs({
    kind: "exec",
    sandbox: "read-only",
    autoApprove: true,
  });
  assert.ok(!args.includes("--approve-for-me"));
});

test("swaps --sandbox for --approve-for-me when auto-approving writes", () => {
  // codex-cli 0.154.0: "--sandbox cannot be used with --approve-for-me".
  const args = buildCodexArgs({
    kind: "exec",
    sandbox: "workspace-write",
    autoApprove: true,
  });
  assert.ok(args.includes("--approve-for-me"));
  assert.ok(!args.includes("--sandbox"));
});

test("keeps --sandbox when auto-approve is off", () => {
  const args = buildCodexArgs({ kind: "exec", sandbox: "workspace-write" });
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(!args.includes("--approve-for-me"));
});

test("never auto-approves under danger-full-access", () => {
  const args = buildCodexArgs({
    kind: "exec",
    sandbox: "danger-full-access",
    autoApprove: true,
  });
  assert.ok(!args.includes("--approve-for-me"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "danger-full-access");
});

test("forwards every optional flag", () => {
  const args = buildCodexArgs({
    kind: "exec",
    sandbox: "workspace-write",
    workingDir: "/tmp/project",
    addDirs: ["/tmp/shared", "/tmp/other"],
    useWorktree: true,
    webSearch: true,
    skipGitRepoCheck: true,
    ephemeral: true,
  });
  assert.equal(args[args.indexOf("--cd") + 1], "/tmp/project");
  assert.equal(args.filter((arg) => arg === "--add-dir").length, 2);
  assert.ok(args.includes("--worktree"));
  assert.ok(args.includes("--search"));
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.ok(args.includes("--ephemeral"));
});

test("builds a resume invocation with the thread id", () => {
  const args = buildCodexArgs({
    kind: "resume",
    threadId: "01a08e0f-ad3e-7472-9c83-a7b60c473bbe",
    sandbox: "read-only",
  });
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "01a08e0f-ad3e-7472-9c83-a7b60c473bbe"]);
});

test("resume omits the flags the CLI rejects on that subcommand", () => {
  // codex-cli 0.154.0 exits with code 2 on `exec resume --color` or `--sandbox`.
  const args = buildCodexArgs({
    kind: "resume",
    threadId: "thread-1",
    sandbox: "workspace-write",
    autoApprove: true,
    workingDir: "/tmp/project",
    addDirs: ["/tmp/shared"],
    webSearch: true,
  });
  for (const rejected of [
    "--color",
    "--sandbox",
    "--approve-for-me",
    "--cd",
    "--add-dir",
    "--search",
  ]) {
    assert.ok(!args.includes(rejected), `resume must not pass ${rejected}`);
  }
});

test("resume applies the sandbox through a config override", () => {
  const args = buildCodexArgs({
    kind: "resume",
    threadId: "thread-1",
    sandbox: "workspace-write",
  });
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
});

test("refuses to resume without a thread id", () => {
  assert.throws(
    () => buildCodexArgs({ kind: "resume", sandbox: "read-only" }),
    /thread_id is required/,
  );
});

test("keeps shell metacharacters intact as single argv entries", () => {
  const hostile = '/tmp/$(rm -rf ~)/`whoami`/dir';
  const args = buildCodexArgs({
    kind: "exec",
    sandbox: "read-only",
    workingDir: hostile,
  });
  assert.equal(args[args.indexOf("--cd") + 1], hostile);
});

test("enables the worktrees feature alongside --worktree", () => {
  // codex-cli 0.154.0: `--worktree` alone exits with "requires the worktrees
  // feature". `--enable` applies to this run only and never writes to config.
  const args = buildCodexArgs({ kind: "exec", sandbox: "workspace-write", useWorktree: true });
  const enableAt = args.indexOf("--enable");
  assert.notEqual(enableAt, -1);
  assert.equal(args[enableAt + 1], "worktrees");
  assert.ok(args.includes("--worktree"));
});

test("enables the feature for resumed sessions too", () => {
  const args = buildCodexArgs({
    kind: "resume",
    threadId: "t1",
    sandbox: "workspace-write",
    useWorktree: true,
  });
  assert.equal(args[args.indexOf("--enable") + 1], "worktrees");
});

test("does not enable the feature when no worktree was asked for", () => {
  assert.ok(!buildCodexArgs({ kind: "exec", sandbox: "read-only" }).includes("--enable"));
});
