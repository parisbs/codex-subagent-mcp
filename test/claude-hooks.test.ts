import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { changelogRefusal } from "../.claude/hooks/changelog-guard.mjs";
import { buildFreshnessWarning } from "../.claude/hooks/build-freshness.mjs";

const root = join("/repo");

test("the changelog guard refuses CHANGELOG.md at the root off a release branch", () => {
  const reason = changelogRefusal({ filePath: join(root, "CHANGELOG.md"), repoRoot: root, branch: "feature/x" });
  assert.match(reason, /release\/ or hotfix\//);
  assert.match(reason, /feature\/x/);
});

test("the changelog guard allows release and hotfix branches", () => {
  for (const branch of ["release/0.6.0", "hotfix/0.6.1"]) {
    assert.equal(changelogRefusal({ filePath: join(root, "CHANGELOG.md"), repoRoot: root, branch }), null);
  }
});

test("the changelog guard names a detached HEAD", () => {
  assert.match(changelogRefusal({ filePath: join(root, "CHANGELOG.md"), repoRoot: root, branch: null }), /detached HEAD/);
});

test("the changelog guard ignores other files and nested changelogs", () => {
  assert.equal(changelogRefusal({ filePath: join(root, "README.md"), repoRoot: root, branch: "main" }), null);
  assert.equal(changelogRefusal({ filePath: join(root, "docs", "CHANGELOG.md"), repoRoot: root, branch: "main" }), null);
});

test("the changelog guard lets an edit through when the repository is unknown", () => {
  assert.equal(changelogRefusal({ filePath: join(root, "CHANGELOG.md"), repoRoot: null, branch: "main" }), null);
});

test("the changelog guard prints nothing for input it cannot read", () => {
  const result = spawnSync(process.execPath, [join(".claude", "hooks", "changelog-guard.mjs")], { input: "not json" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), "");
});

test("the build freshness warning speaks only for a missing or older build", () => {
  assert.equal(buildFreshnessWarning({ buildMs: 2, srcMs: 1 }), null);
  assert.equal(buildFreshnessWarning({ buildMs: 1, srcMs: 1 }), null);
  assert.match(buildFreshnessWarning({ buildMs: 1, srcMs: 2 }), /older than src/);
  assert.match(buildFreshnessWarning({ buildMs: null, srcMs: 2 }), /missing/);
  assert.equal(buildFreshnessWarning({ buildMs: null, srcMs: null }), null);
});

test("the project settings run both hooks", () => {
  const settings = JSON.parse(readFileSync(join(".claude", "settings.json"), "utf8"));
  const commands = JSON.stringify(settings.hooks);
  assert.match(commands, /changelog-guard\.mjs/);
  assert.match(commands, /build-freshness\.mjs/);
});
