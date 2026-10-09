import { spawnSync } from "node:child_process";

const POSIX = process.platform !== "win32";

/**
 * Whether a process still runs. A POSIX zombie answers `kill(pid, 0)` but runs
 * nothing and only waits to be reaped, which under load can take longer than a
 * test waits (#116), so it counts as stopped. The `ps` read is bounded so that a
 * slow process table cannot hang the suite.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!POSIX) return true;
  const read = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
  // An unreadable table proves nothing, so the process counts as running.
  if (read.error || read.signal) return true;
  const state = read.stdout.trim();
  return state !== "" && !state.startsWith("Z");
}
