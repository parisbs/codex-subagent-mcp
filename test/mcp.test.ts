import assert from "node:assert/strict";
import { test } from "node:test";

import { findSelfReferences } from "../src/codex/mcp.ts";

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
