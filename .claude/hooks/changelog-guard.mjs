#!/usr/bin/env node
// PreToolUse hook: CHANGELOG.md is written only while a release is prepared, on a `release/` or
// `hotfix/` branch. Elsewhere a pull request describes its user-visible change in its own body, and
// per-branch changelog entries were the one recurring merge conflict between parallel branches.
// Any failure to decide lets the edit through: the hook guards a convention, not a secret.
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_BRANCH = /^(release|hotfix)\//;

/** The reason to refuse an edit of `filePath`, or null to let it through. */
export function changelogRefusal({ filePath, repoRoot, branch }) {
  if (!filePath || !repoRoot || basename(filePath) !== "CHANGELOG.md") return null;
  if (resolve(dirname(filePath)) !== resolve(repoRoot)) return null;
  if (branch && RELEASE_BRANCH.test(branch)) return null;
  return (
    `CHANGELOG.md changes only while a release is prepared, on a release/ or hotfix/ branch ` +
    `(current: ${branch ?? "detached HEAD"}). Describe the user-visible change in the pull request ` +
    "body instead; the release step compiles it."
  );
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function main(input) {
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== "string" || basename(filePath) !== "CHANGELOG.md") return;
  const dir = dirname(resolve(input.cwd ?? process.cwd(), filePath));
  const reason = changelogRefusal({
    filePath: resolve(input.cwd ?? process.cwd(), filePath),
    repoRoot: git(dir, ["rev-parse", "--show-toplevel"]),
    branch: git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]) || null,
  });
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    try {
      main(JSON.parse(raw));
    } catch {
      // Undecidable: let the edit through rather than block work on a hook failure.
    }
  });
}
