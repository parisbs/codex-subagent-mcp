import { execFile } from "node:child_process";
import { win32 } from "node:path";

/** The process a run started, as termination sees it. */
export interface TreeTarget {
  /** Undefined when the spawn never produced a process. */
  pid: number | undefined;
  /** False once the process has exited and been reaped; its pid may be reused. */
  alive: boolean;
}

export interface TreeKillDeps {
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  execFile?: (
    file: string,
    args: string[],
    options: { windowsHide: boolean; shell: false },
    callback: (error: Error | null) => void,
  ) => void;
  /** `%SystemRoot%`, where `taskkill.exe` lives. */
  systemRoot?: string;
}

/**
 * Signals everything a run started, not only the Codex process.
 *
 * Codex runs commands, and those are the runner's grandchildren: signalling the
 * CLI alone left them running, and one holding the inherited stdout kept the
 * result from settling (#96).
 *
 * On POSIX the CLI is spawned as the leader of its own process group, so one
 * signal to the group reaches every command that stayed in it — including after
 * the leader has exited, when the group is the only handle left on them. The
 * bare pid is signalled only as a fallback while the child is alive: once it has
 * been reaped, that pid can belong to someone else.
 *
 * Windows has neither process groups to signal nor SIGTERM. `taskkill /T` walks
 * parent links, so it reaches descendants only while the leader is alive, and
 * afterwards the pid may be recycled; it is therefore run only for a live child,
 * always forced (`/F`, since console programs ignore the polite form), and never
 * through a shell (ADR 4).
 *
 * A descendant that starts its own session or group leaves the tree and is out
 * of reach on every platform.
 */
export function signalProcessTree(
  target: TreeTarget,
  signal: NodeJS.Signals,
  deps: TreeKillDeps = {},
): void {
  const { pid, alive } = target;
  if (pid === undefined) return;

  if ((deps.platform ?? process.platform) === "win32") {
    if (!alive) return;
    const run =
      deps.execFile ??
      ((file, args, options, callback) => {
        execFile(file, args, options, (error) => callback(error));
      });
    const root = deps.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
    run(win32.join(root, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
    }, () => {
      // Best effort: a tree that is already gone is the outcome wanted.
    });
    return;
  }

  const kill = deps.kill ?? ((target, sig) => process.kill(target, sig));
  try {
    kill(-pid, signal);
  } catch {
    if (!alive) return;
    try {
      kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Whether any process is left in a POSIX process group.
 *
 * Used when the leader has exited during termination: a member that ignored the
 * polite request must still get the forced one, but an empty group's id may be
 * reused and must not be signalled. Always false on Windows, which has no group
 * to ask about.
 */
export function processGroupAlive(pid: number | undefined, deps: TreeKillDeps = {}): boolean {
  if (pid === undefined || (deps.platform ?? process.platform) === "win32") return false;
  const kill = deps.kill ?? ((target, sig) => process.kill(target, sig));
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM: the group exists but belongs to someone else's privileges.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One row of the process table. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
}

export interface DescendantDeps {
  platform?: NodeJS.Platform;
  /** The process table; defaults to `ps -A -o pid=,ppid=,pgid=`. */
  listProcesses?: () => ProcessEntry[];
  /** This server's own process group, which is never recorded. */
  ownPgid?: number;
}

export function parseProcessTable(_text: string): ProcessEntry[] {
  throw new Error("not implemented");
}

export function descendantGroups(_rootPid: number | undefined, _deps: DescendantDeps = {}): number[] {
  throw new Error("not implemented");
}

export function signalGroups(_pgids: number[], _signal: NodeJS.Signals, _deps: TreeKillDeps = {}): void {
  throw new Error("not implemented");
}
