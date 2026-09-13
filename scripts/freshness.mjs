#!/usr/bin/env node
/**
 * SessionStart hook: state the repo's actual position before the agent assumes one.
 * The sharpest staleness failures — reviewing a cached stale branch, missing a rename, arguing
 * about PR state — all start from an unstated assumption about HEAD.
 *
 * Informational, so it fails OPEN, but it no longer hides what it could not do. It used to swallow
 * a failed `git fetch` and then report ahead/behind counts computed from stale remote refs under
 * the heading "verified, not assumed". A failed fetch is now stated in the context itself, and a
 * payload it cannot read is reported instead of silently falling back to process.cwd().
 */
import { execFileSync } from "node:child_process";
import { addContext, readPayload, reportError } from "./hook-lib.mjs";

/** Run git; returns { ok, out, err } so a caller can tell "not applicable" from "failed". */
const git = (args, cwd, timeout = 5000) => {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim();
    return { ok: true, out };
  } catch (err) {
    const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
    const detail = err?.code === "ETIMEDOUT" || err?.signal === "SIGTERM" ? `timed out after ${timeout} ms` : stderr || err?.message;
    return { ok: false, out: null, err: String(detail ?? "unknown error").split("\n")[0] };
  }
};

async function main() {
  const input = await readPayload();
  if (typeof input.cwd !== "string" || !input.cwd) throw new Error("payload has no cwd, so repository state was not checked");
  const cwd = input.cwd;

  const inside = git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!inside.ok || inside.out !== "true") return; // not a repo; nothing to say

  const branch = git(["symbolic-ref", "--short", "HEAD"], cwd);
  const lines = [`Branch: ${branch.ok ? branch.out : "(detached)"}`];

  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  if (upstream.ok) {
    // Bounded fetch: freshness is worth a few seconds, not a stalled session start.
    const fetched = git(["fetch", "--quiet", "--no-tags"], cwd, 12000);
    if (!fetched.ok) {
      lines.push(`WARNING: git fetch failed (${fetched.err}). The counts below use remote refs from the last successful fetch and may be stale.`);
    }
    const counts = git(["rev-list", "--left-right", "--count", `${upstream.out}...HEAD`], cwd);
    if (counts.ok) {
      const [behind, ahead] = counts.out.split(/\s+/).map(Number);
      lines.push(`Upstream: ${upstream.out} — ${ahead} ahead, ${behind} behind`);
      if (behind > 0) lines.push(`WARNING: local is ${behind} commit(s) behind ${upstream.out}. Pull before reviewing or reasoning about current state.`);
    } else {
      lines.push(`Upstream: ${upstream.out} — ahead/behind could not be computed (${counts.err})`);
    }
  } else {
    lines.push("Upstream: none (branch not pushed)");
  }

  const head = git(["rev-parse", "--short", "HEAD"], cwd);
  lines.push(head.ok ? `HEAD: ${head.out}` : "HEAD: none (no commits yet)");
  const dirty = git(["status", "--porcelain"], cwd);
  if (!dirty.ok) lines.push(`Uncommitted changes: unknown (${dirty.err})`);
  else if (dirty.out) lines.push(`Uncommitted changes: ${dirty.out.split("\n").length} file(s)`);

  addContext(
    "SessionStart",
    `Repository state at session start (verified, not assumed):\n${lines.join("\n")}\n` +
      `When stating what is on a branch or in a PR, cite this HEAD sha so the claim is falsifiable.`,
  );
}

main().catch((err) => reportError("freshness", `repository state was not checked — ${err?.message ?? err}`));
