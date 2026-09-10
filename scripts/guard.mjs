#!/usr/bin/env node
/**
 * stackmap PreToolUse guard — blocks a narrow set of destructive, hard-to-reverse commands,
 * and nothing else.
 *
 * Design notes:
 *  - Fails CLOSED. Any internal error exits 2, which blocks unconditionally. A guard that
 *    cannot evaluate must not wave the call through.
 *  - Reads config directly rather than importing from dist/, so a broken TypeScript build
 *    cannot disable the safety layer.
 *  - Rules are narrow on purpose. `git merge-base` is read-only, so the merge rule excludes it.
 *    `rm -rf` is NOT blocked: it is overwhelmingly used on scratch directories, and a guardrail
 *    that fires on ordinary work gets switched off.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULTS = { enabled: true, protectedBranches: ["develop", "main", "master"], allowMerge: false };

function loadGuardConfig() {
  const candidates = [];
  if (process.env.STACKMAP_CONFIG) candidates.push(process.env.STACKMAP_CONFIG);
  if (process.env.XDG_CONFIG_HOME) candidates.push(join(process.env.XDG_CONFIG_HOME, "stackmap", "config.json"));
  candidates.push(join(homedir(), ".config", "stackmap", "config.json"));
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      return { ...DEFAULTS, ...(JSON.parse(readFileSync(c, "utf8")).guard ?? {}) };
    } catch {
      // Unreadable config must not silently disable the guard; keep defaults.
      return DEFAULTS;
    }
  }
  return DEFAULTS;
}

/** Split a shell command into segments a rule should be tested against individually. */
function segments(command) {
  return command
    .split(/\n|&&|\|\||;|(?<!\|)\|(?!\|)/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function currentBranch(cwd) {
  // `rev-parse --abbrev-ref HEAD` prints "HEAD" on an unborn branch (a fresh repo or a new
  // worktree before its first commit), which would silently disable the branch rules exactly
  // where they matter. `symbolic-ref` reports the real branch name there.
  const attempts = [
    ["symbolic-ref", "--short", "HEAD"],
    ["rev-parse", "--abbrev-ref", "HEAD"],
  ];
  for (const args of attempts) {
    try {
      const out = execFileSync("git", args, {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
      }).trim();
      if (out && out !== "HEAD") return out; // "HEAD" means detached, not a branch name
    } catch {
      // try the next form
    }
  }
  return null; // not a repo, detached HEAD, or git unavailable — branch rules don't fire
}

/** Returns a reason string when the segment should be blocked, else null. */
function evaluate(seg, cfg, branch) {
  const s = seg.replace(/\s+/g, " ").trim();
  const protectedRe = cfg.protectedBranches.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  // 1. Unrequested merge. `git merge-base` is read-only and explicitly allowed.
  if (!cfg.allowMerge && /^git\s+merge(?!-base)\b/.test(s)) {
    return `Blocked: 'git merge' is denied by the stackmap guard. An unrequested merge is hard to unwind. Run it yourself, or set guard.allowMerge=true in ~/.config/stackmap/config.json.`;
  }

  // 2. Force push (data loss on a shared ref).
  if (/^git\s+push\b/.test(s) && /(?:^|\s)(--force(?!-with-lease)|-f)(?:\s|$)/.test(s)) {
    return `Blocked: force-push is denied by the stackmap guard. Use --force-with-lease if you must rewrite a remote branch.`;
  }

  // 3. Any push whose destination is a protected branch.
  if (/^git\s+push\b/.test(s)) {
    const dst = new RegExp(`(?:^|\\s)(?:[^\\s:]+:)?(?:refs/heads/)?(${protectedRe})(?:\\s|$)`);
    const hasExplicitRef = /^git\s+push\s+\S+\s+\S+/.test(s);
    if (dst.test(s)) {
      return `Blocked: push targets protected branch '${s.match(dst)[1]}'. Push to a feature branch and open a PR.`;
    }
    if (!hasExplicitRef && branch && cfg.protectedBranches.includes(branch)) {
      return `Blocked: implicit push while HEAD is on protected branch '${branch}'. Switch to a feature branch first.`;
    }
  }

  // 4. Commit while sitting on a protected branch.
  if (/^git\s+commit\b/.test(s) && branch && cfg.protectedBranches.includes(branch)) {
    return `Blocked: commit on protected branch '${branch}'. Create a feature branch first.`;
  }

  // 5. Hard reset (discards uncommitted work).
  if (/^git\s+reset\b/.test(s) && /(?:^|\s)--hard(?:\s|$)/.test(s)) {
    return `Blocked: 'git reset --hard' discards uncommitted work. Use 'git stash' or reset without --hard.`;
  }

  // 6. Destructive database operations.
  if (/\b(migrate:fresh|migrate:refresh|migrate:reset|db:wipe)\b/.test(s)) {
    return `Blocked: '${s.match(/\b(migrate:fresh|migrate:refresh|migrate:reset|db:wipe)\b/)[1]}' drops tables and is not reversible. Run it yourself if you mean it.`;
  }
  if (/\b(DROP\s+(DATABASE|TABLE)|TRUNCATE\s+TABLE)\b/i.test(s)) {
    return `Blocked: destructive SQL (${s.match(/\b(DROP\s+(?:DATABASE|TABLE)|TRUNCATE\s+TABLE)\b/i)[1]}) against a live connection.`;
  }
  return null;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }));
  process.stderr.write(reason + "\n");
  process.exit(2); // exit 2 blocks unconditionally, even if the JSON above were malformed
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (input.tool_name !== "Bash") process.exit(0);

  const cfg = loadGuardConfig();
  if (!cfg.enabled) process.exit(0);

  // A Bash call with no readable command string is malformed. Fail closed rather than
  // waving through something we could not evaluate.
  const command = input?.tool_input?.command;
  if (typeof command !== "string") {
    process.stderr.write("stackmap guard: Bash call with no readable command — blocking rather than failing open.\n");
    process.exit(2);
  }
  if (!command.trim()) process.exit(0);

  const segs = segments(command);
  const needsBranch = segs.some((s) => /^git\s+(push|commit)\b/.test(s.replace(/\s+/g, " ").trim()));
  const branch = needsBranch ? currentBranch(input.cwd || process.cwd()) : null;

  for (const seg of segs) {
    const reason = evaluate(seg, cfg, branch);
    if (reason) deny(reason);
  }
  process.exit(0);
}

main().catch((err) => {
  // Fail closed: an evaluation error must block, not permit.
  process.stderr.write(`stackmap guard: internal error, blocking rather than failing open — ${err?.message ?? err}\n`);
  process.exit(2);
});
