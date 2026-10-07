import {
  REASONING_EFFORTS,
  SANDBOX_MODES,
  type ReasoningEffort,
  type SandboxMode,
} from "./types.js";

/**
 * Which inherited MCP servers or plugins a delegation keeps (ADR 16): none, all, or the named ones.
 */
export type InheritPolicy = { kind: "none" } | { kind: "all" } | { kind: "list"; names: string[] };

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
 * Sandbox policy has two user-controlled layers: a default for calls that omit
 * one, and a ceiling no call may exceed. A caller can override the former but
 * cannot widen the latter.
 */
export interface ServerConfig {
  /** The MCP servers from the user's and the project's Codex config a delegation keeps. */
  mcpServers: InheritPolicy;
  /** The installed Codex plugins a delegation keeps. */
  plugins: InheritPolicy;
  /** Whether a delegation keeps Codex's apps (connectors to external services). */
  apps: boolean;
  /** Used when the caller specifies no model. Unset means: refuse and suggest. */
  defaultModel: string | null;
  /** Used when the caller specifies no effort. Unset means: the model's own default. */
  defaultEffort: ReasoningEffort | null;
  /** When non-empty, only these model slugs may be used. */
  allowedModels: string[];
  /** Used when the caller specifies no sandbox. */
  defaultSandbox: SandboxMode;
  /** The most permissive sandbox this server will pass to Codex. */
  maxSandbox: SandboxMode;
  /** True when the ceiling came from the environment rather than the built-in default. */
  maxSandboxConfigured: boolean;
  /** The highest reasoning effort this server will request. */
  maxEffort: ReasoningEffort | null;
  /** Whether each delegation process appends a line to the local usage log (ADR 22, ADR 24). */
  usageLog: boolean;
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

/**
 * Reads a comma-separated list of names. Blank or unset means no list. An empty entry is reported
 * rather than dropped: for an allow-list, dropping it can leave no names, which means no
 * restriction, so a value meant to restrict (`,`, or a template whose variables expanded to
 * nothing) would silently allow everything (#128). Tools refuse while the error stands.
 */
function readList(name: string, raw: string | undefined, errors: string[]): string[] {
  const value = raw?.trim() ?? "";
  if (value === "") return [];
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    errors.push(
      `${ENV_PREFIX}${name} is "${raw}", which has an empty entry. List names separated by single ` +
        "commas.",
    );
  }
  return entries.filter((entry) => entry.length > 0);
}

/**
 * Reads an inheritance policy (ADR 16). These variables remove a protection, so a value that has to
 * be guessed at is reported instead. `none` and `all` stand alone, a list is names separated by
 * single commas, and an empty entry is a mistake — a value of only commas usually means a template
 * whose variables expanded to nothing.
 */
function readInheritPolicy(name: string, raw: string | undefined, errors: string[]): InheritPolicy {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "none") return { kind: "none" };
  if (value === "all") return { kind: "all" };
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    errors.push(
      `${ENV_PREFIX}${name} is "${raw}", which has an empty entry. List names separated by single ` +
        "commas, or use none or all on its own.",
    );
    return { kind: "none" };
  }
  if (entries.some((entry) => entry === "none" || entry === "all")) {
    errors.push(
      `${ENV_PREFIX}${name} is "${raw}", which mixes none or all with other entries. Use none or all ` +
        "on its own, or list names only.",
    );
    return { kind: "none" };
  }
  return { kind: "list", names: [...new Set(entries)] };
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

  const usageLog = readEnum("USAGE_LOG", ["on", "off"]);
  const maxSandbox = readEnum("MAX_SANDBOX", SANDBOX_MODES);
  const defaultSandbox = readEnum("DEFAULT_SANDBOX", SANDBOX_MODES);
  const maxEffort = readEnum("MAX_EFFORT", REASONING_EFFORTS);
  const defaultEffort = readEnum("DEFAULT_EFFORT", REASONING_EFFORTS);
  const allowedModels = readList("ALLOWED_MODELS", env[`${ENV_PREFIX}ALLOWED_MODELS`], errors);
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

  const mcpServers = readInheritPolicy("MCP_SERVERS", env[`${ENV_PREFIX}MCP_SERVERS`], errors);
  const plugins = readInheritPolicy("PLUGINS", env[`${ENV_PREFIX}PLUGINS`], errors);
  const rawApps = env[`${ENV_PREFIX}APPS`];
  const apps = rawApps?.trim() ?? "";
  if (apps !== "" && apps !== "on" && apps !== "off") {
    errors.push(`${ENV_PREFIX}APPS is "${rawApps}", which is not one of: on, off.`);
  }

  const effectiveMaxSandbox = maxSandbox ?? "workspace-write";
  const effectiveDefaultSandbox = defaultSandbox ?? "read-only";
  if (sandboxRank(effectiveDefaultSandbox) > sandboxRank(effectiveMaxSandbox)) {
    errors.push(
      `${ENV_PREFIX}DEFAULT_SANDBOX ("${effectiveDefaultSandbox}") is higher than ` +
        `${ENV_PREFIX}MAX_SANDBOX ("${effectiveMaxSandbox}").`,
    );
  }

  return {
    config: {
      // Nothing inherited unless the user allows it: Codex's sandbox does not confine these (ADR 16).
      mcpServers,
      plugins,
      apps: apps === "on",
      defaultModel,
      defaultEffort,
      allowedModels,
      defaultSandbox: effectiveDefaultSandbox,
      // Removing the sandbox entirely must be a deliberate user opt-in.
      maxSandbox: effectiveMaxSandbox,
      maxSandboxConfigured: maxSandbox !== null,
      maxEffort,
      usageLog: usageLog === "on",
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
  // The message must not claim the ceiling was configured when it is the
  // built-in one: a user told they set something they never set goes looking
  // for it in the wrong place.
  const source = config.maxSandboxConfigured
    ? `ceiling configured with ${ENV_PREFIX}MAX_SANDBOX="${config.maxSandbox}"`
    : `built-in ceiling of "${config.maxSandbox}", which is what applies when ${ENV_PREFIX}MAX_SANDBOX is unset`;
  return {
    ok: false,
    reason:
      `This server runs with a ${source}, so sandbox "${requested}" is not allowed. Either run the ` +
      `task within that ceiling, or raise it with ${ENV_PREFIX}MAX_SANDBOX in the MCP server ` +
      "configuration — which is where removing the sandbox has to be decided, not in a tool call.",
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
