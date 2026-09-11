import assert from "node:assert/strict";
import { test } from "node:test";

import { normaliseModel, parseCatalog, resolveEffort } from "../src/codex/catalog.ts";

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
