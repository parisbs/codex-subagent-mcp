---
paths:
  - "src/codex/runner.ts"
  - "src/codex/terminate.ts"
  - "src/shutdown.ts"
  - "test/{runner,runner-shutdown,terminate,termination,shutdown,doctor-shutdown,process-table-gate}.test.ts"
  - "test/fixtures/{stubborn-codex.mjs,process-alive.ts}"
---

# Stopping Codex and what it started

Termination targets the process tree, not the Codex process (`src/codex/terminate.ts`). On POSIX the
CLI leads its own process group and the group is signalled, even after Codex exits; a bare pid is
never signalled once reaped. Windows `taskkill /T /F` runs only while the leader lives.
`test/termination.test.ts` covers all three platforms with a stand-in that starts a descendant.

The real CLI does not keep its commands in that group (verified on 0.159.2): each shell command and
helper leads a process group of its own, and on SIGTERM Codex exits and leaves them running, while
on SIGINT it kills them. So the polite signal is SIGINT, and the groups of Codex's descendants are
read from `ps` while Codex is still alive and included in the forced stage. The stand-in reproduces
this with `descendant.ownGroup`; a stand-in without it passes while the real CLI leaks commands.

Shutdown has a budget set by the host: Claude Code 2.1.285 sends SIGINT, SIGTERM 100 ms later and
SIGKILL about half a second after the first signal, and never closes stdin first. `src/shutdown.ts`
fits inside it (SIGKILL at 250 ms, exit by 300 ms); do not reuse the five-second cancellation grace
there, and re-measure with a probe MCP server when the host changes. Reading the process table takes
about 30 ms on a developer Mac and 130 ms on GitHub's macOS runner, so runs stopped together share
one SIGKILL instant counted from the request, and a shutdown reads the table once, before the polite
signal, abandoned after `SHUTDOWN_TABLE_TIMEOUT_MS`, and not again before SIGKILL. Reading after
killing Codex would not help: its children are reparented at once. Test this schedule on a mocked
clock; a test that times real processes measures the machine.

The signal tests in `test/runner.test.ts` and the descendant-holds-the-pipes test stay POSIX-only:
Windows has no SIGTERM to ignore, and there `close` arrives as soon as the parent exits even when a
descendant inherited its stdout. Both are platform differences, not gaps.
