import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseCatalog } from "../src/codex/catalog.ts";
import { recommend, type Priority } from "../src/recommend.ts";
import type { CodexCatalog, CodexModel, ReasoningEffort } from "../src/types.ts";

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

test("never suggests an effort above the configured ceiling", () => {
  // The hard tier asks for xhigh; a delegation would clamp it, so the advice must too.
  const suggestion = recommend(
    CATALOG,
    "Find the root cause of a race condition in the connection pool",
    "balanced",
    [],
    "medium",
  );
  assert.equal(suggestion.model, "gpt-6-astra");
  assert.equal(suggestion.reasoningEffort, "medium");
  assert.match(suggestion.adjustment ?? "", /ceiling "medium"/);
});

test("skips a model with no effort at or below the ceiling", () => {
  const catalog: CodexCatalog = {
    ...CATALOG,
    models: CATALOG.models.map((model) =>
      model.slug === "gpt-5.6-luna"
        ? { ...model, supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }
        : model,
    ),
  };
  const suggestion = recommend(catalog, "Fix a typo in the changelog", "balanced", [], "low");
  assert.equal(suggestion.model, "gpt-5.6-terra");
  assert.equal(suggestion.reasoningEffort, "low");
  assert.match(suggestion.adjustment ?? "", /gpt-5\.6-luna supports no reasoning effort at or below the ceiling "low"/);
});

test("refuses to recommend when no model has an effort under the ceiling", () => {
  assert.throws(
    () => recommend(CATALOG, "Implement the profile endpoint", "balanced", [], "minimal"),
    /ceiling "minimal"/,
  );
});

// ---------------------------------------------------------------------------
// #196: recommend current catalog models instead of fixed slugs.
// ---------------------------------------------------------------------------

const ALL_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const EFFORT_LEVELS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const PRIORITIES: Priority[] = ["quality", "balanced", "latency", "cost"];

function model(slug: string, priority: number, description = ""): CodexModel {
  return {
    slug,
    displayName: slug,
    description,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [...ALL_EFFORTS],
    contextWindow: 272000,
    maxContextWindow: 872000,
    priority,
    supportsImages: true,
    supportsWebSearch: true,
  };
}

function catalogOf(...models: CodexModel[]): CodexCatalog {
  return { stale: false, fetchedAt: new Date(0).toISOString(), models };
}

/** The visible models of the 2026-11-10 catalog, by the same slugs and priorities. */
const CURRENT = [
  model("gpt-6.1-sol", 1),
  model("gpt-6-astra", 2),
  model("gpt-6.1-terra", 3),
  model("gpt-6-sol", 4),
  model("gpt-6-luna", 6),
  model("gpt-5.6-sol", 7),
  model("gpt-5.6-terra", 8),
  model("gpt-5.6-luna", 9),
];

/** One task description per tier, each matching only that tier's keywords most. */
const TASKS = {
  mechanical: "Fix a typo in the changelog",
  standard: "Implement a new endpoint that returns the user profile",
  agentic: "Migrate the whole test suite from Jest to Vitest across the codebase",
  hard: "Find the root cause of a race condition in the connection pool",
  maximum: "Build the whole system from scratch",
} as const;
type TierId = keyof typeof TASKS;

const FAMILY = /^gpt-\d+(?:\.\d+)*-([a-z]+)$/;
const familyOf = (slug: string): string | null => FAMILY.exec(slug)?.[1] ?? null;
const capitalised = (family: string): string => family[0]!.toUpperCase() + family.slice(1);

const FIXTURE = readFileSync(
  new URL("./fixtures/codex-debug-models-0.167.0-2026-11-10.json", import.meta.url),
  "utf8",
);

test("AC-1 picks the family member with the best catalog priority, not the highest version", () => {
  const catalog = catalogOf(
    model("gpt-6.1-sol", 1),
    model("gpt-6-luna", 6),
    model("gpt-5.6-luna", 9),
    // A higher version number with a worse priority: the catalog's order wins.
    model("gpt-7-luna", 12),
  );
  const suggestion = recommend(catalog, TASKS.mechanical);
  assert.equal(suggestion.tier, "mechanical");
  assert.equal(suggestion.model, "gpt-6-luna");
});

const FALLBACKS: { tier: TierId; preferred: string; fallback: string; expected: string; extra: CodexModel[] }[] = [
  { tier: "mechanical", preferred: "luna", fallback: "terra", expected: "gpt-6.1-terra", extra: [] },
  { tier: "standard", preferred: "terra", fallback: "sol", expected: "gpt-6.1-sol", extra: [] },
  { tier: "agentic", preferred: "sol", fallback: "astra", expected: "gpt-6-astra", extra: [model("gpt-5-astra", 11)] },
  { tier: "hard", preferred: "astra", fallback: "sol", expected: "gpt-6.1-sol", extra: [] },
  { tier: "maximum", preferred: "astra", fallback: "sol", expected: "gpt-6.1-sol", extra: [] },
];

for (const { tier, preferred, fallback, expected, extra } of FALLBACKS) {
  test(`AC-2 the ${tier} tier without a visible ${capitalised(preferred)} uses the best ${capitalised(fallback)} and says so`, () => {
    const catalog = catalogOf(...[...CURRENT, ...extra].filter((m) => familyOf(m.slug) !== preferred));
    const candidates = catalog.models.filter((m) => familyOf(m.slug) === fallback);
    assert.ok(candidates.length >= 2, "the fixture must give the fallback family a choice");

    const suggestion = recommend(catalog, TASKS[tier]);
    assert.equal(suggestion.tier, tier);
    assert.equal(suggestion.model, expected);
    assert.match(suggestion.adjustment ?? "", new RegExp(`\\b${capitalised(preferred)}\\b`));
  });
}

test("AC-3 never recommends a model the catalog hides", () => {
  const raw = JSON.stringify({
    models: [
      {
        slug: "gpt-7-luna",
        description: "Hidden routing target.",
        default_reasoning_level: "low",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
        priority: 0,
        visibility: "hide",
      },
      {
        slug: "gpt-6-luna",
        description: "Fast and affordable model for easier tasks.",
        default_reasoning_level: "low",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
        priority: 6,
        visibility: "list",
      },
      {
        slug: "gpt-6.1-terra",
        description: "GPT-6.1 Terra Codex model.",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
        priority: 3,
        visibility: "list",
      },
    ],
  });
  const catalog = catalogOf(...parseCatalog(raw));
  for (const task of Object.values(TASKS)) {
    for (const priority of PRIORITIES) {
      assert.notEqual(recommend(catalog, task, priority).model, "gpt-7-luna", `${task} / ${priority}`);
    }
  }
  assert.equal(recommend(catalog, TASKS.mechanical).model, "gpt-6-luna");
});

function assertRationaleNamesEffort(rationale: string, effort: ReasoningEffort, label: string): void {
  assert.match(rationale, new RegExp(`\\b${effort} effort\\b`, "i"), `${label}: rationale omits "${effort} effort"`);
  for (const other of EFFORT_LEVELS.filter((level) => level !== effort)) {
    assert.doesNotMatch(rationale, new RegExp(`\\b${other} effort\\b`, "i"), `${label}: rationale names "${other} effort"`);
  }
  assert.doesNotMatch(rationale, /extra-high/i, `${label}: rationale names "extra-high"`);
}

for (const tier of Object.keys(TASKS) as TierId[]) {
  test(`AC-4 the ${tier} tier's rationale names the effort it returns, at every priority`, () => {
    for (const priority of PRIORITIES) {
      const suggestion = recommend(catalogOf(...CURRENT), TASKS[tier], priority);
      assertRationaleNamesEffort(suggestion.rationale, suggestion.reasoningEffort, `${tier} / ${priority}`);
    }
  });
}

test("AC-4 the rationale names the effort after the ceiling lowers it", () => {
  const suggestion = recommend(catalogOf(...CURRENT), TASKS.hard, "quality", [], "medium");
  assert.equal(suggestion.reasoningEffort, "medium");
  assertRationaleNamesEffort(suggestion.rationale, "medium", "hard / quality / ceiling medium");
});

const OLDER = /\b(older|previous generation)\b/i;

test("AC-6 on the 2026-11-10 catalog no tier recommends an older model while a better one of its family is visible", () => {
  const catalog = catalogOf(...parseCatalog(FIXTURE));
  assert.ok(catalog.models.length > 0, "the fixture parsed to no models");

  for (const tier of Object.keys(TASKS) as TierId[]) {
    for (const priority of PRIORITIES) {
      const suggestion = recommend(catalog, TASKS[tier], priority);
      const chosen = catalog.models.find((m) => m.slug === suggestion.model);
      assert.ok(chosen, `${tier} / ${priority}: ${suggestion.model} is not in the catalog`);
      if (!OLDER.test(chosen.description)) continue;
      const family = familyOf(chosen.slug);
      const better = catalog.models.find(
        (m) => family !== null && familyOf(m.slug) === family && m.priority < chosen.priority,
      );
      assert.equal(
        better,
        undefined,
        `${tier} / ${priority}: recommended ${chosen.slug} ("${chosen.description}") while ${better?.slug} is visible`,
      );
    }
  }
});

test("AC-6 on the 2026-11-10 catalog each tier picks the current model of its family", () => {
  const catalog = catalogOf(...parseCatalog(FIXTURE));
  const picks = Object.fromEntries(
    (Object.keys(TASKS) as TierId[]).map((tier) => [tier, recommend(catalog, TASKS[tier]).model]),
  );
  assert.deepEqual(picks, {
    mechanical: "gpt-6-luna",
    standard: "gpt-6.1-terra",
    agentic: "gpt-6.1-sol",
    hard: "gpt-6-astra",
    maximum: "gpt-6-astra",
  });
});

/** Every slug-shaped token in what a caller reads. */
function slugsNamedIn(suggestion: ReturnType<typeof recommend>): string[] {
  const text = [suggestion.model, suggestion.rationale, suggestion.adjustment ?? ""].join(" ");
  return (text.match(/\b(?:gpt|codex)-[a-z0-9.-]+/gi) ?? []).map((slug) => slug.replace(/[.-]+$/, ""));
}

test("AC-8 names no slug the catalog does not list", () => {
  const catalogs: CodexCatalog[] = [
    catalogOf(...CURRENT),
    ...["luna", "terra", "sol", "astra"].map((family) =>
      catalogOf(...CURRENT.filter((m) => familyOf(m.slug) !== family)),
    ),
    catalogOf(model("gpt-6.1-sol", 1)),
    catalogOf(...parseCatalog(FIXTURE)),
  ];
  for (const catalog of catalogs) {
    const listed = new Set(catalog.models.map((m) => m.slug));
    for (const tier of Object.keys(TASKS) as TierId[]) {
      for (const priority of PRIORITIES) {
        const suggestion = recommend(catalog, TASKS[tier], priority);
        for (const slug of slugsNamedIn(suggestion)) {
          assert.ok(
            listed.has(slug),
            `${tier} / ${priority} on [${[...listed].join(", ")}]: names ${slug}`,
          );
        }
      }
    }
  }
});

test("AC-9 the standard tier picks the Terra with the best priority", () => {
  const suggestion = recommend(catalogOf(...CURRENT), TASKS.standard);
  assert.equal(suggestion.tier, "standard");
  assert.equal(suggestion.model, "gpt-6.1-terra");
  assert.equal(suggestion.reasoningEffort, "medium");
});

test("AC-9 the standard tier without a Terra picks the best Sol at medium and says no Terra was available", () => {
  const catalog = catalogOf(...CURRENT.filter((m) => familyOf(m.slug) !== "terra"));
  const suggestion = recommend(catalog, TASKS.standard);
  assert.equal(suggestion.model, "gpt-6.1-sol");
  assert.equal(suggestion.reasoningEffort, "medium");
  assert.match(suggestion.adjustment ?? "", /\bTerra\b/);
});

test("AC-9 the priority shift still applies to the standard tier's Sol fallback", () => {
  const catalog = catalogOf(...CURRENT.filter((m) => familyOf(m.slug) !== "terra"));
  const suggestion = recommend(catalog, TASKS.standard, "quality");
  assert.equal(suggestion.model, "gpt-6.1-sol");
  assert.equal(suggestion.reasoningEffort, "high");
});

test("AC-10 a slug outside gpt-<version>-<family> is never a tier's family pick", () => {
  const catalog = catalogOf(model("codex-special", 0), model("gpt-6.1-sol", 1), model("gpt-6-luna", 6));
  assert.equal(recommend(catalog, TASKS.mechanical).model, "gpt-6-luna");
  assert.equal(recommend(catalog, TASKS.agentic).model, "gpt-6.1-sol");
  for (const tier of Object.keys(TASKS) as TierId[]) {
    for (const priority of PRIORITIES) {
      assert.notEqual(recommend(catalog, TASKS[tier], priority).model, "codex-special", `${tier} / ${priority}`);
    }
  }
});

test("AC-10 a slug outside gpt-<version>-<family> is returned through the general fallback with a note", () => {
  const suggestion = recommend(catalogOf(model("codex-special", 0)), TASKS.standard);
  assert.equal(suggestion.model, "codex-special");
  assert.match(suggestion.adjustment ?? "", /codex-special/);
});
