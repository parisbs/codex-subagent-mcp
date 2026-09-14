import {
  REASONING_EFFORTS,
  SANDBOX_MODES,
  type ReasoningEffort,
  type SandboxMode,
} from "./types.js";

/**
 * User configuration, read from the environment.
 *
 * The guiding rule is that this server provides mechanism and the user provides
 * policy. Deciding *when* to escalate to a more capable model depends on budget,
 * tolerance for latency and the kind of work being done — none of which this
 * server can know. So it never decides silently: either the caller specifies a
 * model, or the user has configured one, or the delegation is refused with a
 * suggestion rather than guessed at.
 *
 * A second rule follows from that: configuration may only *restrict*. There is
 * no setting that makes delegations more permissive than the defaults, because
 * the useful direction for a limit is the safe one.
 */
export interface ServerConfig {
  /** Used when the caller specifies no model. Unset means: refuse and suggest. */
  defaultModel: string | null;
  /** Used when the caller specifies no effort. Unset means: the model's own default. */
  defaultEffort: ReasoningEffort | null;
  /** When non-empty, only these model slugs may be used. */
  allowedModels: string[];
  /** The most permissive sandbox this server will pass to Codex. */
  maxSandbox: SandboxMode;
  /** The highest reasoning effort this server will request. */
  maxEffort: ReasoningEffort | null;
}

export interface LoadedConfig {
  config: ServerConfig;
  /** Problems with the environment. Reported per call rather than at startup. */
  errors: string[];
}

export const ENV_PREFIX = "CODEX_SUBAGENT_";

/** Sandbox modes ordered from least to most permissive. */
const SANDBOX_ORDER: SandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

export function sandboxRank(mode: SandboxMode): number {
  return SANDBOX_ORDER.indexOf(mode);
}

export function effortRank(effort: ReasoningEffort): number {
  return REASONING_EFFORTS.indexOf(effort);
}

function readList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Reads configuration from an environment object.
 *
 * Invalid values are collected rather than thrown: a server that refuses to
 * start cannot explain why, and the user would see a tool that simply is not
 * there. The errors are surfaced on the first tool call instead, the same way
 * a missing Codex CLI is.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const errors: string[] = [];

  const readEnum = <T extends string>(
    name: string,
    allowed: readonly T[],
  ): T | null => {
    const raw = env[`${ENV_PREFIX}${name}`]?.trim();
    if (!raw) return null;
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    errors.push(
      `${ENV_PREFIX}${name} is "${raw}", which is not one of: ${allowed.join(", ")}.`,
    );
    return null;
  };

  const maxSandbox = readEnum("MAX_SANDBOX", SANDBOX_MODES);
  const maxEffort = readEnum("MAX_EFFORT", REASONING_EFFORTS);
  const defaultEffort = readEnum("DEFAULT_EFFORT", REASONING_EFFORTS);
  const allowedModels = readList(env[`${ENV_PREFIX}ALLOWED_MODELS`]);
  const defaultModel = env[`${ENV_PREFIX}DEFAULT_MODEL`]?.trim() || null;

  if (
    defaultModel &&
    allowedModels.length > 0 &&
    !allowedModels.includes(defaultModel)
  ) {
    errors.push(
      `${ENV_PREFIX}DEFAULT_MODEL is "${defaultModel}", which is not in ` +
        `${ENV_PREFIX}ALLOWED_MODELS (${allowedModels.join(", ")}).`,
    );
  }

  if (defaultEffort && maxEffort && effortRank(defaultEffort) > effortRank(maxEffort)) {
    errors.push(
      `${ENV_PREFIX}DEFAULT_EFFORT ("${defaultEffort}") is higher than ` +
        `${ENV_PREFIX}MAX_EFFORT ("${maxEffort}").`,
    );
  }

  return {
    config: {
      defaultModel,
      defaultEffort,
      allowedModels,
      // Absent means the existing default: read-only is already the floor, and
      // this only ever caps how far a caller may go above it.
      maxSandbox: maxSandbox ?? "danger-full-access",
      maxEffort,
    },
    errors,
  };
}

/**
 * Applies the sandbox ceiling.
 *
 * A sandbox that is too permissive is refused rather than quietly lowered: the
 * caller asked for write access because the task needs it, and silently running
 * read-only would produce a delegation that cannot do its job and does not say
 * so.
 */
export function checkSandbox(
  requested: SandboxMode,
  config: ServerConfig,
): { ok: true } | { ok: false; reason: string } {
  if (sandboxRank(requested) <= sandboxRank(config.maxSandbox)) return { ok: true };
  return {
    ok: false,
    reason:
      `This server is configured with ${ENV_PREFIX}MAX_SANDBOX="${config.maxSandbox}", ` +
      `so sandbox "${requested}" is not allowed. Either run the task read-only, or change that ` +
      "setting in the MCP server configuration.",
  };
}

/** Applies the model allow-list. */
export function checkModel(
  slug: string,
  config: ServerConfig,
): { ok: true } | { ok: false; reason: string } {
  if (config.allowedModels.length === 0 || config.allowedModels.includes(slug)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `Model "${slug}" is not in ${ENV_PREFIX}ALLOWED_MODELS ` +
      `(${config.allowedModels.join(", ")}).`,
  };
}

/**
 * The model to use when the caller specified none, if one can be determined
 * without guessing.
 *
 * An allow-list with a single entry leaves nothing to decide, so it is treated
 * as a default: refusing there would be friction with no decision behind it.
 */
export function impliedModel(config: ServerConfig): string | null {
  if (config.defaultModel) return config.defaultModel;
  if (config.allowedModels.length === 1) return config.allowedModels[0] ?? null;
  return null;
}
