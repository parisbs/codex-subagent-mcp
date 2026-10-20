import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  codexHomeDir,
  compareApplied,
  parseSessionMetaCommit,
  parseTaskCompleteLine,
  parseTurnContextLine,
  recoverThreadSettings,
  readTurnContext,
  type RequestedSettings,
} from "../src/codex/rollout.ts";
import {
  createCodexHome,
  SESSION_META_LINE as SESSION_META,
  turnContextLine as turnContext,
  type CodexHome,
} from "./fixtures/codex-home.ts";
import {
  CAPACITY_0160,
  CAPACITY_0160_TURN,
  THREAD_0163,
  THREAD_0163_FAILED_TURN,
  THREAD_0163_FOLLOW_UP_TURN,
  USAGE_LIMIT_0154,
  USAGE_LIMIT_0154_TURN,
  USAGE_LIMIT_0162,
  USAGE_LIMIT_0162_TURN,
} from "./fixtures/task-complete.ts";

/**
 * Coverage of the one part of this server that reads an internal Codex format.
 *
 * The turn context below is a real line from codex-cli 0.154.0, with the local
 * paths and timezone replaced. Everything it carries beyond the five fields the
 * server reads is kept on purpose: a fixture trimmed to what the parser wants
 * would not catch a parser that only works on trimmed input.
 */
const REAL_TURN_CONTEXT =
  '{"timestamp":"2026-09-17T19:12:03.849Z","ordinal":5,"type":"turn_context","payload":{"turn_id":"01a0b0c8-6d84-78b3-84db-b65b47c35b7f","root_turn_id":"01a0b0c8-6d84-78b3-84db-b65b47c35b7f","cwd":"/workspace/project","workspace_roots":["/workspace/project"],"current_date":"2026-09-17","timezone":"UTC","approval_policy":"never","approvals_reviewer":"user","sandbox_policy":{"type":"read-only"},"permission_profile":{"type":"managed","file_system":{"type":"restricted","entries":[{"path":{"type":"special","value":{"kind":"root"}},"access":"read"}]},"network":"restricted"},"model":"gpt-5.6-luna","comp_hash":"3000","personality":"pragmatic","collaboration_mode":{"mode":"default","settings":{"model":"gpt-5.6-luna","reasoning_effort":"low","developer_instructions":null}},"multi_agent_version":"v1","realtime_active":false,"effort":"low","summary":"auto"}}';

const REQUESTED: RequestedSettings = {
  model: "gpt-5.6-luna",
  reasoningEffort: "low",
  sandbox: "read-only",
  workingDir: "/workspace/project",
};

/** The same line as recorded by codex-cli 0.159.2 (#98): new keys such as `disabled_plugin_ids`, same fields read. */
const REAL_TURN_CONTEXT_0159 =
  "{\"timestamp\":\"2026-09-30T18:21:47.664Z\",\"ordinal\":5,\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"01a0f38d-18e0-7f51-aa3b-6c78bc380f8b\",\"root_turn_id\":\"01a0f38d-18e0-7f51-aa3b-6c78bc380f8b\",\"disabled_plugin_ids\":[],\"cwd\":\"/workspace/project\",\"workspace_roots\":[\"/workspace/project\"],\"current_date\":\"2026-09-30\",\"timezone\":\"UTC\",\"approval_policy\":\"never\",\"approvals_reviewer\":\"user\",\"sandbox_policy\":{\"type\":\"read-only\"},\"permission_profile\":{\"type\":\"managed\",\"file_system\":{\"type\":\"restricted\",\"entries\":[{\"path\":{\"type\":\"special\",\"value\":{\"kind\":\"root\"}},\"access\":\"read\"}]},\"network\":\"restricted\"},\"model\":\"gpt-5.6-luna\",\"comp_hash\":\"3000\",\"collaboration_mode\":{\"mode\":\"default\",\"settings\":{\"model\":\"gpt-5.6-luna\",\"reasoning_effort\":\"low\",\"developer_instructions\":null}},\"multi_agent_version\":\"v1\",\"realtime_active\":false,\"effort\":\"low\",\"summary\":\"none\"}}";

/** The same line as recorded by codex-cli 0.160.0: same keys as 0.159.2. Home path and timezone replaced. */
const REAL_TURN_CONTEXT_0160 =
  "{\"timestamp\":\"2026-10-02T00:48:43.142Z\",\"ordinal\":5,\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"01a0fa15-b148-7063-b8e4-2ad5c577343e\",\"root_turn_id\":\"01a0fa15-b148-7063-b8e4-2ad5c577343e\",\"disabled_plugin_ids\":[],\"cwd\":\"/workspace/project\",\"workspace_roots\":[\"/workspace/project\"],\"current_date\":\"2026-10-01\",\"timezone\":\"UTC\",\"approval_policy\":\"never\",\"approvals_reviewer\":\"user\",\"sandbox_policy\":{\"type\":\"read-only\"},\"permission_profile\":{\"type\":\"managed\",\"file_system\":{\"type\":\"restricted\",\"entries\":[{\"path\":{\"type\":\"special\",\"value\":{\"kind\":\"root\"}},\"access\":\"read\"}]},\"network\":\"restricted\"},\"model\":\"gpt-5.6-luna\",\"comp_hash\":\"3000\",\"collaboration_mode\":{\"mode\":\"default\",\"settings\":{\"model\":\"gpt-5.6-luna\",\"reasoning_effort\":\"low\",\"developer_instructions\":null}},\"multi_agent_version\":\"v1\",\"realtime_active\":false,\"effort\":\"low\",\"summary\":\"none\"}}";

/**
 * The same line as recorded by codex-cli 0.163.0 in a workspace-write run (#187): unlike the read-only
 * 0.163.0 lines it carries `file_system_sandbox_policy` and a `permission_profile` with write entries;
 * same fields read. Capture path replaced.
 */
const REAL_TURN_CONTEXT_0163_WRITE =
  "{\"timestamp\":\"2026-10-19T23:07:53.100Z\",\"ordinal\":5,\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"01a1566b-dab8-7b50-b38e-62d81930a795\",\"root_turn_id\":\"01a1566b-dab8-7b50-b38e-62d81930a795\",\"disabled_plugin_ids\":[],\"cwd\":\"/workspace/project\",\"approval_policy\":\"never\",\"approvals_reviewer\":\"user\",\"sandbox_policy\":{\"type\":\"workspace-write\",\"network_access\":false,\"exclude_tmpdir_env_var\":false,\"exclude_slash_tmp\":false},\"permission_profile\":{\"type\":\"managed\",\"file_system\":{\"type\":\"restricted\",\"entries\":[{\"path\":{\"type\":\"special\",\"value\":{\"kind\":\"root\"}},\"access\":\"read\"},{\"path\":{\"type\":\"path\",\"path\":\"/workspace/project\"},\"access\":\"write\"},{\"path\":{\"type\":\"special\",\"value\":{\"kind\":\"slash_tmp\"}},\"access\":\"write\"},{\"path\":{\"type\":\"special\",\"value\":{\"kind\":\"tmpdir\"}},\"access\":\"write\"},{\"path\":{\"type\":\"path\",\"path\":\"/workspace/project/.git\"},\"access\":\"read\",\"missing_path_behavior\":\"skip\"},{\"path\":{\"type\":\"path\",\"path\":\"/workspace/project/.agents\"},\"access\":\"read\",\"missing_path_behavior\":\"skip\"},{\"path\":{\"type\":\"path\",\"path\":\"/workspace/project/.codex\"},\"access\":\"read\",\"missing_path_behavior\":\"skip\"},{\"path\":{\"type\":\"path\",\"path\":\"/workspace/project/.aws\"},\"access\":\"read\",\"missing_path_behavior\":\"skip\"}]},\"network\":\"restricted\"},\"file_system_sandbox_policy\":{\"kind\":\"restricted\",\"entries\":[{\"path\":{\"type\":\"special\",\"value\":{\"kind\":\"root\"}},\"access\":\"read\"},{\"path\":{\"type\":\"path\",\"path\":\"/workspace/project\"},\"access\":\"write\"},{\"path\":{\"type\":\"special\",\"value\":{\"kind\":\"slash_tmp\"}},\"access\":\"write\"},{\"path\":{\"type\":\"special\",\"value\":{\"kind\":\"tmpdir\"}},\"access\":\"write\"},{\"path\":{\"type\":\"path\",\"path\":\"/workspace/project/.git\"},\"access\":\"read\",\"missing_path_behavior\":\"skip\"},{\"path\":{\"type\":\"path\",\"path\":\"/workspace/project/.agents\"},\"access\":\"read\",\"missing_path_behavior\":\"skip\"},{\"path\":{\"type\":\"path\",\"path\":\"/workspace/project/.codex\"},\"access\":\"read\",\"missing_path_behavior\":\"skip\"},{\"path\":{\"type\":\"path\",\"path\":\"/workspace/project/.aws\"},\"access\":\"read\",\"missing_path_behavior\":\"skip\"}]},\"model\":\"gpt-5.6-luna\",\"comp_hash\":\"3000\",\"collaboration_mode\":{\"mode\":\"default\",\"settings\":{\"model\":\"gpt-5.6-luna\",\"reasoning_effort\":\"low\",\"developer_instructions\":null}},\"multi_agent_version\":\"v1\",\"realtime_active\":false,\"cyber_access_program\":\"standard\",\"effort\":\"low\",\"summary\":\"none\"}}";

async function lookupIn(home: CodexHome, threadId: string | null) {
  return readTurnContext({ threadId, codexHome: home.path });
}

test("reads the settings Codex recorded for a run", async () => {
  const home = createCodexHome();
  try {
    home.write({ threadId: "thread-1", day: "2026-09-17", lines: [SESSION_META, REAL_TURN_CONTEXT] });
    const { context, reason } = await lookupIn(home, "thread-1");

    assert.equal(reason, null);
    assert.deepEqual(context, {
      cwd: "/workspace/project",
      model: "gpt-5.6-luna",
      effort: "low",
      sandbox: "read-only",
      approvalPolicy: "never",
    });
  } finally {
    home.dispose();
  }
});

test("takes the last turn of a resumed thread, not the first", async () => {
  const home = createCodexHome();
  try {
    home.write({
      threadId: "thread-2",
      day: "2026-09-17",
      lines: [
        SESSION_META,
        turnContext({ effort: "high", model: "gpt-6-astra" }),
        '{"type":"response_item","payload":{"type":"message"}}',
        turnContext({ effort: "low", model: "gpt-5.6-luna" }),
      ],
    });
    const { context } = await lookupIn(home, "thread-2");

    assert.equal(context?.model, "gpt-5.6-luna");
    assert.equal(context?.effort, "low");
  } finally {
    home.dispose();
  }
});

test("finds a thread whose session file was created on an earlier day", async () => {
  // A follow-up appends to the file of the day the thread started, so the
  // search cannot stop at today.
  const home = createCodexHome();
  try {
    home.write({ threadId: "old", day: "2026-09-11", lines: [SESSION_META, REAL_TURN_CONTEXT] });
    home.write({ threadId: "new", day: "2026-09-17", lines: [SESSION_META, turnContext({ model: "other" })] });

    assert.equal((await lookupIn(home, "old")).context?.model, "gpt-5.6-luna");
    assert.equal((await lookupIn(home, "new")).context?.model, "other");
  } finally {
    home.dispose();
  }
});

test("reports an unconfirmed lookup rather than guessing", async () => {
  const home = createCodexHome();
  try {
    const missing = await lookupIn(home, "absent");
    assert.equal(missing.context, null);
    assert.match(missing.reason ?? "", /no session file/);

    // An --ephemeral run writes no file and reports no thread id.
    const ephemeral = await lookupIn(home, null);
    assert.equal(ephemeral.context, null);
    assert.match(ephemeral.reason ?? "", /ephemeral/);

    home.write({ threadId: "empty", day: "2026-09-17", lines: [SESSION_META] });
    const noContext = await lookupIn(home, "empty");
    assert.equal(noContext.context, null);
    assert.match(noContext.reason ?? "", /no turn context/);
  } finally {
    home.dispose();
  }
});

test("survives a truncated line, an unknown shape and unrelated noise", async () => {
  const home = createCodexHome();
  try {
    home.write({
      threadId: "messy",
      day: "2026-09-17",
      lines: [
        SESSION_META,
        REAL_TURN_CONTEXT,
        "not json at all",
        '{"type":"turn_context","payload":{"cwd":',
        '{"type":"turn_context"}',
      ],
    });
    const { context } = await lookupIn(home, "messy");

    // The half-written line and the payload-less one are ignored; the good
    // context stands. A parser that threw here would lose the whole lookup.
    assert.equal(context?.model, "gpt-5.6-luna");
  } finally {
    home.dispose();
  }
});

test("recovers resume settings only from a complete recognised turn context", () => {
  const complete = recoverThreadSettings({
    context: {
      cwd: "/workspace/project",
      model: "gpt-5.6-luna",
      effort: "low",
      sandbox: "read-only",
      approvalPolicy: "never",
    },
    reason: null,
  });
  assert.deepEqual(complete, {
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    workingDir: "/workspace/project",
  });

  for (const context of [
    { cwd: null, model: "gpt-5.6-luna", effort: "low" },
    { cwd: "/workspace/project", model: null, effort: "low" },
    { cwd: "/workspace/project", model: "gpt-5.6-luna", effort: null },
    { cwd: "/workspace/project", model: "gpt-5.6-luna", effort: "turbo" },
  ]) {
    assert.equal(
      recoverThreadSettings({
        context: { ...context, sandbox: "read-only", approvalPolicy: "never" },
        reason: null,
      }),
      null,
    );
  }
  assert.equal(recoverThreadSettings({ context: null, reason: "missing" }), null);
});

test("ignores a line that only mentions a turn context in its text", () => {
  assert.equal(
    parseTurnContextLine('{"type":"item.completed","item":{"type":"agent_message","text":"turn_context"}}'),
    null,
  );
  assert.equal(parseTurnContextLine(""), null);
});

test("reads a flattened turn context as well as a nested one", () => {
  // The payload wrapper is 0.154.0's shape, not a guarantee.
  const flat = parseTurnContextLine(
    '{"type":"turn_context","cwd":"/w","model":"m","effort":null,"sandbox_policy":{"type":"read-only"},"approval_policy":"never"}',
  );
  assert.equal(flat?.model, "m");
  assert.equal(flat?.effort, null);
  assert.equal(flat?.sandbox, "read-only");
});

test("confirms settings that match and names the ones that do not", async () => {
  const confirmed = await compareApplied(REQUESTED, {
    context: { cwd: "/workspace/project", model: "gpt-5.6-luna", effort: "low", sandbox: "read-only", approvalPolicy: "never" },
    reason: null,
  });
  assert.equal(confirmed.source, "rollout");
  assert.equal(confirmed.model.state, "confirmed");
  assert.equal(confirmed.reasoningEffort.state, "confirmed");
  assert.equal(confirmed.sandbox.state, "confirmed");
  assert.equal(confirmed.workingDir.state, "confirmed");
  assert.equal(confirmed.approvalPolicy, "never");

  const drifted = await compareApplied(REQUESTED, {
    context: { cwd: "/elsewhere", model: "gpt-6-astra", effort: "high", sandbox: "workspace-write", approvalPolicy: "never" },
    reason: null,
  });
  assert.equal(drifted.model.state, "differs");
  assert.equal(drifted.model.applied, "gpt-6-astra");
  assert.equal(drifted.reasoningEffort.state, "differs");
  assert.equal(drifted.sandbox.state, "differs");
  assert.equal(drifted.workingDir.state, "differs");
});

test("treats an effort Codex did not record as a difference only when one was asked for", async () => {
  const asked = await compareApplied(REQUESTED, {
    context: { cwd: "/workspace/project", model: "gpt-5.6-luna", effort: null, sandbox: "read-only", approvalPolicy: "never" },
    reason: null,
  });
  // Null effort means Codex used the model's own default, which is not what
  // "low" asked for.
  assert.equal(asked.reasoningEffort.state, "differs");
  assert.equal(asked.reasoningEffort.applied, null);

  const unasked = await compareApplied(
    { ...REQUESTED, reasoningEffort: null },
    {
      context: { cwd: "/workspace/project", model: "gpt-5.6-luna", effort: null, sandbox: "read-only", approvalPolicy: "never" },
      reason: null,
    },
  );
  assert.equal(unasked.reasoningEffort.state, "confirmed");
});

test("reports a sandbox value it does not recognise as unconfirmed", async () => {
  const applied = await compareApplied(REQUESTED, {
    context: { cwd: "/workspace/project", model: "gpt-5.6-luna", effort: "low", sandbox: "container-write", approvalPolicy: "never" },
    reason: null,
  });
  assert.equal(applied.sandbox.state, "unconfirmed");
  assert.equal(applied.sandbox.applied, "container-write");
});

test("marks every field unconfirmed when nothing could be read", async () => {
  const applied = await compareApplied(REQUESTED, { context: null, reason: "no session file was found" });
  assert.equal(applied.source, null);
  assert.equal(applied.reason, "no session file was found");
  for (const field of [applied.model, applied.reasoningEffort, applied.sandbox, applied.workingDir]) {
    assert.equal(field.state, "unconfirmed");
    assert.equal(field.applied, null);
  }
});

test("compares directories the way the filesystem does", async () => {
  const real = mkdtempSync(join(tmpdir(), "codex-subagent-cwd-"));
  try {
    const context = {
      cwd: process.platform === "win32" ? real.toUpperCase() : real,
      model: "gpt-5.6-luna",
      effort: "low",
      sandbox: "read-only",
      approvalPolicy: "never",
    };
    // Windows paths are case-insensitive, and macOS resolves the temporary
    // directory through a symlink; neither is a change of directory.
    const applied = await compareApplied({ ...REQUESTED, workingDir: real }, { context, reason: null });
    assert.equal(applied.workingDir.state, "confirmed");
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});

test("falls back to ~/.codex when CODEX_HOME is unset or blank", () => {
  assert.equal(codexHomeDir({ CODEX_HOME: "/custom/home" }), "/custom/home");
  assert.match(codexHomeDir({}), /[\\/]\.codex$/);
  assert.match(codexHomeDir({ CODEX_HOME: "   " }), /[\\/]\.codex$/);
});

test("AC-2 (#98) reads a turn context recorded by codex-cli 0.159.2", async () => {
  const home = createCodexHome();
  try {
    home.write({ threadId: "thread-0159", day: "2026-09-30", lines: [SESSION_META, REAL_TURN_CONTEXT_0159] });
    const { context, reason } = await lookupIn(home, "thread-0159");
    assert.equal(reason, null);
    assert.deepEqual(context, {
      cwd: "/workspace/project",
      model: "gpt-5.6-luna",
      effort: "low",
      sandbox: "read-only",
      approvalPolicy: "never",
    });
  } finally {
    home.dispose();
  }
});

test("reads a turn context recorded by codex-cli 0.160.0", async () => {
  const home = createCodexHome();
  try {
    home.write({ threadId: "thread-0160", day: "2026-10-01", lines: [SESSION_META, REAL_TURN_CONTEXT_0160] });
    const { context, reason } = await lookupIn(home, "thread-0160");
    assert.equal(reason, null);
    assert.deepEqual(context, {
      cwd: "/workspace/project",
      model: "gpt-5.6-luna",
      effort: "low",
      sandbox: "read-only",
      approvalPolicy: "never",
    });
  } finally {
    home.dispose();
  }
});

test("AC-2 (#187) reads a workspace-write turn context recorded by codex-cli 0.163.0", async () => {
  const home = createCodexHome();
  try {
    home.write({ threadId: "thread-0163-write", day: "2026-10-19", lines: [SESSION_META, REAL_TURN_CONTEXT_0163_WRITE] });
    const { context, reason } = await lookupIn(home, "thread-0163-write");
    assert.equal(reason, null);
    assert.deepEqual(context, {
      cwd: "/workspace/project",
      model: "gpt-5.6-luna",
      effort: "low",
      sandbox: "workspace-write",
      approvalPolicy: "never",
    });
  } finally {
    home.dispose();
  }
});

// #150: the commit a use_worktree run's worktree was made from, read from the session file (ADR 26).

/** session_meta recorded by codex-cli 0.154.0. Base instructions, account ids, paths and remote replaced. */
const REAL_SESSION_META_0154 =
  "{\"timestamp\":\"2026-09-21T19:37:10.828Z\",\"ordinal\":0,\"type\":\"session_meta\",\"payload\":{\"session_id\":\"01a0c578-e879-7453-94ae-2b35721751d2\",\"id\":\"01a0c578-e879-7453-94ae-2b35721751d2\",\"timestamp\":\"2026-09-21T19:37:10.570Z\",\"cwd\":\"/workspace/project\",\"originator\":\"codex_exec\",\"cli_version\":\"0.154.0\",\"source\":\"exec\",\"thread_source\":\"user\",\"model_provider\":\"openai\",\"base_instructions\":{\"text\":\"(omitted)\",\"provenance\":{\"type\":\"model\",\"model\":\"gpt-5.6-sol\"}},\"history_mode\":\"paginated\",\"context_window\":{\"window_id\":\"01a0c578-e879-7453-94ae-2b49f1370995\"},\"git\":{\"commit_hash\":\"e5d8e2babb467cbd86582939679ddf5f8bb86333\",\"branch\":\"main\",\"repository_url\":\"git@github.com:example/project.git\"}}}";

/** session_meta recorded by codex-cli 0.159.2. Base instructions, account ids, paths and remote replaced. */
const REAL_SESSION_META_0159 =
  "{\"timestamp\":\"2026-10-02T00:07:25.197Z\",\"ordinal\":0,\"type\":\"session_meta\",\"payload\":{\"creator_user_id\":\"user-00000000000000000000000\",\"creator_account_id\":\"00000000-0000-0000-0000-000000000000\",\"session_id\":\"01a0f9ef-ea9b-74a0-b3d6-af6452cf7cb7\",\"id\":\"01a0f9ef-ea9b-74a0-b3d6-af6452cf7cb7\",\"timestamp\":\"2026-10-02T00:07:25.120Z\",\"cwd\":\"/workspace/project\",\"runtime_workspace_roots\":[\"/workspace/project\"],\"originator\":\"codex_exec\",\"cli_version\":\"0.159.2\",\"source\":\"exec\",\"thread_source\":\"user\",\"model_provider\":\"openai\",\"base_instructions\":{\"text\":\"(omitted)\",\"provenance\":{\"type\":\"model\",\"model\":\"gpt-6.1-sol\"}},\"history_mode\":\"paginated\",\"context_window\":{\"window_id\":\"01a0f9ef-ea9d-73f2-9de3-21f85a2a1431\"},\"git\":{\"commit_hash\":\"63ba9288fac849994b09c370dca1750fddcf80ea\",\"branch\":\"test/inheritance-override-readback\",\"repository_url\":\"git@github.com:example/project.git\"}}}";

/** session_meta recorded by codex-cli 0.159.2 outside a git repository. Base instructions, account ids, paths and remote replaced. */
const REAL_SESSION_META_0159_NO_GIT =
  "{\"timestamp\":\"2026-10-02T00:08:59.479Z\",\"ordinal\":0,\"type\":\"session_meta\",\"payload\":{\"creator_user_id\":\"user-00000000000000000000000\",\"creator_account_id\":\"00000000-0000-0000-0000-000000000000\",\"session_id\":\"01a0f9f1-5b2a-7301-a6e2-fcca977897fa\",\"id\":\"01a0f9f1-5b2a-7301-a6e2-fcca977897fa\",\"timestamp\":\"2026-10-02T00:08:59.437Z\",\"cwd\":\"/tmp/scratch\",\"runtime_workspace_roots\":[\"/tmp/scratch\"],\"originator\":\"codex_exec\",\"cli_version\":\"0.159.2\",\"source\":\"exec\",\"thread_source\":\"user\",\"model_provider\":\"openai\",\"base_instructions\":{\"text\":\"(omitted)\",\"provenance\":{\"type\":\"model\",\"model\":\"gpt-5.6-luna\"}},\"history_mode\":\"paginated\",\"context_window\":{\"window_id\":\"01a0f9f1-5b2c-7ef3-97a9-425696bbeb93\"}}}";

/** session_meta recorded by codex-cli 0.160.0. Base instructions, account ids, paths and remote replaced. */
const REAL_SESSION_META_0160 =
  "{\"timestamp\":\"2026-10-02T18:15:13.266Z\",\"ordinal\":0,\"type\":\"session_meta\",\"payload\":{\"creator_user_id\":\"user-00000000000000000000000\",\"creator_account_id\":\"00000000-0000-0000-0000-000000000000\",\"session_id\":\"01a0fdd3-d387-7730-b89e-85f58165d1a8\",\"id\":\"01a0fdd3-d387-7730-b89e-85f58165d1a8\",\"timestamp\":\"2026-10-02T18:15:13.090Z\",\"cwd\":\"/workspace/project\",\"runtime_workspace_roots\":[\"/workspace/project\"],\"originator\":\"codex_exec\",\"cli_version\":\"0.160.0\",\"source\":\"exec\",\"thread_source\":\"user\",\"model_provider\":\"openai\",\"base_instructions\":{\"text\":\"(omitted)\",\"provenance\":{\"type\":\"model\",\"model\":\"gpt-6.1-sol\"}},\"history_mode\":\"paginated\",\"context_window\":{\"window_id\":\"01a0fdd3-d397-78c3-9f66-e1da4a240dc8\"},\"git\":{\"commit_hash\":\"26676c3635426bd3c6d864b2d09fcee3bfc52ef4\",\"branch\":\"main\",\"repository_url\":\"git@github.com:example/project.git\"}}}";

/** session_meta recorded by codex-cli 0.162.0 in a use_worktree run. Base instructions, account ids, paths and remote replaced. */
const REAL_SESSION_META_0162_WORKTREE =
  "{\"timestamp\":\"2026-10-08T21:49:12.732Z\",\"ordinal\":0,\"type\":\"session_meta\",\"payload\":{\"creator_user_id\":\"user-00000000000000000000000\",\"creator_account_id\":\"00000000-0000-0000-0000-000000000000\",\"session_id\":\"01a11d7d-e5c4-7cb3-8087-b6a057595717\",\"id\":\"01a11d7d-e5c4-7cb3-8087-b6a057595717\",\"timestamp\":\"2026-10-08T21:49:12.559Z\",\"cwd\":\"/home/user/.codex/worktrees/425f/project\",\"runtime_workspace_roots\":[\"/home/user/.codex/worktrees/425f/project\"],\"originator\":\"codex_exec\",\"cli_version\":\"0.162.0\",\"source\":\"exec\",\"thread_source\":\"user\",\"model_provider\":\"openai\",\"base_instructions\":{\"text\":\"(omitted)\",\"provenance\":{\"type\":\"model\",\"model\":\"gpt-6-luna\"}},\"history_mode\":\"paginated\",\"context_window\":{\"window_id\":\"01a11d7d-e5c7-7fd3-b22d-74a7b4d9cd1c\"},\"git\":{\"commit_hash\":\"0b3396c23a5985c6c308b77566e3b7fa6dd2756b\"}}}";

/** The same 0.160.0 line with its `git` object replaced, for shapes no pinned version recorded. */
function sessionMetaWithGit(git: unknown): string {
  const line = JSON.parse(REAL_SESSION_META_0160) as { payload: Record<string, unknown> };
  line.payload.git = git;
  return JSON.stringify(line);
}

test("AC-7 (#150) reads the base commit from session_meta lines recorded by each pinned codex-cli", () => {
  assert.equal(parseSessionMetaCommit(REAL_SESSION_META_0154), "e5d8e2babb467cbd86582939679ddf5f8bb86333");
  assert.equal(parseSessionMetaCommit(REAL_SESSION_META_0159), "63ba9288fac849994b09c370dca1750fddcf80ea");
  assert.equal(parseSessionMetaCommit(REAL_SESSION_META_0160), "26676c3635426bd3c6d864b2d09fcee3bfc52ef4");
  // A worktree is detached, so the line carries the commit and no branch.
  assert.equal(parseSessionMetaCommit(REAL_SESSION_META_0162_WORKTREE), "0b3396c23a5985c6c308b77566e3b7fa6dd2756b");
});

test("AC-7 (#150) accepts a SHA-256 object name as well as a SHA-1 one", () => {
  const sha256 = "a".repeat(64);
  assert.equal(parseSessionMetaCommit(sessionMetaWithGit({ commit_hash: sha256 })), sha256);
});

test("AC-7 (#150) leaves the base commit unconfirmed when session_meta does not carry a usable one", () => {
  // Outside a git repository 0.159.2 records no `git` at all, and 0.160.1 an empty object.
  assert.equal(parseSessionMetaCommit(REAL_SESSION_META_0159_NO_GIT), null);
  assert.equal(parseSessionMetaCommit(sessionMetaWithGit({})), null);
  assert.equal(parseSessionMetaCommit(sessionMetaWithGit(null)), null);
  assert.equal(parseSessionMetaCommit(sessionMetaWithGit({ commit_hash: "" })), null);
  assert.equal(parseSessionMetaCommit(sessionMetaWithGit({ commit_hash: 42 })), null);
  assert.equal(parseSessionMetaCommit(sessionMetaWithGit({ commit_hash: "0b3396c" })), null);
  assert.equal(parseSessionMetaCommit(sessionMetaWithGit({ commit_hash: "z".repeat(40) })), null);
  assert.equal(parseSessionMetaCommit(sessionMetaWithGit({ commit_hash: `${"a".repeat(40)}\nInjected` })), null);
  assert.equal(parseSessionMetaCommit(REAL_SESSION_META_0160.slice(0, 200)), null);
  assert.equal(parseSessionMetaCommit(""), null);
});

test("AC-7 (#150) accepts only a full lowercase object name of 40 or 64 characters", () => {
  for (const length of [39, 41, 63, 65]) {
    assert.equal(parseSessionMetaCommit(sessionMetaWithGit({ commit_hash: "a".repeat(length) })), null, `length ${length}`);
  }
  assert.equal(parseSessionMetaCommit(sessionMetaWithGit({ commit_hash: "A".repeat(40) })), null);
  assert.equal(parseSessionMetaCommit(sessionMetaWithGit({ commit_hash: `0B3396C${"a".repeat(33)}` })), null);
  assert.equal(parseSessionMetaCommit(sessionMetaWithGit({ commit_hash: ` ${"a".repeat(40)}` })), null);
});

test("AC-7 (#150) reads the commit only from a session_meta envelope", () => {
  const line = JSON.parse(REAL_SESSION_META_0160) as Record<string, unknown>;
  assert.equal(parseSessionMetaCommit(JSON.stringify({ ...line, type: "turn_context" })), null);
  assert.equal(parseSessionMetaCommit(JSON.stringify({ ...line, type: "response_item" })), null);
  assert.equal(parseSessionMetaCommit(JSON.stringify({ ...line, type: null })), null);
  const { type: _type, ...withoutType } = line;
  assert.equal(parseSessionMetaCommit(JSON.stringify(withoutType)), null);
});

test("AC-7 (#150) ignores a line that only mentions session_meta in its text", () => {
  assert.equal(
    parseSessionMetaCommit(
      '{"type":"item.completed","item":{"type":"agent_message","text":"session_meta git commit_hash 0b3396c23a5985c6c308b77566e3b7fa6dd2756b"}}',
    ),
    null,
  );
  assert.equal(parseSessionMetaCommit(REAL_TURN_CONTEXT), null);
});

test("AC-2 (#150) reads the base commit when the session file recorded no turn context", async () => {
  const home = createCodexHome();
  try {
    home.write({ threadId: "meta-only", day: "2026-10-08", lines: [REAL_SESSION_META_0162_WORKTREE] });
    const lookup = await lookupIn(home, "meta-only");
    assert.equal(lookup.context, null);
    assert.match(lookup.reason ?? "", /no turn context/);
    assert.equal(lookup.baseCommit, "0b3396c23a5985c6c308b77566e3b7fa6dd2756b");
  } finally {
    home.dispose();
  }
});

test("AC-2 (#150) reads the turn context when session_meta carries no base commit", async () => {
  const home = createCodexHome();
  try {
    home.write({ threadId: "context-only", day: "2026-10-01", lines: [REAL_SESSION_META_0159_NO_GIT, REAL_TURN_CONTEXT_0159] });
    const lookup = await lookupIn(home, "context-only");
    assert.equal(lookup.context?.cwd, "/workspace/project");
    assert.equal(lookup.baseCommit ?? null, null);
  } finally {
    home.dispose();
  }
});

test("AC-2 (#150) reads both from one session file", async () => {
  const home = createCodexHome();
  try {
    home.write({
      threadId: "both",
      day: "2026-10-08",
      // The two lines name different directories, and the commit is not one any other test uses, so
      // the test tells which line each value came from.
      lines: [
        sessionMetaWithGit({ commit_hash: "1f0d1f0d1f0d1f0d1f0d1f0d1f0d1f0d1f0d1f0d" }),
        turnContext({ cwd: "/home/user/.codex/worktrees/9ef9/project" }),
      ],
    });
    const lookup = await lookupIn(home, "both");
    assert.equal(lookup.context?.cwd, "/home/user/.codex/worktrees/9ef9/project");
    assert.equal(lookup.baseCommit, "1f0d1f0d1f0d1f0d1f0d1f0d1f0d1f0d1f0d1f0d");
  } finally {
    home.dispose();
  }
});

test("AC-2 (#150) keeps the base commit when the turn context is malformed", async () => {
  const home = createCodexHome();
  try {
    home.write({
      threadId: "malformed-context",
      day: "2026-10-08",
      lines: [REAL_SESSION_META_0162_WORKTREE, '{"type":"turn_context","payload":{"cwd":'],
    });
    const lookup = await lookupIn(home, "malformed-context");
    assert.equal(lookup.context, null);
    assert.equal(lookup.baseCommit, "0b3396c23a5985c6c308b77566e3b7fa6dd2756b");
  } finally {
    home.dispose();
  }
});

test("AC-2 (#150) keeps the turn context when session_meta is malformed", async () => {
  const home = createCodexHome();
  try {
    home.write({
      threadId: "malformed-meta",
      day: "2026-10-01",
      lines: ['{"type":"session_meta","payload":', REAL_TURN_CONTEXT_0159],
    });
    const lookup = await lookupIn(home, "malformed-meta");
    assert.equal(lookup.context?.cwd, "/workspace/project");
    assert.equal(lookup.baseCommit ?? null, null);
  } finally {
    home.dispose();
  }
});

test("AC-2 (#150) leaves both unconfirmed when there is no session file", async () => {
  const home = createCodexHome();
  try {
    const lookup = await lookupIn(home, "absent");
    assert.equal(lookup.context, null);
    assert.equal(lookup.baseCommit ?? null, null);
  } finally {
    home.dispose();
  }
});

/**
 * The record that closes a turn (#158, ADR 30). Only its `turn_id`, `error.codex_error_info` and the
 * envelope's `timestamp` are read; the real lines keep everything else so a parser that works only
 * on trimmed input fails here.
 */
test("AC-1 (#158) reads the capacity record codex-cli 0.160.1 wrote", () => {
  assert.deepEqual(parseTaskCompleteLine(CAPACITY_0160), {
    turnId: CAPACITY_0160_TURN,
    errorInfo: "server_overloaded",
    writtenAtMs: Date.parse("2026-10-07T21:34:49.758Z"),
  });
});

test("AC-2 (#158) reads the usage-limit record codex-cli 0.162.1 wrote", () => {
  assert.deepEqual(parseTaskCompleteLine(USAGE_LIMIT_0162), {
    turnId: USAGE_LIMIT_0162_TURN,
    errorInfo: "usage_limit_exceeded",
    writtenAtMs: Date.parse("2026-10-16T18:39:49.097Z"),
  });
});

test("AC-2 (#158) reads the usage-limit record codex-cli 0.154.0 wrote", () => {
  assert.deepEqual(parseTaskCompleteLine(USAGE_LIMIT_0154), {
    turnId: USAGE_LIMIT_0154_TURN,
    errorInfo: "usage_limit_exceeded",
    writtenAtMs: Date.parse("2026-09-14T18:56:41.853Z"),
  });
});

test("AC-2 (#158) reads no error from the record of a turn that succeeded (0.163.0)", () => {
  assert.deepEqual(parseTaskCompleteLine(THREAD_0163.followUp), {
    turnId: THREAD_0163_FOLLOW_UP_TURN,
    errorInfo: null,
    writtenAtMs: Date.parse("2026-10-19T20:33:41.288Z"),
  });
});

test("AC-3 (#158) reads nothing it cannot trust from a malformed record", () => {
  const record = (payload: Record<string, unknown>, timestamp: unknown = "2026-10-07T21:34:49.758Z") =>
    JSON.stringify({ timestamp, type: "event_msg", payload: { type: "task_complete", ...payload } });
  const overloaded = { error: { message: "at capacity", codex_error_info: "server_overloaded" } };

  for (const line of [
    "",
    "not json",
    '{"type":"event_msg","payload":{"type":"task_complete"',
    // A record of another kind, and a turn context, are not a turn's end.
    JSON.stringify({ timestamp: "2026-10-07T21:34:49.758Z", type: "event_msg", payload: { type: "turn_aborted", turn_id: "t", reason: "interrupted" } }),
    THREAD_0163.failedContext,
    // Without a turn id the record cannot be tied to a turn; without a timestamp, to a run.
    record(overloaded),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t", ...overloaded } }),
    record({ turn_id: "t", ...overloaded }, null),
    record({ turn_id: "t", ...overloaded }, "yesterday"),
    record({ turn_id: 42, ...overloaded }),
  ]) {
    assert.equal(parseTaskCompleteLine(line), null, line);
  }

  // A value that is not text is no value; whether the record is kept is the parser's choice.
  for (const error of [{ codex_error_info: 42 }, { codex_error_info: { kind: "server_overloaded" } }, "server_overloaded"]) {
    const parsed = parseTaskCompleteLine(record({ turn_id: "t", error }));
    assert.equal(parsed?.errorInfo ?? null, null, JSON.stringify(error));
  }
});

test("AC-4 (#158) takes the record of the latest turn, not an earlier capacity failure", async () => {
  const home = createCodexHome();
  try {
    home.write({
      threadId: "resumed",
      day: "2026-10-07",
      lines: [
        SESSION_META,
        turnContext({ turn_id: CAPACITY_0160_TURN }),
        CAPACITY_0160,
        THREAD_0163.failedContext,
        THREAD_0163.failed,
      ],
    });
    const lookup = await lookupIn(home, "resumed");
    assert.equal(lookup.completion?.turnId, THREAD_0163_FAILED_TURN);
    assert.equal(lookup.completion?.errorInfo, "other");
  } finally {
    home.dispose();
  }
});

test("AC-4 (#158) reads the 0.163.0 thread of a failed turn and its follow-up", async () => {
  const home = createCodexHome();
  try {
    home.write({
      threadId: "followed-up",
      day: "2026-10-19",
      lines: [SESSION_META, THREAD_0163.failedContext, THREAD_0163.failed, THREAD_0163.followUpContext, THREAD_0163.followUp],
    });
    const lookup = await lookupIn(home, "followed-up");
    assert.deepEqual(lookup.completion, {
      turnId: THREAD_0163_FOLLOW_UP_TURN,
      errorInfo: null,
      writtenAtMs: Date.parse("2026-10-19T20:33:41.288Z"),
    });
  } finally {
    home.dispose();
  }
});

test("AC-3 (#158) finds no record when the latest turn has none, whatever an earlier turn says", async () => {
  const home = createCodexHome();
  try {
    home.write({
      threadId: "unfinished",
      day: "2026-10-07",
      lines: [SESSION_META, turnContext({ turn_id: CAPACITY_0160_TURN }), CAPACITY_0160, THREAD_0163.followUpContext],
    });
    const lookup = await lookupIn(home, "unfinished");
    // The file was read: the turn context is there, and its turn has no record.
    assert.equal(lookup.context?.model, "gpt-5.6-luna");
    assert.strictEqual(lookup.completion, null);
  } finally {
    home.dispose();
  }
});
