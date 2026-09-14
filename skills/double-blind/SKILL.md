---
description: Verify a factual claim with agents using different methods, blind to each other, then an adversarial audit of the leading answer. Use when being wrong is expensive and ground truth exists to check against.
argument-hint: "<claim or question> [ref]"
---

# Double-blind investigation

Question: **$ARGUMENTS**

> **Enforced.** Invoking this skill arms a `Stop` hook. The turn cannot end until the final
> message carries the closing block in step 7.

Not for design opinions, open exploration, or anything with no checkable answer.

## 1. State the claim so it can be proven wrong

Not "how does the audio system work", but "the wavebank header stores the sample count at offset
0x10 as a little-endian u32". If it can't be stated that way, stop and end with the abort line in
step 7.

## 2. Settle the base

Agents use `main` unless the question names a ref, in which case every agent uses that ref. If it
names none and the current branch isn't `main`, ask the user which ref to use before dispatching
anything. Commit pending work first if the ref is the current branch.

## 3. Assign different methods

Pick 2–3 that apply, one per agent. Never give two agents the same method.

| Method | Route to the answer |
|---|---|
| static | Read source, decompilation, or headers; reason from declared structure. |
| dynamic | Run it: probe live state, set a watchpoint, instrument, observe. |
| byte-level | Read the raw bytes; ignore what anything claims they mean. |
| differential | Compare known-good against known-bad, or two versions, and diff. |
| documentary | Notes (`note_search`), upstream docs, the spec, prior art. |
| reconstructive | Build a minimal thing that would produce the observed output, and see if it does. |

## 4. Dispatch, blind to each other

Run the agents in parallel, each with `isolation: "worktree"`. Each brief carries:

- the claim, worded identically across agents;
- the base: check out the ref (or `main`) with `git checkout --detach <ref>` first, since the
  worktree starts at the remote's default branch; switch back to the starting branch before the
  final message;
- this agent's method, and an instruction not to use the others;
- 3–5 concrete paths to read first;
- the evidence bar: every finding cites `file:line`, an address, a symbol, or the exact command;
- confidence grading: PROVEN (checked against ground truth this run) / INFERRED / SPECULATIVE;
- "Your final message is the deliverable. Include what you could not determine."

No agent sees another's brief, findings, or existence. Every agent has full access to ground truth.

## 5. Compare

- **Divergent**: find which evidence settles it.
- **Convergent, each PROVEN by a different method**: the strongest result available.
- **Convergent but INFERRED**: unconfirmed. Agreement without verification is correlated error.

## 6. Adversarial audit (always)

Dispatch `stackmap:adversarial-auditor` with the leading answer as the claim, the evidence behind
it, and the same ref. Its verdict is FALSIFIED, SURVIVED, or UNTESTED. If FALSIFIED, go back to
step 5 with its counter-evidence.

## 7. Report

1. The answer and its grade. If nothing reached PROVEN, say so in the first line.
2. How each agent got there: method and evidence, not just the conclusion.
3. Where they diverged, and which evidence settled it.
4. What the auditor tried, and its verdict.
5. What remains unverified.

Close with:

```
Double-blind on: <the falsifiable claim>
Base: <ref>@<short sha>
Methods: <method> — <PROVEN|INFERRED|SPECULATIVE>; <method> — <grade>
Adversarial wave: <FALSIFIED|SURVIVED|UNTESTED> — <what was actually tested>
Unverified: <what remains unproven, or "nothing">
```

If step 1 found nothing falsifiable, end instead with:

```
Double-blind aborted: <why there is nothing to check against>
```
