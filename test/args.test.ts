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
  assert.ok(args.includes('web_search="live"'));
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

test("refuses a thread id that would be parsed as an option", () => {
  // `exec resume` takes the thread id positionally. Before this check, "--help"
  // made the CLI print its help and exit 0, which the server then reported as a
  // successful follow-up; other flags reached option parsing the same way,
  // including one that turns the sandbox off.
  for (const threadId of [
    "--help",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model=gpt-6-astra",
    "-m",
  ]) {
    assert.throws(
      () => buildCodexArgs({ kind: "resume", threadId, sandbox: "read-only" }),
      /Invalid thread_id/,
      `expected ${threadId} to be refused`,
    );
  }
});

test("refuses a thread id carrying anything a parser would read as structure", () => {
  for (const threadId of ["with space", "semi;colon", "equals=sign", "quote\"mark", "new\nline"]) {
    assert.throws(
      () => buildCodexArgs({ kind: "resume", threadId, sandbox: "read-only" }),
      /Invalid thread_id/,
      `expected ${JSON.stringify(threadId)} to be refused`,
    );
  }
});

test("accepts the thread id shape the CLI actually issues", () => {
  // Observed from a real run. The check describes a safe shape rather than this
  // exact format, so a future change to the CLI's ids does not break resume.
  const args = buildCodexArgs({
    kind: "resume",
    threadId: "01a092fe-43f0-76f1-8460-51e7ba8f6c90",
    sandbox: "read-only",
  });

  assert.equal(args[2], "01a092fe-43f0-76f1-8460-51e7ba8f6c90");
});

test("names the offending value when it refuses a thread id", () => {
  assert.throws(
    () => buildCodexArgs({ kind: "resume", threadId: "--help", sandbox: "read-only" }),
    /"--help"/,
  );
});

test("enables live web search through a config override, never the top-level flag", () => {
  // `--search` is an option of `codex` itself, not of `codex exec`. Placed after
  // the subcommand, codex-cli 0.154.0 exits 2 with "unexpected argument
  // '--search' found", so `web_search: true` failed every time. The config key
  // is accepted by `exec` and keeps the argv starting with the subcommand.
  const args = buildCodexArgs({ kind: "exec", sandbox: "read-only", webSearch: true });

  assert.equal(args[0], "exec");
  assert.ok(!args.includes("--search"));
  assert.equal(args[args.indexOf('web_search="live"') - 1], "--config");
});

test("leaves Codex's own web search setting alone when not asked", () => {
  const args = buildCodexArgs({ kind: "exec", sandbox: "read-only" });

  assert.ok(!args.some((arg) => arg.startsWith("web_search")));
});

test("switches off Codex MCP entries that point back at this server, on exec and resume", () => {
  const exec = buildCodexArgs({ kind: "exec", sandbox: "read-only", disabledMcpServers: ["codex-subagent", "my server"] });
  const resume = buildCodexArgs({ kind: "resume", threadId: "t", sandbox: "read-only", disabledMcpServers: ["codex-subagent"] });

  assert.equal(exec[0], "exec");
  assert.ok(exec.includes("mcp_servers.codex-subagent.enabled=false"));
  assert.equal(exec[exec.indexOf("mcp_servers.codex-subagent.enabled=false") - 1], "--config");
  assert.ok(exec.includes('mcp_servers."my server".enabled=false'));
  assert.ok(resume.includes("mcp_servers.codex-subagent.enabled=false"));
  assert.ok(!buildCodexArgs({ kind: "exec", sandbox: "read-only" }).some((arg) => arg.startsWith("mcp_servers.")));
});
