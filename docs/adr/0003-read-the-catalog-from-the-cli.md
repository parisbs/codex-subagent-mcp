# 3. Read the model catalog from the CLI at runtime

Status: Accepted

## Context

The prototype hardcoded a model map: `gpt-4o-mini`, `gpt-4o`, `o1`, `o3`. By the time it was
reviewed, none of those were in the Codex catalog. Every delegation that specified a reasoning level
sent an invalid slug to the CLI.

That is the predictable failure of a hardcoded list against a catalog that ships new models
regularly. The list does not announce that it is stale; it just starts being wrong.

`codex debug models` renders the catalog the installed CLI actually knows about, as JSON. It runs
locally in about 120 ms with no network call. It carries everything the server needs: slug, display
name, description, default reasoning level, the supported effort list, context windows, input
modalities and a visibility flag that marks internal models.

## Decision

Read the catalog from `codex debug models` at runtime and cache it in-process for ten minutes.
Normalise each entry down to the fields the server uses, discarding the per-model system prompts
that make the raw payload about 350 KB.

Filter to `visibility == "list"`, which excludes internal routing targets such as `gpt-reserve` and
`codex-auto-review`, and sort by the catalog's own `priority`.

Keep a static `FALLBACK_MODELS` list for when the CLI cannot be reached, but never cache it, and
always return it with an explicit warning that the data may be out of date.

## Consequences

New Codex models become available through this server the moment the user updates their CLI. No
release of this project is needed, and there is no list that can quietly rot.

The recommendation matrix still names specific slugs, so it can drift even though the catalog
cannot. It is reconciled against the live catalog on every call: a missing model falls back to a
declared alternative, and an unsupported effort is clamped. The `/verify-catalog` command exists to
catch the drift at the source.

Startup depends on the CLI being present. A missing CLI degrades to the fallback list with a
warning rather than failing outright, so `list_codex_models` still explains what is wrong instead of
returning an opaque error.

The ten-minute cache means a model added mid-session is not visible until it expires. `refresh: true`
forces a re-read.
