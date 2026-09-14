# Versioning

This project follows [Semantic Versioning](https://semver.org). What that means in practice depends
entirely on what counts as the public API, so this document defines it.

## Why 0.x

The public surface of this package is not only its own tools. It is also the coupling to the Codex
CLI, a third-party program that is itself pre-1.0, changes flags between releases, and promises no
stability.

Three incompatibilities were found inside a single CLI version while building this:

- `codex exec resume` rejects flags that `codex exec` accepts.
- `--approve-for-me` cannot be combined with `--sandbox`.
- Codex emits in-band `error` items that do not change the process exit code.

Declaring 1.0 would promise that breaking changes arrive only in a major release. Half of this
project's behaviour depends on something it does not control, so that promise cannot be kept. 0.x
says what is true: the interface may change while the ground underneath it is still moving.

The honest counter-argument is that some users and some corporate policies avoid 0.x dependencies.
That cost is accepted. Claiming a stability that cannot be delivered would be worse, and would cost
more at exactly the moment someone depends on it.

## What counts as a breaking change

Regardless of the leading digit, all of these are breaking:

- Renaming or removing a tool.
- Removing a parameter, or making an optional one required.
- Changing a default in a way that changes what happens: for example `sandbox` from `read-only` to
  something that can write, or `mode` from `blocking` to `background`.
- Raising the minimum Codex CLI version at which the server refuses to run.
- Raising the minimum Node version in `engines`.
- Changing the shape of a tool's result such that an orchestrator parsing it would break.

These are not breaking:

- Adding a tool, or an optional parameter with a backward-compatible default.
- New models appearing in `list_codex_models`. The catalog is read from the installed CLI at
  runtime, so it changes without any release here — that is the design, not a regression.
- Changes to the recommendation matrix in `src/recommend.ts`. It is advice, and it is already
  reconciled against the live catalog on every call.
- Wording changes in diagnostics, summaries or remediation steps.

## How the version number moves while on 0.x

Semantic Versioning deliberately sets no rules for 0.x, so this project sets its own. There is one
rule per kind of change, and a release takes the highest bump any change in it requires:

| Change in the release | Bump | Example |
|---|---|---|
| Anything breaking, as defined above | minor | 0.4.2 → 0.5.0 |
| A new tool, a new optional parameter, a new environment variable | minor | 0.4.2 → 0.5.0 |
| Only fixes, including security fixes, with no new surface | patch | 0.4.2 → 0.4.3 |

The minor carries both breaking and additive changes because that is how npm reads 0.x. A caret range
such as `^0.4.0` accepts 0.4.3 but not 0.5.0, so anyone pinned that way receives fixes automatically
and never receives new or changed behaviour without choosing to. A patch that added a tool would
reach them uninvited; a minor that only fixed a bug would withhold the fix. Tying the bump to what a
caret range lets through avoids both.

Most people run this server through `npx -y codex-subagent-mcp`, which always resolves the latest
version and ignores these ranges entirely. The rule still matters for anyone who installs it as a
dependency, and for security advisories, whose patched version is what `npm audit` compares against.

After 1.0 the ordinary rules apply: breaking changes bump the major.

## Milestones and version numbers

A GitHub milestone is named after the version its work is expected to ship as. That name is a
forecast, not a promise, until the release is published: if a change that requires a higher bump is
added to it, the milestone is renamed and every later milestone moves up with it. The number is
settled at publication and never reused.

## Supported Node versions

The supported floor is the oldest Node line that has not reached end-of-life on the day of the
release, according to the official schedule at
[nodejs/Release](https://github.com/nodejs/Release). `engines` in `package.json`, the CI matrix and
`@types/node` all follow that line together; `@types/node` tracks the floor rather than the newest
Node, so the compiler rejects APIs the floor does not have.

Dropping a line is breaking, and therefore a minor bump while on 0.x, even when that line is already
end-of-life. It is done at the first release after the line's end-of-life date, never earlier: a line
that still receives security fixes stays supported.

## What 1.0 requires

1.0 is not a milestone to be reached by declaration. It requires:

1. A real delegation verified on Windows and Linux against the actual Codex CLI. CI now exercises
   the whole delegation cycle on all three platforms against a stand-in — spawning, stdin, JSONL
   parsing, exit codes and stderr — which covers the code this project owns. What remains unverified
   off macOS is the coupling itself: that the installed CLI accepts the argv built here and emits the
   events parsed here. That needs an authenticated CLI, which CI cannot have.
2. The recommendation matrix informed by actual usage rather than by the catalog's own positioning.
3. The tool interface unchanged across several releases, demonstrated rather than intended.
4. A settled answer on whether background jobs must survive a restart.

Until then the leading digit stays at 0, and the release notes carry the detail.

## Release notes

Every release states what changed, what broke, and the Codex CLI version it was verified against.
That last one matters more than usual here: a release verified against a newer CLI may behave
differently on an older one, and the preflight reports that as `unverified-version` rather than
guessing.

`CHANGELOG.md` is written once per release, while preparing the publish, from the pull requests the
release contains. Individual pull requests do not edit it. Entries written ahead of time describe
what was planned rather than what shipped, and they turn every pair of parallel branches into a merge
conflict over the same few lines.
