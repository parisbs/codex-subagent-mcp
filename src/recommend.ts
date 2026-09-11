import { findModel, resolveEffort } from "./codex/catalog.js";
import type { CodexCatalog, ReasoningEffort } from "./types.js";

export type Priority = "quality" | "balanced" | "latency" | "cost";

export interface Recommendation {
  model: string;
  reasoningEffort: ReasoningEffort;
  tier: string;
  rationale: string;
  /** Set when the catalog forced a change to the tier's nominal choice. */
  adjustment?: string;
}

interface Tier {
  id: string;
  model: string;
  effort: ReasoningEffort;
  /** Fallbacks tried in order when the preferred model is not in the catalog. */
  alternatives: string[];
  rationale: string;
  keywords: RegExp;
}

/**
 * The selection matrix.
 *
 * Model choice follows the catalog's own positioning: Luna is the fast and
 * affordable option, Terra the balanced everyday model, Sol the reliable
 * agentic workhorse, and Astra the most capable model for demanding work.
 * Reasoning effort is the second, independent axis: it scales how long the
 * chosen model deliberates before acting.
 */
const TIERS: Tier[] = [
  {
    id: "mechanical",
    model: "gpt-5.6-luna",
    effort: "low",
    alternatives: ["gpt-5.6-terra", "gpt-5.5"],
    rationale:
      "Mechanical, low-risk edit with an unambiguous target. The fast model at low effort is enough and keeps latency and cost down.",
    keywords:
      /\b(rename|renaming|format|formatting|lint|typo|boilerplate|scaffold|stub|comment|docstring|changelog|bump|reorder|import)\b/i,
  },
  {
    id: "standard",
    model: "gpt-5.6-terra",
    effort: "medium",
    alternatives: ["gpt-5.6-sol", "gpt-5.5"],
    rationale:
      "Ordinary day-to-day development work. The balanced model at medium effort is the default trade-off.",
    keywords:
      /\b(implement|add|write|fix|update|refactor|endpoint|component|function|feature|bug)\b/i,
  },
  {
    id: "agentic",
    model: "gpt-5.6-sol",
    effort: "high",
    alternatives: ["gpt-6-astra", "gpt-5.6-terra"],
    rationale:
      "Multi-step agentic work across several files. The agentic workhorse at high effort holds a longer plan together.",
    keywords:
      /\b(migrat\w+|port|upgrade|codemod|across the (?:repo|codebase)|test suite|end[- ]to[- ]end|integration|large refactor|rewrite)\b/i,
  },
  {
    id: "hard",
    model: "gpt-6-astra",
    effort: "xhigh",
    alternatives: ["gpt-5.6-sol", "gpt-5.6-terra"],
    rationale:
      "Hard reasoning problem where a wrong answer is expensive. The most capable model at extra-high effort.",
    keywords:
      /\b(architect\w*|design (?:doc|review)|race condition|concurrenc\w+|deadlock|memory leak|performance regression|security|cryptograph\w+|root cause|heisenbug|algorithm|proof)\b/i,
  },
  {
    id: "maximum",
    model: "gpt-6-astra",
    effort: "ultra",
    alternatives: ["gpt-5.6-sol", "gpt-5.6-terra"],
    rationale:
      "Open-ended, very hard problem. Ultra effort adds automatic delegation of subtasks; expect a long run.",
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
): Recommendation {
  const tier = matchTier(taskDescription);
  const notes: string[] = [];

  // Recommending a model the user has excluded would send the caller back with
  // a slug this server is about to reject.
  const permitted =
    allowedModels.length === 0
      ? catalog
      : { ...catalog, models: catalog.models.filter((m) => allowedModels.includes(m.slug)) };
  catalog = permitted;

  let model = findModel(catalog, tier.model);
  if (!model) {
    for (const alternative of tier.alternatives) {
      model = findModel(catalog, alternative);
      if (model) {
        notes.push(
          `${tier.model} is not in the installed catalog; using ${model.slug} instead.`,
        );
        break;
      }
    }
  }
  if (!model) {
    model = catalog.models[0];
    if (model) {
      notes.push(
        `Neither ${tier.model} nor its alternatives are available; falling back to ${model.slug}.`,
      );
    }
  }
  if (!model) {
    throw new Error("The Codex catalog is empty; cannot recommend a model.");
  }

  const wanted = shiftEffort(tier.effort, PRIORITY_SHIFT[priority]);
  const resolved = resolveEffort(model, wanted);
  if (resolved.adjusted && resolved.reason) notes.push(resolved.reason);

  const result: Recommendation = {
    model: model.slug,
    reasoningEffort: resolved.effort,
    tier: tier.id,
    rationale: tier.rationale,
  };
  if (notes.length > 0) {
    result.adjustment = notes.join(" ");
  }
  return result;
}
