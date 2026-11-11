# Follow-up writable roots against the real Codex CLI (#197)

Recorded on 2026-11-10 on macOS (Intel) for AC-9 of issue #197, with codex-cli 0.154.0 (the floor),
0.163.0 (the newest verified release) and 0.167.0 (the newest installed). Each binary ran real
`codex exec` and `codex exec resume` turns, with the real macOS sandbox and real session files, in
an isolated `CODEX_HOME`, against a local stand-in for the Responses API that answers each turn with
one shell command. No model ran and no quota was spent; what was tested is the CLI and its sandbox,
not model behaviour.

The argv of each turn came from this server's own `buildCodexArgs` (`build/codex/args.js`):

1. A delegation in `workspace-write` with `add_dirs` set to an extra directory outside the working
   directory, writing a file there.
2. A resume in `workspace-write` without writable roots (the behaviour before #197), writing a
   second file.
3. A resume in `workspace-write` with the extra directory as writable roots, which the server
   passes as one `--config sandbox_workspace_write.writable_roots=[...]` element, writing a third
   file.

Result, identical on all three releases:

- Turn 1 wrote its file and recorded `writable_roots: ["<extra>"]`.
- Turn 2 was denied (`operation not permitted`) and recorded no `writable_roots` key.
- Turn 3 wrote its file and recorded `writable_roots: ["<extra>"]` again.

Observations from the same experiments, also identical on the three releases:

- Codex adds no writable root on its own. A git repository, a plain directory and a subdirectory
  as the working directory record none; a `<repo>/.git` entry appears only when
  `--add-dir <repo>/.git` is passed.
- A `read-only` turn records only `{"type":"read-only"}`, so the extra directories of a read-only
  delegation cannot be recovered from the session file.
- Recorded roots are absolute and lexically normalized (a trailing slash and `..`); symlinks are kept
  as given, nonexistent directories are kept, duplicates are collapsed and a root equal to the
  working directory is dropped.
- The override replaces `writable_roots` from Codex configuration for that turn rather than adding
  to it; a resume without it keeps the configured roots.
- Each path written as a JSON string, with DEL escaped as `\u007f`, parses back exactly, quotes,
  backslashes, control characters and non-ASCII included. An override that is not valid TOML makes
  Codex refuse to start.
- Out of scope for #197: a writable root containing a double quote makes every command of the turn
  fail on macOS (`sandbox-exec` exits 65), with plain `codex exec --add-dir` as well.
