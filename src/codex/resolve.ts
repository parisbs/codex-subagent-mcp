import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, extname, sep } from "node:path";

/**
 * How the Codex executable was found, if at all.
 *
 * `shim` exists for Windows. `spawn` without a shell cannot run `.cmd` or
 * `.bat` files — Node deliberately refuses, because passing arguments to them
 * safely is not possible — yet a global npm install of the Codex CLI produces
 * exactly such a shim. Without this distinction the user is told Codex is not
 * installed while looking at a working install.
 */
export type ResolutionKind = "executable" | "shim" | "not-found";

export interface ResolvedCodex {
  kind: ResolutionKind;
  /** Absolute path to spawn, when `kind` is "executable". */
  path: string | null;
  /** The unusable shim that was found, when `kind` is "shim". */
  shimPath?: string;
}

/** Extensions Windows treats as batch scripts rather than real executables. */
const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExtensions(): string[] {
  const pathext = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return pathext
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Finds the Codex executable the same way a shell would, but without a shell.
 *
 * On POSIX the name is handed to `spawn` unchanged: it already searches PATH,
 * and second-guessing it would only add ways to be wrong. On Windows the search
 * is done here, because `spawn` does not apply PATHEXT and cannot run shims.
 */
export function resolveCodexExecutable(
  nameOrPath: string,
  platform: NodeJS.Platform = process.platform,
): ResolvedCodex {
  const looksLikePath =
    isAbsolute(nameOrPath) || nameOrPath.includes("/") || nameOrPath.includes(sep);

  if (platform !== "win32") {
    if (looksLikePath) {
      return isExecutableFile(nameOrPath)
        ? { kind: "executable", path: nameOrPath }
        : { kind: "not-found", path: null };
    }
    // Let spawn do the PATH search, as it always has.
    return { kind: "executable", path: nameOrPath };
  }

  const extensions = windowsExtensions();

  const classify = (candidate: string): ResolvedCodex | null => {
    try {
      if (!statSync(candidate).isFile()) return null;
    } catch {
      return null;
    }
    return WINDOWS_SHIM_EXTENSIONS.has(extname(candidate).toLowerCase())
      ? { kind: "shim", path: null, shimPath: candidate }
      : { kind: "executable", path: candidate };
  };

  const expand = (base: string): ResolvedCodex[] => {
    const results: ResolvedCodex[] = [];
    if (extname(base).length > 0) {
      const exact = classify(base);
      if (exact) results.push(exact);
    }
    for (const extension of extensions) {
      const found = classify(`${base}${extension}`);
      if (found) results.push(found);
    }
    return results;
  };

  // A real executable anywhere on PATH beats a shim: the shim cannot be run,
  // so preferring it would turn a working install into a failure.
  const candidates: ResolvedCodex[] = looksLikePath
    ? expand(nameOrPath)
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter((entry) => entry.length > 0)
        .flatMap((entry) => expand(join(entry, nameOrPath)));

  return (
    candidates.find((candidate) => candidate.kind === "executable") ??
    candidates.find((candidate) => candidate.kind === "shim") ?? {
      kind: "not-found",
      path: null,
    }
  );
}
