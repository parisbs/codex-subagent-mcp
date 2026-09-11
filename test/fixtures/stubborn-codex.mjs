#!/usr/bin/env node
/**
 * A fake Codex CLI that ignores SIGTERM.
 *
 * Used to exercise the runner's timeout path: SIGTERM is sent first, and only a
 * process that refuses it proves the SIGKILL escalation actually happens.
 */
process.on("SIGTERM", () => {});

process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "stub-thread" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);

// Outlive any sane test timeout; the runner is expected to kill this.
setInterval(() => {}, 1000);
