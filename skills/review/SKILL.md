---
description: Review a diff, PR, or branch using differentiated reviewer roles and SHA-stamped claims instead of blind duplicate passes. Use when reviewing code, a PR, or a branch, and whenever tempted to run the same review more than once to double-check it.
argument-hint: "[PR number, branch, or path]"
---

# Differentiated review

Target: **$ARGUMENTS**

Review once per independent axis; do not repeat identical passes.

> **Enforced.** Invoking this skill arms a `Stop` hook. The turn cannot end until the final
> message carries the closing block in step 6.

## 1. Stamp the ground first

The target names the ref under review. If no target is given and the current branch isn't `main`,
ask the user which ref to review before going further.

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

## 5. Audit what you are about to report

Send every highest-severity finding, and every finding whose only evidence is reasoning, to
`stackmap:adversarial-auditor`, in parallel. Each brief gives the finding as a claim, its evidence,
and the reviewed ref. The auditor sees committed code only; a finding in an uncommitted file is
reported as unaudited.

- FALSIFIED: drop it from the findings and list it under "Falsified" with the counter-evidence.
- SURVIVED: keep it, citing what the auditor tested.
- UNTESTED: keep it, marked untested, with what the auditor needed.

## 6. Report

For each finding: file:line, the axis, a concrete failure scenario, the evidence type
(test / type-checker / execution / reasoning), and the audit verdict if it had one. Rank by
severity.

Close with:

```
Reviewed at <sha>, <N> uncommitted file(s) present, <timestamp>.
Axes covered: <list>. Axes skipped: <list, with why>.
Verification: <what was actually run>.
Audited: <n> — <n> survived, <n> falsified, <n> untested
```

If nothing met the bar for an audit, write `Audited: none — <why>`.

## 7. Record what will outlive the session

If the review established something durable — a real constraint, a subtle invariant, a wrong turn
worth not repeating — call `note_write` with the affected files so the conclusion is stamped
against their content. Use `status: "retracted"` for a disproved earlier belief.
