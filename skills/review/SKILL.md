---
description: Review a diff, PR, or branch using differentiated reviewer roles and SHA-stamped claims instead of blind duplicate passes. Use when reviewing code, a PR, or a branch, and whenever tempted to run the same review more than once to double-check it.
argument-hint: "[PR number, branch, or path]"
---

# Differentiated review

Target: **$ARGUMENTS**

Review once per independent axis; do not repeat identical passes.

> **Enforced.** Invoking this skill arms a `Stop` hook. The turn cannot end until the final
> message carries a `Reviewed at <sha>` line. This is a precondition, not a suggestion.

## 1. Stamp the ground first

Before reading any code, record and state:

```
git rev-parse --short HEAD && git status --porcelain | wc -l
```

Every claim in the review is scoped to that sha. Write it into the output as
`reviewed at <sha>, fetched <timestamp>`.

If the target is a PR, confirm the sha you fetched matches the PR head. Do not review a cached
branch. The `SessionStart` freshness context states the local position; verify the remote one.

## 2. Check what is already known

Call `note_search` with the area under review before investigating, and read each hit's drift
report. If a note answers part of the review, cite its id rather than repeating it.

## 3. Review along independent axes, not in duplicate

Run **one** pass per axis. Skip an axis that plainly does not apply, and say that you skipped it.

| Axis | Looks for |
|---|---|
| Correctness | Logic errors, boundary conditions, error paths, a concrete failing input |
| Contract | API/schema/event-shape changes, backwards compatibility, callers not updated |
| Security | Authz, injection, secret handling, unsafe deserialization, SSRF |
| Performance | N+1s, unbounded queries/loops, memory growth, missing indexes |
| Operability | Logging, metrics, failure modes, migration/rollback safety |

## 4. Ground the verdict in non-LLM signal

Prefer, in order:

1. Run the tests. Report actual output, including failures.
2. Run the type-checker / linter.
3. Execute the specific path with a real input.
4. Only then, reasoned argument.

State which of these you actually did. "Looks correct" without a signal is not a verdict.

## 5. Report

For each finding: file:line, the axis, a concrete failure scenario, and the evidence type
(test / type-checker / execution / reasoning). Rank by severity.

Close with:

```
Reviewed at <sha>, <N> uncommitted file(s) present, <timestamp>.
Axes covered: <list>. Axes skipped: <list, with why>.
Verification: <what was actually run>.
```

## 6. Record what will outlive the session

If the review established something durable — a real constraint, a subtle invariant, a wrong turn
worth not repeating — call `note_write` with the affected files so the conclusion is stamped
against their content. Use `status: "retracted"` for a disproved earlier belief.
