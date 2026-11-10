import { resolveEffort } from "./codex/catalog.js";
import type { CodexCatalog, CodexModel, ReasoningEffort } from "./types.js";

export type Priority = "quality" | "balanced" | "latency" | "cost";

export interface Recommendation {
  model: string;
  reasoningEffort: ReasoningEffort;
  tier: string;
  rationale: string;
  /** Set when the catalog forced a change to the tier's nominal choice. */
  adjustment?: string;
}

/** A model family, read from the slug: `gpt-<version>-<family>`. */
type Family = "luna" | "terra" | "sol" | "astra";

const FAMILIES: readonly Family[] = ["luna", "terra", "sol", "astra"];

interface Tier {
  id: string;
  /** The family this tier prefers. */
  family: Family;
  /** The family used when the preferred one has no eligible model. */
  fallback: Family;
  effort: ReasoningEffort;
  /** Why this tier fits, with `{effort}` standing for the effort actually returned. */
  rationale: string;
  keywords: RegExp;
}

/**
 * The selection matrix.
 *
 * Model choice follows the catalog's own positioning: Luna is the fast and
 * affordable option, Terra the balanced everyday model, Sol the reliable
 * agentic workhorse, and Astra the most capable model for demanding work.
 * A tier names families, never slugs: the catalog changes server-side without
 * a CLI release, so the member of a family is chosen at runtime by the
 * catalog's own `priority`. Reasoning effort is the second, independent axis:
 * it scales how long the chosen model deliberates before acting.
 */
const TIERS: Tier[] = [
  {
    id: "mechanical",
    family: "luna",
    fallback: "terra",
    effort: "low",
    rationale:
      "Mechanical, low-risk edit with an unambiguous target. A fast model at {effort} effort is enough and keeps latency and cost down.",
    keywords:
      /\b(rename|renaming|format|formatting|lint|typo|boilerplate|scaffold|stub|comment|docstring|changelog|bump|reorder|import)\b/i,
  },
  {
    id: "standard",
    family: "terra",
    fallback: "sol",
    effort: "medium",
    rationale:
      "Ordinary day-to-day development work. A balanced model at {effort} effort is the default trade-off.",
    keywords:
      /\b(implement|add|write|fix|update|refactor|endpoint|component|function|feature|bug)\b/i,
  },
  {
    id: "agentic",
    family: "sol",
    fallback: "astra",
    effort: "high",
    rationale:
      "Multi-step agentic work across several files. An agentic workhorse at {effort} effort holds a longer plan together.",
    keywords:
      /\b(migrat\w+|port|upgrade|codemod|across the (?:repo|codebase)|test suite|end[- ]to[- ]end|integration|large refactor|rewrite)\b/i,
  },
  {
    id: "hard",
    family: "astra",
    fallback: "sol",
    effort: "xhigh",
    rationale:
      "Hard reasoning problem where a wrong answer is expensive. The most capable model available at {effort} effort.",
    keywords:
      /\b(architect\w*|design (?:doc|review)|race condition|concurrenc\w+|deadlock|memory leak|performance regression|security|cryptograph\w+|root cause|heisenbug|algorithm|proof)\b/i,
  },
  {
    id: "maximum",
    family: "astra",
    fallback: "sol",
    effort: "ultra",
    rationale:
      "Open-ended, very hard problem. The most capable model available at {effort} effort; expect a long run.",
    keywords:
      /\b(from scratch|greenfield|whole system|research|explore (?:options|approaches)|hardest|prototype an? (?:architecture|approach))\b/i,
  },
];

const DEFAULT_TIER_ID = "standard";

/** Effort offsets applied on top of the matched tier, by caller priority. */
const PRIORITY_SHIFT: Record<Priority, number> = {
  cost: -2,
  latency: -1,
  balanced: 0,
  quality: 1,
};

const EFFORT_ORDER: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

function shiftEffort(effort: ReasoningEffort, shift: number): ReasoningEffort {
  const index = EFFORT_ORDER.indexOf(effort);
  const next = Math.min(
    EFFORT_ORDER.length - 1,
    Math.max(EFFORT_ORDER.indexOf("low"), index + shift),
  );
  return EFFORT_ORDER[next] ?? effort;
}

/** Scores each tier against the description and returns the best match. */
function matchTier(description: string): Tier {
  let best: Tier | undefined;
  let bestScore = 0;

  for (const tier of TIERS) {
    const matches = description.match(new RegExp(tier.keywords.source, "gi"));
    const score = matches ? matches.length : 0;
    // Later tiers win ties: when a task looks both routine and hard, the
    // expensive reading is the safer one to act on.
    if (score >= bestScore && score > 0) {
      best = tier;
      bestScore = score;
    }
  }

  return best ?? TIERS.find((tier) => tier.id === DEFAULT_TIER_ID) ?? TIERS[1]!;
}

const SLUG_FAMILY = /^gpt-\d+(?:\.\d+)*-([a-z]+)$/;

/**
 * The family a slug belongs to, read only from its shape. The catalog has no
 * family field and its descriptions do not reliably name one, so a slug that
 * does not match `gpt-<version>-<family>` belongs to no family.
 */
function familyOf(slug: string): Family | null {
  const name = SLUG_FAMILY.exec(slug)?.[1];
  return FAMILIES.find((family) => family === name) ?? null;
}

/** Families are named in prose as words: Luna, Terra, Sol, Astra. */
function familyName(family: Family): string {
  return family[0]!.toUpperCase() + family.slice(1);
}

/**
 * The model the catalog ranks first, by `priority` (lower is better), never by
 * version number. Ties keep catalog order.
 */
function bestByPriority(models: CodexModel[]): CodexModel | undefined {
  let best: CodexModel | undefined;
  for (const candidate of models) {
    if (!best || candidate.priority < best.priority) best = candidate;
  }
  return best;
}

function describeRationale(tier: Tier, effort: ReasoningEffort): string {
  const text = tier.rationale.replace("{effort}", effort);
  return effort === "ultra" ? `${text} Ultra effort adds automatic delegation of subtasks.` : text;
}

/**
 * Recommends a model and reasoning effort for a task description.
 *
 * The matrix is deterministic and documented, but it is always reconciled
 * against the live catalog, so a retired model or an unsupported effort is
 * corrected rather than passed through to the CLI.
 */
export function recommend(
  catalog: CodexCatalog,
  taskDescription: string,
  priority: Priority = "balanced",
  /** When non-empty, only these slugs may be recommended. */
  allowedModels: string[] = [],
  /** The configured effort ceiling, if any. */
  maxEffort: ReasoningEffort | null = null,
): Recommendation {
  const tier = matchTier(taskDescription);
  const notes: string[] = [];

  // Recommending a model the user has excluded, or one with no effort under the
  // ceiling, would send the caller back with advice this server is about to
  // refuse.
  const permitted =
    allowedModels.length === 0
      ? catalog
      : { ...catalog, models: catalog.models.filter((m) => allowedModels.includes(m.slug)) };
  const underCeiling = (candidate: CodexModel): boolean =>
    maxEffort === null ||
    candidate.supportedReasoningEfforts.some(
      (effort) => EFFORT_ORDER.indexOf(effort) <= EFFORT_ORDER.indexOf(maxEffort),
    );
  const eligible = { ...permitted, models: permitted.models.filter(underCeiling) };

  const familyMembers = (models: CodexModel[], family: Family): CodexModel[] =>
    models.filter((candidate) => familyOf(candidate.slug) === family);

  // Walks the preferred family, then the fallback one. A family's best model
  // that has no effort under the ceiling is skipped with a note naming it.
  const missing: Family[] = [];
  let model: CodexModel | undefined;
  for (const family of [tier.family, tier.fallback]) {
    const best = bestByPriority(familyMembers(permitted.models, family));
    if (best && !underCeiling(best)) {
      notes.push(
        `${best.slug} supports no reasoning effort at or below the ceiling "${maxEffort}" ` +
          `(supported: ${best.supportedReasoningEfforts.join(", ")}).`,
      );
    }
    model = bestByPriority(familyMembers(eligible.models, family));
    if (model) {
      if (family !== tier.family) {
        const absent = missing.includes(tier.family);
        notes.push(
          absent
            ? `No current ${familyName(tier.family)} model is available; using ${model.slug} instead.`
            : `Using ${model.slug} instead.`,
        );
      }
      break;
    }
    if (!best) missing.push(family);
  }

  if (!model) {
    // Any eligible model, including one whose slug names no family.
    model = bestByPriority(eligible.models);
    if (model) {
      notes.push(
        `No current ${familyName(tier.family)} or ${familyName(tier.fallback)} model is available; ` +
          `falling back to ${model.slug}, the catalog's best-ranked model.`,
      );
    }
  }
  if (!model) {
    if (maxEffort !== null && permitted.models.length > 0) {
      throw new Error(
        `No available model supports a reasoning effort at or below the ceiling "${maxEffort}", ` +
          "so there is nothing to recommend. Raise CODEX_SUBAGENT_MAX_EFFORT or allow a model that " +
          "supports a lower effort.",
      );
    }
    throw new Error("The Codex catalog is empty; cannot recommend a model.");
  }

  const wanted = shiftEffort(tier.effort, PRIORITY_SHIFT[priority]);
  const resolved = resolveEffort(model, wanted, maxEffort);
  if (resolved.adjusted && resolved.reason) notes.push(resolved.reason);

  const result: Recommendation = {
    model: model.slug,
    reasoningEffort: resolved.effort,
    tier: tier.id,
    rationale: describeRationale(tier, resolved.effort),
  };
  if (notes.length > 0) {
    result.adjustment = notes.join(" ");
  }
  return result;
}
