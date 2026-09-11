# 2. Treat model and reasoning effort as independent axes

Status: Accepted

## Context

The original prototype exposed a single `reasoning_level` parameter with values `low`, `medium`,
`high` and `extra`, and mapped each one onto a different model. "More reasoning" meant "a different
model".

That is not how Codex works. The CLI has two separate controls:

- `-m/--model` selects the model, which sets raw capability.
- `model_reasoning_effort`, a configuration key set with `-c`, selects how long that model
  deliberates before acting.

The catalog confirms they are orthogonal: `gpt-6-astra` supports six effort levels, and so does
`gpt-5.6-terra`. Collapsing them into one dial makes most of the grid unreachable — you cannot ask
the cheap model to think harder, or the capable model to answer quickly.

The effort values are also not a uniform set. `codex debug models` declares a supported list per
model: Astra, Sol and Terra reach `ultra`, Luna stops at `max`, and gpt-5.5 stops at `xhigh`.
Passing an unsupported value is an error the caller only discovers after the run starts.

## Decision

Expose `model` and `reasoning_effort` as separate parameters. Pass the model with `-m` and the
effort with `-c model_reasoning_effort="<value>"`.

Validate the requested effort against the chosen model's declared list. When it is not supported,
clamp to the nearest supported level and tell the caller what happened, rather than failing the
delegation over a recoverable mismatch.

## Consequences

The full grid of capability against deliberation is reachable, which is the point of having a
selection tool at all.

The orchestrator has two decisions to make instead of one. `codex_recommend` exists so it does not
have to make them from scratch every time.

Clamping trades strictness for usability. A caller asking for `ultra` on Luna gets `max` and a note,
not an error. The note matters: silently downgrading reasoning depth would let the orchestrator
believe it bought more deliberation than it did.
