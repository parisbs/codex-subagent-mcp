#!/usr/bin/env node
/**
 * Starts the built server and asserts it comes up on stdio and shuts down
 * cleanly, with no Codex CLI present.
 *
 * The preflight must run per tool call, never at startup: a server that probed
 * the CLI while connecting would fail to register at all on a machine without
 * Codex, and the user would never see the diagnosis explaining why.
 */
import { spawn } from "node:child_process";

const TIMEOUT_MS = 15_000;

const child = spawn(process.execPath, ["build/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  // Point at a binary that cannot exist, so this fails if startup needs Codex.
  env: { ...process.env, CODEX_BIN: "/nonexistent/codex" },
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const fail = (message) => {
  child.kill("SIGKILL");
  console.error(`check-startup: ${message}`);
  if (stderr.trim()) console.error(`stderr:\n${stderr.trim()}`);
  process.exit(1);
};

const timer = setTimeout(() => fail("the server did not announce itself in time"), TIMEOUT_MS);

child.on("error", (error) => fail(`could not spawn the server: ${error.message}`));

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (signal === "SIGTERM") return;
  fail(`the server exited early (code ${code}, signal ${signal})`);
});

const ready = setInterval(() => {
  if (!stderr.includes("running on stdio")) return;
  clearInterval(ready);
  clearTimeout(timer);
  child.kill("SIGTERM");
  console.log("check-startup: the server started and shut down cleanly without the Codex CLI.");
  process.exit(0);
}, 100);
