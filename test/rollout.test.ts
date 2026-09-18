import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  codexHomeDir,
  compareApplied,
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
