#!/usr/bin/env node
// SessionStart hook: `.mcp.json` runs this checkout's `build/index.js`, so a session started on a
// build older than `src/` exercises stale code without saying so. Prints one line only when that is
// the case; prints nothing, and never fails, otherwise.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The warning for a build at `buildMs` (null when missing) against sources last changed at `srcMs`. */
export function buildFreshnessWarning({ buildMs, srcMs }) {
  if (srcMs === null) return null;
  if (buildMs === null) {
    return "build/index.js is missing, so the codex-subagent server in .mcp.json cannot start: run " +
      "`npm run build`, then restart the session.";
  }
  if (buildMs >= srcMs) return null;
  return "build/ is older than src/, so the codex-subagent server in .mcp.json runs stale code: run " +
    "`npm run build`, then restart the session.";
}

function newestMtime(dir) {
  let newest = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    if (mtime !== null && (newest === null || mtime > newest)) newest = mtime;
  }
  return newest;
}

function mtimeOrNull(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const warning = buildFreshnessWarning({
      buildMs: mtimeOrNull(join(root, "build", "index.js")),
      srcMs: newestMtime(join(root, "src")),
    });
    if (warning) process.stdout.write(`${warning}\n`);
  } catch {
    // A hook that cannot read the tree has nothing useful to say.
  }
}
