import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveCodexExecutable } from "./resolve.js";
import {
  REASONING_EFFORTS,
  type CodexCatalog,
  type CodexModel,
  type ReasoningEffort,
} from "../types.js";

const execFileAsync = promisify(execFile);

/** How long a successfully fetched catalog is reused before refetching. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * `codex debug models` emits the full catalog, including per-model system
 * prompts. That payload is ~350 KB, so it is parsed and immediately reduced to
 * the handful of fields this server actually needs.
 */
const CATALOG_MAX_BUFFER = 32 * 1024 * 1024;

const CATALOG_TIMEOUT_MS = 15_000;

/**
 * Last-resort catalog, used only when the CLI cannot be queried. It is
 * deliberately marked stale so callers know the data may be out of date; the
 * CLI is always the source of truth.
 */
const FALLBACK_MODELS: CodexModel[] = [
  {
    slug: "gpt-6-astra",
    displayName: "GPT-6-Astra",
    description: "Our most capable model for complex, demanding work.",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    priority: 1,
    supportsImages: true,
    supportsWebSearch: true,
  },
  {
    slug: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    description: "Reliable agentic workhorse for everyday tasks.",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    priority: 6,
    supportsImages: true,
    supportsWebSearch: true,
  },
  {
    slug: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    description: "Balanced agentic coding model for everyday work.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    priority: 7,
    supportsImages: true,
    supportsWebSearch: true,
  },
  {
    slug: "gpt-5.6-luna",
    displayName: "GPT-5.6-Luna",
    description: "Fast and affordable agentic coding model.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    priority: 8,
    supportsImages: true,
    supportsWebSearch: true,
  },
  {
    slug: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Proven previous-generation model for coding and general work.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    contextWindow: 272_000,
    maxContextWindow: 272_000,
    priority: 12,
    supportsImages: true,
    supportsWebSearch: true,
  },
];

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Turns one raw catalog entry into a {@link CodexModel}, or null when the entry
 * is hidden, internal, or too malformed to be useful.
 *
 * Exported for unit testing against fixtures captured from the real CLI.
 */
export function normaliseModel(raw: unknown): CodexModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;

  const slug = entry.slug;
  if (typeof slug !== "string" || slug.length === 0) return null;

  // Hidden models (`gpt-reserve`, `codex-auto-review`, ...) are internal
  // routing targets, not things an orchestrator should pick.
  if (entry.visibility !== "list") return null;

  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels
    : [];
  const supported: ReasoningEffort[] = [];
  for (const level of levels) {
    const effort =
      typeof level === "object" && level !== null
        ? (level as Record<string, unknown>).effort
        : level;
    if (isReasoningEffort(effort) && !supported.includes(effort)) {
      supported.push(effort);
    }
  }
  supported.sort(
    (a, b) => REASONING_EFFORTS.indexOf(a) - REASONING_EFFORTS.indexOf(b),
  );

  const rawDefault = entry.default_reasoning_level;
  const defaultEffort: ReasoningEffort = isReasoningEffort(rawDefault)
    ? rawDefault
    : (supported[0] ?? "medium");

  const modalities = Array.isArray(entry.input_modalities)
    ? entry.input_modalities
    : [];

  return {
    slug,
    displayName: typeof entry.display_name === "string" ? entry.display_name : slug,
    description: typeof entry.description === "string" ? entry.description : "",
    defaultReasoningEffort: defaultEffort,
    supportedReasoningEfforts: supported.length > 0 ? supported : [defaultEffort],
    contextWindow: asNumber(entry.context_window),
    maxContextWindow: asNumber(entry.max_context_window),
    priority: asNumber(entry.priority) ?? Number.MAX_SAFE_INTEGER,
    supportsImages: modalities.includes("image"),
    supportsWebSearch: entry.supports_search_tool === true,
  };
}

/** Parses the JSON document produced by `codex debug models`. */
export function parseCatalog(json: string): CodexModel[] {
  const parsed: unknown = JSON.parse(json);
  const rawModels =
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>).models)
      ? ((parsed as Record<string, unknown>).models as unknown[])
      : [];

  return rawModels
    .map(normaliseModel)
    .filter((model): model is CodexModel => model !== null)
    .sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));
}

/**
 * Tells a configuration failure of `codex debug models` from unusable output.
 *
 * Verified against codex-cli 0.154.0: when configuration is the problem the
 * command exits non-zero with an `Error:` line — `Error: <path>:1:9: string
 * values must be quoted`, `Error: unknown variant ...`, `Error: legacy
 * \`profile\` ...`, `Error: Model provider \`oss\` not found`, `Error: failed to
 * parse model_catalog_json ...`. Argument parsing, which is what an older release
 * without the subcommand fails at, prints a lowercase `error:` instead
 * ("error: unrecognized subcommand"). Falling back to the static list for the
 * first kind hid a fixable problem behind models that may not even exist for
 * the user's provider.
 */
export function classifyCatalogFailure(error: unknown): "configuration" | "unusable" {
  const stderr =
    typeof error === "object" && error !== null && typeof (error as { stderr?: unknown }).stderr === "string"
      ? ((error as { stderr: string }).stderr)
      : "";
  return /^Error(?: loading configuration)?:/m.test(stderr) ? "configuration" : "unusable";
}

/**
 * Cached catalogs, keyed by the executable *and* the directory it was read in.
 *
 * Codex resolves its configuration against the working directory: a project
 * this user has trusted in Codex can set `model_catalog_json`, so the catalog
 * of one directory is not the catalog of another. One global entry meant a
 * delegation could be validated against the models of whatever directory
 * happened to be probed first. Bounded, because a caller chooses the directory.
 */
const cached = new Map<string, { catalog: CodexCatalog; atMs: number }>();

const CACHE_ENTRY_LIMIT = 32;

function cacheKey(codexPath: string, cwd: string | undefined): string {
  return `${codexPath}\u0000${cwd ?? ""}`;
}

export interface CatalogOptions {
  /** Ignore the cache and query the CLI again. */
  refresh?: boolean;
  /** Path or name of the Codex executable. */
  codexPath?: string;
  /** Directory to read the catalog in. Defaults to this process's own. */
  cwd?: string;
}

/**
 * Returns the model catalog, reading it from the Codex CLI and caching the
 * result. The catalog is never hardcoded: new models appear here as soon as the
 * installed CLI knows about them.
 */
export async function getCatalog(
  options: CatalogOptions = {},
): Promise<CodexCatalog> {
  const { refresh = false, codexPath = process.env.CODEX_BIN ?? "codex", cwd } =
    options;

  const key = cacheKey(codexPath, cwd);
  const hit = cached.get(key);
  if (!refresh && hit && Date.now() - hit.atMs < CACHE_TTL_MS) {
    return hit.catalog;
  }

  try {
    // Windows `spawn` does not apply PATHEXT, so the executable is resolved the
    // same way the preflight resolves it. See `src/codex/resolve.ts`.
    const resolved = resolveCodexExecutable(codexPath);
    const target = resolved.path ?? codexPath;
    const { stdout } = await execFileAsync(target, ["debug", "models"], {
      maxBuffer: CATALOG_MAX_BUFFER,
      timeout: CATALOG_TIMEOUT_MS,
      ...(cwd ? { cwd } : {}),
    });
    const models = parseCatalog(stdout);
    if (models.length === 0) {
      throw new Error("catalog contained no listable models");
    }
    const catalog: CodexCatalog = { models, stale: false, fetchedAt: new Date().toISOString() };
    if (cached.size >= CACHE_ENTRY_LIMIT && !cached.has(key)) {
      const oldest = cached.keys().next().value;
      if (oldest !== undefined) cached.delete(oldest);
    }
    cached.set(key, { catalog, atMs: Date.now() });
    return catalog;
  } catch (error) {
    if (classifyCatalogFailure(error) === "configuration") {
      const stderr = (error as { stderr: string }).stderr.trim();
      throw new Error(
        "Codex could not read its model catalog because of a configuration problem, so no model can be " +
          `validated. Codex reported:\n${stderr}\n` +
          "Fix the file or value it names, then retry. Run codex_doctor to check.",
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    // Do not cache the fallback: the CLI may become available at any moment.
    //
    // Callers run the preflight (`src/codex/doctor.ts`) before reaching this, so
    // a missing or signed-out CLI, or one whose configuration cannot load, has
    // already been reported with remediation steps. What lands here is the
    // narrower case of a CLI that runs but whose `debug models` output could not
    // be used — an older release without the subcommand, for instance — where a
    // warned list is more useful than nothing for browsing. It is never used to
    // validate a delegation (see `resolveModelAndEffort` in `src/server.ts`).
    return {
      models: FALLBACK_MODELS,
      stale: true,
      warning:
        `Could not read the live catalog via \`${codexPath} debug models\` (${reason}). ` +
        "Falling back to a static list that may be out of date. Run codex_doctor to check the " +
        "Codex CLI installation, and treat any model slug below as unconfirmed.",
      fetchedAt: new Date().toISOString(),
    };
  }
}

/** Clears the in-process cache. Intended for tests. */
export function resetCatalogCache(): void {
  cached.clear();
}

export function findModel(
  catalog: CodexCatalog,
  slug: string,
): CodexModel | undefined {
  return catalog.models.find((model) => model.slug === slug);
}

/**
 * Picks the effort a model should actually run with.
 *
 * When the requested effort is not supported by that model, it is clamped to
 * the closest supported level instead of failing, and the caller is told what
 * happened so it can surface the downgrade.
 * A ceiling restricts the candidates before clamping: the ceiling itself need
 * not be supported, and an empty intersection cannot be honoured.
 */
export function resolveEffort(
  model: CodexModel,
  requested: ReasoningEffort | undefined,
  ceiling: ReasoningEffort | null = null,
): { effort: ReasoningEffort; adjusted: boolean; reason?: string } {
  if (!requested && !ceiling) {
    return { effort: model.defaultReasoningEffort, adjusted: false };
  }
  const wanted = requested ?? model.defaultReasoningEffort;
  const supported = ceiling
    ? model.supportedReasoningEfforts.filter(
        (effort) => REASONING_EFFORTS.indexOf(effort) <= REASONING_EFFORTS.indexOf(ceiling),
      )
    : model.supportedReasoningEfforts;
  if (ceiling && supported.length === 0) {
    throw new Error(
      `Model "${model.slug}" supports reasoning efforts ${model.supportedReasoningEfforts.join(", ")}; ` +
        `none are at or below the ceiling "${ceiling}".`,
    );
  }
  if (supported.includes(wanted)) {
    return { effort: wanted, adjusted: false };
  }

  const requestedRank = REASONING_EFFORTS.indexOf(wanted);
  let closest = supported[0] ?? model.defaultReasoningEffort;
  let closestDistance = Number.MAX_SAFE_INTEGER;
  for (const candidate of supported) {
    const distance = Math.abs(REASONING_EFFORTS.indexOf(candidate) - requestedRank);
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }

  return {
    effort: closest,
    adjusted: true,
    reason: ceiling
      ? `${model.slug} cannot use reasoning effort "${wanted}" ` +
        `(supported: ${model.supportedReasoningEfforts.join(", ")}; ceiling "${ceiling}"); using "${closest}" instead.`
      : `${model.slug} does not support reasoning effort "${wanted}" ` +
        `(supported: ${model.supportedReasoningEfforts.join(", ")}); using "${closest}" instead.`,
  };
}
