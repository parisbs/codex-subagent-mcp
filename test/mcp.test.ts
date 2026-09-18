import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";

let listedCwd: string | undefined;
let listFailure: Error | undefined;

const fakeExecFile = async (
  _file: string,
  _args: string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> => {
  listedCwd = options?.cwd;
  if (listFailure) throw listFailure;
  return { stdout: "[]", stderr: "" };
};

cp.execFile = (() => {}) as unknown as typeof cp.execFile;
(cp.execFile as unknown as Record<symbol, unknown>)[promisify.custom] = fakeExecFile;
syncBuiltinESMExports();

const { findSelfReferences, selfRegisteredServers } = await import("../src/codex/mcp.ts");

// Shaped after `codex mcp list --json` on codex-cli 0.154.0.
const entry = (name: string, command: string, args: string[] = []) => ({
  name,
  enabled: true,
  disabled_reason: null,
  transport: { type: "stdio", command, args, env: null, env_vars: [], cwd: null },
  startup_timeout_sec: 10,
  tool_timeout_sec: null,
  auth_status: "unsupported",
});

test("finds this server however it was registered in Codex", () => {
  const list = JSON.stringify([
    entry("via-npx", "npx", ["-y", "codex-subagent-mcp"]),
    entry("via-bin", "/usr/local/bin/codex-subagent"),
    entry("windows-shim", "C:\\Users\\x\\AppData\\Roaming\\npm\\codex-subagent.cmd"),
    entry("from-clone", "node", ["/home/x/src/my-fork/build/index.js"]),
    entry("unrelated", "node", ["/opt/other-mcp/index.js"]),
    entry("similar-name", "node", ["/opt/codex-subagent-helper/index.js"]),
  ]);

  assert.deepEqual(findSelfReferences(list, "/home/x/src/my-fork/build/index.js"), [
    "via-npx",
    "via-bin",
    "windows-shim",
    "from-clone",
  ]);
});

test("returns nothing for output it cannot read", () => {
  assert.deepEqual(findSelfReferences("not json", undefined), []);
  assert.deepEqual(findSelfReferences('{"name":"x"}', undefined), []);
  assert.deepEqual(findSelfReferences(JSON.stringify([null, { name: 3 }, { name: "no-transport" }]), undefined), []);
});

test("does not mistake a differently named copy for this server", () => {
  const list = JSON.stringify([
    entry("renamed-copy", "node", ["/opt/renamed-copy/build/index.js"]),
  ]);

  assert.deepEqual(findSelfReferences(list, "/opt/original/build/index.js"), []);
});

test("lists Codex MCP servers in the requested directory", async () => {
  listedCwd = undefined;
  listFailure = undefined;

  const result = await selfRegisteredServers({ codexPath: process.execPath, cwd: tmpdir() });

  assert.equal(listedCwd, tmpdir());
  assert.deepEqual(result, { names: [], error: null });
});

test("returns a reportable failure without throwing when the listing fails", async () => {
  listedCwd = undefined;
  listFailure = new Error("listing unavailable");

  const result = await selfRegisteredServers({ codexPath: process.execPath, cwd: tmpdir() });

  assert.equal(listedCwd, tmpdir());
  assert.deepEqual(result, { names: [], error: "listing unavailable" });
  listFailure = undefined;
});
