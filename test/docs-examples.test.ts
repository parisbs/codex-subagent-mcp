import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// #196: any concrete slug in a configuration example goes stale with the next catalog.

const SLUG = /\bgpt-\d[\w.-]*/;

function doc(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

for (const path of ["README.md", "docs/TOOLS.md", "docs/CONTROL.md"]) {
  test(`AC-7 ${path} configures the default model with a placeholder, not a slug`, () => {
    const text = doc(path);
    const lines = text.split("\n").filter((line) => line.includes("CODEX_SUBAGENT_DEFAULT_MODEL="));
    for (const line of lines) {
      assert.doesNotMatch(line, SLUG, `${path} names a slug: ${line.trim()}`);
    }
    assert.match(text, /list_codex_models/, `${path} does not point to list_codex_models for the slug`);
  });
}

test("AC-7 docs/CONTROL.md names no concrete slug, including its instruction example", () => {
  const text = doc("docs/CONTROL.md");
  const named = text.split("\n").filter((line) => SLUG.test(line));
  assert.deepEqual(named, [], `docs/CONTROL.md names a slug:\n${named.join("\n")}`);
});
