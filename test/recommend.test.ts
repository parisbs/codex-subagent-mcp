import assert from "node:assert/strict";
import { test } from "node:test";

import { recommend } from "../src/recommend.ts";
import type { CodexCatalog } from "../src/types.ts";

const CATALOG: CodexCatalog = {
  stale: false,
  fetchedAt: new Date(0).toISOString(),
  models: [
    {
      slug: "gpt-6-astra",
      displayName: "GPT-6-Astra",
      description: "",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      contextWindow: 272000,
      maxContextWindow: 872000,
      priority: 1,
      supportsImages: true,
      supportsWebSearch: true,
    },
    {
      slug: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      description: "",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      contextWindow: 272000,
      maxContextWindow: 872000,
      priority: 6,
      supportsImages: true,
      supportsWebSearch: true,
    },
    {
      slug: "gpt-5.6-terra",
      displayName: "GPT-5.6-Terra",
      description: "",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      contextWindow: 272000,
      maxContextWindow: 872000,
      priority: 7,
      supportsImages: true,
      supportsWebSearch: true,
    },
    {
      slug: "gpt-5.6-luna",
      displayName: "GPT-5.6-Luna",
      description: "",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      contextWindow: 272000,
      maxContextWindow: 872000,
      priority: 8,
      supportsImages: true,
      supportsWebSearch: true,
    },
  ],
};

test("routes a mechanical edit to the fast model at low effort", () => {
  const suggestion = recommend(CATALOG, "Rename the userId variable and fix the lint errors");
  assert.equal(suggestion.tier, "mechanical");
  assert.equal(suggestion.model, "gpt-5.6-luna");
  assert.equal(suggestion.reasoningEffort, "low");
});

test("routes ordinary work to the balanced model at medium effort", () => {
  const suggestion = recommend(CATALOG, "Implement a new endpoint that returns the user profile");
  assert.equal(suggestion.tier, "standard");
  assert.equal(suggestion.model, "gpt-5.6-terra");
  assert.equal(suggestion.reasoningEffort, "medium");
});

test("routes a multi-file migration to the agentic tier", () => {
  const suggestion = recommend(
    CATALOG,
    "Migrate the whole test suite from Jest to Vitest across the codebase",
  );
  assert.equal(suggestion.tier, "agentic");
  assert.equal(suggestion.model, "gpt-5.6-sol");
  assert.equal(suggestion.reasoningEffort, "high");
});

test("routes a hard debugging problem to the most capable model", () => {
  const suggestion = recommend(
    CATALOG,
    "Find the root cause of a race condition in the connection pool",
  );
  assert.equal(suggestion.tier, "hard");
  assert.equal(suggestion.model, "gpt-6-astra");
  assert.equal(suggestion.reasoningEffort, "xhigh");
});

test("defaults to the standard tier when nothing matches", () => {
  const suggestion = recommend(CATALOG, "Do the thing we discussed");
  assert.equal(suggestion.tier, "standard");
});

test("raises effort when the caller prioritises quality", () => {
  const suggestion = recommend(CATALOG, "Implement the profile endpoint", "quality");
  assert.equal(suggestion.reasoningEffort, "high");
});

test("lowers effort when the caller prioritises cost", () => {
  const suggestion = recommend(CATALOG, "Implement the profile endpoint", "cost");
  assert.equal(suggestion.reasoningEffort, "low");
});

test("never drops below low effort, however cheap the caller wants it", () => {
  const suggestion = recommend(CATALOG, "Fix a typo in the changelog", "cost");
  assert.equal(suggestion.reasoningEffort, "low");
});

test("substitutes an alternative when the preferred model is absent", () => {
  const reduced: CodexCatalog = {
    ...CATALOG,
    models: CATALOG.models.filter((model) => model.slug !== "gpt-5.6-luna"),
  };
  const suggestion = recommend(reduced, "Fix a typo in the changelog");
  assert.equal(suggestion.model, "gpt-5.6-terra");
  assert.match(suggestion.adjustment ?? "", /not in the installed catalog/);
});

test("clamps the effort to what the substituted model supports", () => {
  const onlyLuna: CodexCatalog = {
    ...CATALOG,
    models: CATALOG.models.filter((model) => model.slug === "gpt-5.6-luna"),
  };
  const suggestion = recommend(onlyLuna, "Build the whole system from scratch");
  assert.equal(suggestion.model, "gpt-5.6-luna");
  assert.equal(suggestion.reasoningEffort, "max");
  assert.match(suggestion.adjustment ?? "", /does not support reasoning effort "ultra"/);
});

test("fails loudly on an empty catalog", () => {
  assert.throws(
    () => recommend({ ...CATALOG, models: [] }, "anything"),
    /catalog is empty/,
  );
});
