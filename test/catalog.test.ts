import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyCatalogFailure, normaliseModel, parseCatalog, resolveEffort } from "../src/codex/catalog.ts";
import type { CodexModel, ReasoningEffort } from "../src/types.ts";

// Shaped after the real `codex debug models` payload, minus the ~350 KB of
// per-model system prompts the server discards.
const RAW = JSON.stringify({
  models: [
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      description: "Our most capable model for complex, demanding work.",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" },
      ],
      context_window: 272000,
      max_context_window: 872000,
      priority: 1,
      visibility: "list",
      input_modalities: ["text", "image"],
      supports_search_tool: true,
      base_instructions: "a very long system prompt that must be discarded",
    },
    {
      slug: "gpt-reserve",
      display_name: "GPT-Reserve",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "medium" }],
      visibility: "hide",
      priority: 3,
    },
    {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6-Luna",
      description: "Fast and affordable agentic coding model.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
      ],
      context_window: 272000,
      max_context_window: 872000,
      priority: 8,
      visibility: "list",
      input_modalities: ["text", "image"],
      supports_search_tool: true,
    },
  ],
});

test("drops hidden models and sorts by priority", () => {
  const models = parseCatalog(RAW);
  assert.deepEqual(
    models.map((model) => model.slug),
    ["gpt-6-astra", "gpt-5.6-luna"],
  );
});

test("discards the oversized instruction fields", () => {
  const model = parseCatalog(RAW)[0]!;
  assert.ok(!("base_instructions" in model));
  assert.equal(model.contextWindow, 272000);
  assert.equal(model.maxContextWindow, 872000);
  assert.equal(model.supportsImages, true);
  assert.equal(model.supportsWebSearch, true);
});

test("orders reasoning efforts from cheapest to most expensive", () => {
  const model = parseCatalog(RAW)[0]!;
  assert.deepEqual(model.supportedReasoningEfforts, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
});

test("rejects entries without a usable slug", () => {
  assert.equal(normaliseModel({ visibility: "list" }), null);
  assert.equal(normaliseModel(null), null);
  assert.equal(normaliseModel({ slug: "x", visibility: "hide" }), null);
});

test("keeps a supported effort untouched", () => {
  const astra = parseCatalog(RAW)[0]!;
  const resolved = resolveEffort(astra, "ultra");
  assert.equal(resolved.effort, "ultra");
  assert.equal(resolved.adjusted, false);
});

test("clamps an unsupported effort to the closest supported one", () => {
  const luna = parseCatalog(RAW)[1]!;
  const resolved = resolveEffort(luna, "ultra");
  assert.equal(resolved.effort, "max");
  assert.equal(resolved.adjusted, true);
  assert.match(resolved.reason ?? "", /does not support reasoning effort "ultra"/);
});

test("falls back to the model default when no effort is requested", () => {
  const luna = parseCatalog(RAW)[1]!;
  assert.deepEqual(resolveEffort(luna, undefined), {
    effort: "medium",
    adjusted: false,
  });
});

function modelWithEfforts(efforts: ReasoningEffort[]): CodexModel {
  return {
    ...parseCatalog(RAW)[0]!,
    slug: "test-model",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: efforts,
  };
}

test("refuses when no supported effort is at or below the ceiling", () => {
  const model = modelWithEfforts(["medium", "high"]);
  assert.throws(
    () => resolveEffort(model, "high", "low"),
    /test-model.*medium, high.*ceiling "low"/,
  );
});

test("chooses a supported effort below an unsupported ceiling", () => {
  const resolved = resolveEffort(modelWithEfforts(["low", "high"]), "high", "medium");
  assert.equal(resolved.effort, "low");
  assert.equal(resolved.adjusted, true);
  assert.match(resolved.reason ?? "", /ceiling "medium".*using "low"/);
});

test("keeps the existing cap when the model supports the ceiling", () => {
  const resolved = resolveEffort(modelWithEfforts(["low", "medium", "high"]), "high", "medium");
  assert.equal(resolved.effort, "medium");
  assert.equal(resolved.adjusted, true);
});

test("chooses the closest eligible effort rather than always using the ceiling", () => {
  const resolved = resolveEffort(modelWithEfforts(["low", "high"]), "medium", "high");
  assert.equal(resolved.effort, "low");
  assert.equal(resolved.adjusted, true);
});

test("resolves the model default against the supported efforts below the ceiling", () => {
  const resolved = resolveEffort(modelWithEfforts(["low", "high"]), undefined, "medium");
  assert.equal(resolved.effort, "low");
  assert.equal(resolved.adjusted, true);
  assert.match(resolved.reason ?? "", /"high".*ceiling "medium".*using "low"/);
});

test("preserves closest-match clamping and defaults without a ceiling", () => {
  const model = modelWithEfforts(["low", "high"]);
  assert.deepEqual(resolveEffort(model, "medium"), {
    effort: "low",
    adjusted: true,
    reason: 'test-model does not support reasoning effort "medium" (supported: low, high); using "low" instead.',
  });
  assert.deepEqual(resolveEffort(model, undefined), { effort: "high", adjusted: false });
});

test("validates an unsupported model default only when a ceiling is configured", () => {
  const model = { ...modelWithEfforts(["low", "medium"]), defaultReasoningEffort: "high" as const };
  assert.deepEqual(resolveEffort(model, undefined), { effort: "high", adjusted: false });
  const resolved = resolveEffort(model, undefined, "high");
  assert.equal(resolved.effort, "medium");
  assert.equal(resolved.adjusted, true);
});

test("tells a configuration failure of debug models from unusable output", () => {
  // Verbatim first lines of stderr on codex-cli 0.154.0.
  for (const stderr of [
    "Error: /tmp/home/config.toml:1:9: string values must be quoted, expected literal string\n",
    "Error: unknown variant `bogus`, expected one of `read-only`, `workspace-write`, `danger-full-access`\nin `sandbox_mode`\n",
    'Error: legacy `profile = "x"` config is no longer supported; use `--profile x` with `x.config.toml` instead\n',
    "Error: Model provider `oss` not found\n",
  ]) {
    assert.equal(classifyCatalogFailure({ stderr, code: 1 }), "configuration", stderr);
  }

  // An older CLI without the subcommand fails in argument parsing, lowercase.
  assert.equal(classifyCatalogFailure({ stderr: "error: unrecognized subcommand 'models'\n", code: 2 }), "unusable");
  assert.equal(classifyCatalogFailure(new SyntaxError("Unexpected token")), "unusable");
  assert.equal(classifyCatalogFailure({ killed: true, stderr: "" }), "unusable");
});
