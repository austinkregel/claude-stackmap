#!/usr/bin/env node
/**
 * SessionStart hook: state the repo's actual position before the agent assumes one.
 * The sharpest staleness failures — reviewing a cached stale branch, missing a rename, arguing
 * about PR state — all start from an unstated assumption about HEAD.
 * Informational only, so it fails OPEN: a missing remote must not block a session.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (args, cwd, timeout = 5000) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout }).trim();
  } catch { return null; }
};

async function main() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  let input = {};
  try { input = JSON.parse(raw); } catch { /* fall back to cwd */ }
  const cwd = input.cwd || process.cwd();

  if (!git(["rev-parse", "--is-inside-work-tree"], cwd)) return; // not a repo; say nothing

  const branch = git(["symbolic-ref", "--short", "HEAD"], cwd) ?? "(detached)";
  // Bounded fetch: freshness is worth a few seconds, not a stalled session start.
  git(["fetch", "--quiet", "--no-tags"], cwd, 12000);

  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  const lines = [`Branch: ${branch}`];

  if (upstream) {
    const counts = git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], cwd);
    if (counts) {
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      lines.push(`Upstream: ${upstream} — ${ahead} ahead, ${behind} behind`);
      if (behind > 0) lines.push(`WARNING: local is ${behind} commit(s) behind ${upstream}. Pull before reviewing or reasoning about current state.`);
    }
  } else {
    lines.push("Upstream: none (branch not pushed)");
  }

  const head = git(["rev-parse", "--short", "HEAD"], cwd);
  if (head) lines.push(`HEAD: ${head}`);
  const dirty = git(["status", "--porcelain"], cwd);
  if (dirty) lines.push(`Uncommitted changes: ${dirty.split("\n").length} file(s)`);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        `Repository state at session start (verified, not assumed):\n${lines.join("\n")}\n` +
        `When stating what is on a branch or in a PR, cite this HEAD sha so the claim is falsifiable.`,
    },
  }));
}

main().catch(() => process.exit(0)); // informational only — never block a session
