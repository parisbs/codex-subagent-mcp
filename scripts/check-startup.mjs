#!/usr/bin/env node
/**
 * Starts the server and asserts it comes up on stdio and shuts down cleanly,
 * with no Codex CLI present.
 *
 * The preflight must run per tool call, never at startup: a server that probed
 * the CLI while connecting would fail to register at all on a machine without
 * Codex, and the user would never see the diagnosis explaining why.
 *
 * Takes an optional path to the executable to start, so the same check can be
 * pointed at the built tree during development and at an installed package's
 * bin entry in CI.
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";

const TIMEOUT_MS = 15_000;

const target = process.argv[2];

if (target) {
  // `tsc` does not set the executable bit; npm sets it when it links a bin.
  // Pointing this at an unlinked build/index.js gives a bare EACCES, so say
  // what is actually wrong.
  try {
    accessSync(target, constants.X_OK);
  } catch {
    console.error(
      `check-startup: "${target}" is not executable. Pass an installed bin ` +
        "(node_modules/.bin/codex-subagent), or pass no argument to run build/index.js with node.",
    );
    process.exit(1);
  }
}
const [command, args] = target
  ? [target, []]
  : [process.execPath, ["build/index.js"]];

const child = spawn(command, args, {
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
