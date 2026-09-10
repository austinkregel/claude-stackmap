---
description: Check durable cross-session notes before investigating anything, and record findings after. Use at the start of any investigation, when a question feels like it may have been answered before, and after establishing a durable conclusion.
---

# Recall before re-deriving

Sessions have no memory of each other, so context a previous session already established gets
re-derived from scratch — the same API re-fetched, the same sources re-read by parallel subagents,
a prior investigation restated because there was nothing to reference. The cause is structural:
**there is no durable cross-session knowledge store.** These tools are that store.

## Before investigating

Call `note_search` with the subject. Read the `caveat` and `drift` fields, not just the body:

- `drift: unchanged` — the conclusion still stands on the same ground.
- `drift: changed` — the files it describes have been edited since. Re-verify before relying on it.
- `status: superseded` — a later note replaced it; follow `supersededBy`.
- `status: retracted` — a recorded wrong turn. Do not repeat it.

Cite the note id when you use one, so the reasoning stays traceable.

## After establishing something durable

Call `note_write` when a conclusion would be expensive to re-derive and will still matter next
week. Always pass `files` — the content hashes are what let a future search say whether the
conclusion has gone stale.

Worth recording: non-obvious constraints, why an approach was rejected, the actual root cause of a
bug, an invariant that isn't visible in the code.

Not worth recording: anything the code, tests, or git history already state plainly; facts that
only matter inside this session.

## When you find you were wrong

Do not delete the old note. Write the new one with `supersedes: ["<old-id>"]`, or call
`note_supersede`. The earlier belief is kept at reduced standing because it is still evidence of
what was thought and why — which is what stops the same wrong turn being taken twice.
