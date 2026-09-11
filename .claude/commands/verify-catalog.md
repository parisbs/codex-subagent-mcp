---
description: Check the model catalog code against the installed Codex CLI
allowed-tools: Bash(codex debug models), Bash(codex --version), Bash(npm test), Read, Grep
---

The Codex model catalog changes when OpenAI ships new models. Confirm this repository still
describes reality.

1. Run `codex --version` and `codex debug models | jq -r '.models[] | select(.visibility=="list") | "\(.slug) default=\(.default_reasoning_level) efforts=[\([.supported_reasoning_levels[].effort] | join(","))]"'`.
2. Compare that output with `FALLBACK_MODELS` in `src/codex/catalog.ts`. The fallback is only used
   when the CLI is unreachable, but a stale fallback still misleads callers — update it if the real
   catalog has moved.
3. Compare it with the tiers in `src/recommend.ts`. Every `model` and `alternatives` slug must exist
   in the live catalog, and every tier's `effort` must be one the tier's model actually supports.
4. Check the model table in `README.md` and the fixtures in `test/catalog.test.ts` and
   `test/recommend.test.ts`.
5. Run `npm test`.

Report what drifted and what you changed. If nothing drifted, say so in one line — do not edit
files just to have something to show.
