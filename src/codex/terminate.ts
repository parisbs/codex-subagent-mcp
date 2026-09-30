import { execFile, spawnSync } from "node:child_process";
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

/** Parses `ps -A -o pid=,ppid=,pgid=`; lines that are not three integers are skipped. */
export function parseProcessTable(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || !fields.every((field) => /^\d+$/.test(field))) continue;
    const [pid, ppid, pgid] = fields.map(Number) as [number, number, number];
    entries.push({ pid, ppid, pgid });
  }
  return entries;
}

export interface ProcessTableOptions {
  /** Abandons the read after this long; a shutdown cannot wait for a slow `ps` (#116). */
  timeoutMs?: number;
  /** The listing command; replaceable so a test can stand in for a `ps` that hangs. */
  command?: string;
  args?: string[];
}

/**
 * Reads the whole process table with `ps`: synchronous, about 30 ms on a
 * developer Mac and about 130 ms on GitHub's macOS runner. Throws when the
 * listing fails or does not answer within `timeoutMs`.
 */
export function readProcessTable(options: ProcessTableOptions = {}): ProcessEntry[] {
  const result = spawnSync(options.command ?? "ps", options.args ?? ["-A", "-o", "pid=,ppid=,pgid="], {
    shell: false,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 2000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(result.error?.message ?? `ps exited ${result.status}`);
  }
  return parseProcessTable(result.stdout);
}

/**
 * A reader that runs `read` on its first call and returns that answer, or
 * rethrows that failure, on every later one. Runs stopped together share one,
 * so the table is read once per stage rather than once per run (#112).
 */
export function readOnce(read: () => ProcessEntry[]): () => ProcessEntry[] {
  let outcome: { table: ProcessEntry[] } | { error: unknown } | undefined;
  return () => {
    if (!outcome) {
      try {
        outcome = { table: read() };
      } catch (error) {
        outcome = { error };
      }
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.table;
  };
}

function ownProcessGroup(table: ProcessEntry[]): number | undefined {
  return table.find((entry) => entry.pid === process.pid)?.pgid;
}

/**
 * The process groups of everything Codex started that left its group (#107).
 *
 * Verified against codex-cli 0.159.2: each shell command, and each helper
 * (`codex-code-mode-host`, `node_repl`, plugin launchers), leads a process
 * group of its own, so a signal to Codex's group never reaches it; on SIGTERM
 * Codex exits and leaves the command running. The groups are read from the
 * process table while Codex is alive, because once it exits its children are
 * reparented and can no longer be told apart from anyone else's.
 *
 * Never records Codex's own group (signalled separately), this server's group,
 * or init's. Returns nothing on Windows, where `taskkill /T` walks the tree, and
 * nothing when the table cannot be read: termination then does what it did
 * before, which is the most it could do.
 */
export function descendantGroups(rootPid: number | undefined, deps: DescendantDeps = {}): number[] {
  if (rootPid === undefined || (deps.platform ?? process.platform) === "win32") return [];
  let table: ProcessEntry[];
  try {
    table = (deps.listProcesses ?? (() => readProcessTable()))();
  } catch {
    return [];
  }

  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry);
    children.set(entry.ppid, siblings);
  }
  const rootGroup = table.find((entry) => entry.pid === rootPid)?.pgid ?? rootPid;
  const excluded = new Set([rootGroup, deps.ownPgid ?? ownProcessGroup(table), 0, 1]);

  const groups = new Set<number>();
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
      if (!excluded.has(child.pgid)) groups.add(child.pgid);
    }
  }
  return [...groups];
}

/**
 * Signals each recorded process group. Only groups: a bare pid is never
 * signalled here, and a group that has emptied is simply skipped.
 */
export function signalGroups(pgids: number[], signal: NodeJS.Signals, deps: TreeKillDeps = {}): void {
  const kill = deps.kill ?? ((target, sig) => process.kill(target, sig));
  for (const pgid of pgids) {
    try {
      kill(-pgid, signal);
    } catch {
      // Already gone.
    }
  }
}
