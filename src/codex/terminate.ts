import { execFile } from "node:child_process";

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

export function signalProcessTree(
  _target: TreeTarget,
  _signal: NodeJS.Signals,
  _deps: TreeKillDeps = {},
): void {
  void execFile;
  throw new Error("not implemented");
}

export function processGroupAlive(_pid: number | undefined, _deps: TreeKillDeps = {}): boolean {
  throw new Error("not implemented");
}
