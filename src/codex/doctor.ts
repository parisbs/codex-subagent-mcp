import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveCodexExecutable } from "./resolve.js";

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 10_000;

/**
 * The oldest Codex CLI this server has actually been verified against.
 *
 * It is not a claim that older releases fail — it is a statement about what was
 * tested. The flag set differs between CLI versions (see `docs/adr/0004`), so an
 * unverified version is reported as a warning, not an error: the delegation may
 * well work, and if it does not the CLI's own error is more informative than a
 * guess made here.
 */
export const VERIFIED_CODEX_VERSION = "0.154.0";

export type DiagnosisStatus =
  | "ok"
  | "missing"
  /** Found, but only as a Windows .cmd/.bat shim that cannot be spawned. */
  | "unsupported-shim"
  | "unauthenticated"
  | "unverified-version"
  | "unknown";

export interface Diagnosis {
  status: DiagnosisStatus;
  codexPath: string;
  /** Absolute path actually spawned, once resolved. */
  resolvedPath?: string;
  version: string | null;
  authenticated: boolean | null;
  /** One-line statement of what is wrong, or that everything is fine. */
  summary: string;
  /** Ordered, copy-pasteable steps the user runs themselves. */
  remediation: string[];
}

/** True when the CLI is usable enough to attempt a delegation. */
export function isUsable(diagnosis: Diagnosis): boolean {
  return diagnosis.status === "ok" || diagnosis.status === "unverified-version";
}

/**
 * The executable path a delegation should spawn.
 *
 * On Windows this is the absolute path the preflight resolved, because `spawn`
 * does not apply PATHEXT. Elsewhere it is the configured name, which `spawn`
 * resolves against PATH itself.
 */
export function executableFor(diagnosis: Diagnosis): string {
  return diagnosis.resolvedPath ?? diagnosis.codexPath;
}

/**
 * Why npm is listed last everywhere.
 *
 * The npm package is not the program: `bin/codex.js` is a Node wrapper that
 * spawns the real Rust binary. That costs a Node startup on every invocation —
 * measured at roughly 80 ms through the wrapper against 20 ms for the binary
 * directly. This server spawns the CLI once per tool call, so the overhead is
 * paid repeatedly, though it is still noise next to a delegation that runs for
 * seconds.
 *
 * The stronger reason is placement. An npm global install lands inside the
 * active Node version's tree, so under a version manager such as nvm, switching
 * Node versions takes `codex` off PATH until it is reinstalled. The standalone
 * installer and Homebrew put a self-contained binary somewhere stable and drop
 * the Node dependency entirely.
 */
const NPM_INSTALL_NOTE =
  "or, with npm (needs Node, and a global npm install is tied to the active Node version): " +
  "npm install -g @openai/codex";

/**
 * Installation steps for the detected platform, best option first.
 *
 * Taken from the official `@openai/codex` package README. This server never
 * runs them: installing software on the user's machine is the user's call, and
 * these commands pipe a remote script into a shell.
 */
export function installationSteps(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return [
      'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      NPM_INSTALL_NOTE,
    ];
  }
  if (platform === "darwin") {
    return [
      // Homebrew first: a self-contained binary, independent of Node, and the
      // cask resolves the right architecture for both Apple Silicon and Intel.
      "brew install --cask codex",
      "or, with the standalone installer: curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      NPM_INSTALL_NOTE,
    ];
  }
  return [
    "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    NPM_INSTALL_NOTE,
  ];
}

/** Extracts "0.154.0" from the `codex --version` output ("codex-cli 0.154.0"). */
export function parseVersion(output: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? match[0] : null;
}

/** Returns -1, 0 or 1 comparing dotted numeric versions. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/** Builds a diagnosis from already-collected probe results. Pure, for testing. */
export function diagnose(input: {
  codexPath: string;
  version: string | null;
  authenticated: boolean | null;
  platform?: NodeJS.Platform;
  /** Set when the CLI was found only as an unrunnable Windows shim. */
  shimPath?: string;
}): Diagnosis {
  const { codexPath, version, authenticated, platform = process.platform } = input;
  const base = { codexPath, version, authenticated };

  if (input.shimPath) {
    return {
      ...base,
      status: "unsupported-shim",
      summary:
        `The Codex CLI was found at "${input.shimPath}", but that is a batch shim rather than an ` +
        "executable. Windows cannot run it without going through a command shell, and this server " +
        "never uses one, so the CLI cannot be launched. A global npm install produces exactly this.",
      remediation: [
        "Install the Codex CLI as a real executable instead:",
        'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
        "Then open a new terminal so the updated PATH is picked up.",
        "Alternatively, set the CODEX_BIN environment variable to the full path of codex.exe.",
      ],
    };
  }

  if (version === null) {
    return {
      ...base,
      status: "missing",
      summary:
        `The Codex CLI could not be run as "${codexPath}". This server delegates to the Codex CLI, ` +
        "so nothing will work until it is installed and on PATH.",
      remediation: [
        "Install the Codex CLI, then reconnect this MCP server:",
        ...installationSteps(platform),
        "Then sign in by running: codex",
        'If Codex is installed under a different name or path, set the CODEX_BIN environment variable to it.',
      ],
    };
  }

  if (authenticated === false) {
    return {
      ...base,
      status: "unauthenticated",
      summary:
        `The Codex CLI ${version} is installed but no account is signed in, so every delegation will fail.`,
      remediation: [
        "Sign in by running: codex",
        'Choose "Sign in with ChatGPT", or use an API key: printenv OPENAI_API_KEY | codex login --with-api-key',
        "Confirm with: codex login status",
      ],
    };
  }

  if (compareVersions(version, VERIFIED_CODEX_VERSION) < 0) {
    return {
      ...base,
      status: "unverified-version",
      summary:
        `The Codex CLI ${version} is older than ${VERIFIED_CODEX_VERSION}, the oldest version this server ` +
        "has been verified against. Delegations may still work, but flags or event shapes may differ.",
      remediation: [
        "Update the Codex CLI: codex update",
        "If that is not possible, expect argument errors from the CLI and report them as an issue.",
      ],
    };
  }

  return {
    ...base,
    status: "ok",
    summary: `The Codex CLI ${version} is installed and signed in.`,
    remediation: [],
  };
}

/** Renders a diagnosis as the text a tool hands back. */
export function formatDiagnosis(diagnosis: Diagnosis): string {
  const lines = [diagnosis.summary];
  if (diagnosis.remediation.length > 0) {
    lines.push("", ...diagnosis.remediation);
  }
  return lines.join("\n");
}

let cached: Diagnosis | null = null;

export interface DoctorOptions {
  refresh?: boolean;
  codexPath?: string;
}

/**
 * Probes the local Codex CLI: is it there, which version, is it signed in.
 *
 * Cached for the process lifetime unless refreshed, because it runs two child
 * processes and the answer rarely changes mid-session. A failed probe is not
 * cached, so installing Codex and retrying works without a restart.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<Diagnosis> {
  const { refresh = false, codexPath = process.env.CODEX_BIN ?? "codex" } = options;

  if (!refresh && cached && cached.status === "ok" && cached.codexPath === codexPath) {
    return cached;
  }

  const resolved = resolveCodexExecutable(codexPath);
  if (resolved.kind === "shim" && resolved.shimPath) {
    return diagnose({
      codexPath,
      version: null,
      authenticated: null,
      shimPath: resolved.shimPath,
    });
  }
  if (resolved.kind === "not-found" || resolved.path === null) {
    return diagnose({ codexPath, version: null, authenticated: null });
  }

  const target = resolved.path;

  let version: string | null = null;
  try {
    const { stdout } = await execFileAsync(target, ["--version"], {
      timeout: PROBE_TIMEOUT_MS,
    });
    version = parseVersion(stdout);
  } catch {
    return diagnose({ codexPath, version: null, authenticated: null });
  }

  // A zero exit from `codex login status` means a session exists; the wording of
  // the message varies by auth method, so the exit code is the signal.
  //
  // Verified against the real CLI: signed in exits 0 ("Logged in using ChatGPT"),
  // signed out exits 1 ("Not logged in").
  let authenticated: boolean | null = null;
  try {
    await execFileAsync(target, ["login", "status"], { timeout: PROBE_TIMEOUT_MS });
    authenticated = true;
  } catch {
    authenticated = false;
  }

  const diagnosis: Diagnosis = {
    ...diagnose({ codexPath, version, authenticated }),
    resolvedPath: target,
  };
  if (diagnosis.status === "ok") cached = diagnosis;
  return diagnosis;
}

/** Clears the cached diagnosis. Intended for tests. */
export function resetDoctorCache(): void {
  cached = null;
}
