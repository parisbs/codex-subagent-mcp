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

While on 0.x, a breaking change increments the minor (0.4.0 to 0.5.0) and everything else the patch,
which is the common reading of semver before 1.0.

## What 1.0 requires

1.0 is not a milestone to be reached by declaration. It requires:

1. A real delegation verified on Windows and Linux, not just build, tests and startup. CI covers the
   latter today; the former has never been run.
2. The recommendation matrix informed by actual usage rather than by the catalog's own positioning.
3. The tool interface unchanged across several releases, demonstrated rather than intended.
4. A settled answer on whether background jobs must survive a restart.

Until then the leading digit stays at 0, and the release notes carry the detail.

## Release notes

Every release states what changed, what broke, and the Codex CLI version it was verified against.
That last one matters more than usual here: a release verified against a newer CLI may behave
differently on an older one, and the preflight reports that as `unverified-version` rather than
guessing.
