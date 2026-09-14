---
description: Check durable cross-session notes before investigating anything, and record findings after. Use at the start of any investigation, when a question feels like it may have been answered before, and after establishing a durable conclusion.
---

# Recall before re-deriving

The `note_*` tools are a durable store for conclusions that should outlive a session.

## Before investigating

Call `note_search` with the subject. Read the `caveat` and `drift` fields, not just the body:

- `drift: unchanged` — the conclusion still stands on the same ground.
- `drift: changed` — the files it describes have been edited since. Re-verify before relying on it.
- `status: superseded` — a later note replaced it; follow `supersededBy`.
- `status: retracted` — a recorded wrong turn. Do not repeat it.

When the subject has structure — a type layout, an offset table, an algorithm's parameters — also
call `note_query` with that schema and a filter on the field you care about (for example
`fields[].type` or `entries[].name`). It returns every matching record, not a ranking. Read its
`invalid` and `malformedFiles` lists too: a record there exists but couldn't be trusted as current.

Cite the note id when you use one, so the reasoning stays traceable.

## After establishing something durable

Call `note_write` when a conclusion would be expensive to re-derive and will still matter next
week. Always pass `files`; their content hashes let a later search report drift.

When the conclusion is structured data that matches a shipped schema (`note_schemas` lists them),
pass `schema` and `data` as well, so it can be queried by field later. `title` and `body` are still
required: say in prose how the record was established.

Worth recording: non-obvious constraints, why an approach was rejected, the actual root cause of a
bug, an invariant that isn't visible in the code.

Not worth recording: anything the code, tests, or git history already state plainly; facts that
only matter inside this session.

## When you find you were wrong

Do not delete the old note. Write the new one with `supersedes: ["<old-id>"]`, or call
`note_supersede`. The earlier belief is kept at reduced standing.
