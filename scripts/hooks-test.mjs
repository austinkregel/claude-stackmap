#!/usr/bin/env node
/**
 * Suite for the informational hooks and their wrapper: hook-open.sh, freshness.mjs, and
 * fetch-sanity.mjs.
 *
 * These fail OPEN, which is exactly why they need tests: a fail-open hook that silently stopped
 * working looks identical to one that had nothing to say. Each check asserts both the exit code
 * and what the user or Claude would actually see.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const runner = join(scripts, "hook-open.sh");
let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};

const sandbox = mkdtempSync(join(tmpdir(), "stackmap-hooks-"));
const env = { ...process.env, STACKMAP_CONFIG: join(sandbox, "config.json"), STACKMAP_STATE: join(sandbox, "state") };
writeFileSync(env.STACKMAP_CONFIG, "{}");
const run = (script, input, extraEnv = {}) =>
  spawnSync(runner, script === null ? [] : [script], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...env, ...extraEnv },
  });
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

try {
  console.log("-- hook-open.sh: fails open, visibly --");
  for (const [label, script, pattern] of [
    ["no script named", null, /no hook script named/],
    ["path-escaping script name", "../bin/sm.mjs", /invalid hook script name/],
    ["missing script", "does-not-exist.mjs", /does-not-exist\.mjs is missing/],
  ]) {
    const r = run(script, "{}");
    let msg = null;
    try {
      msg = JSON.parse(r.stdout).systemMessage;
    } catch {
      // reported below
    }
    check(`${label}: exits 1 (non-blocking), not 0`, r.status === 1, `exit ${r.status}`);
    check(`${label}: tells the user in a systemMessage`, pattern.test(msg ?? ""), r.stdout.slice(0, 160));
  }

  console.log("\n-- config.example.json stays valid --");
  {
    // The example documents every hook config key; if it drifted from hook-config.mjs, every guard
    // would fail closed for anyone who copied it.
    const example = join(scripts, "..", "config.example.json");
    const guarded = spawnSync(join(scripts, "guard.sh"), ["guard.mjs"], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: sandbox, tool_input: { command: "ls" } }),
      encoding: "utf8",
      env: { ...env, STACKMAP_CONFIG: example },
    });
    check("the guard accepts config.example.json", guarded.status === 0, `exit ${guarded.status}: ${guarded.stderr.trim().slice(0, 200)}`);
    const rules = run("house-rules.mjs", { hook_event_name: "SessionStart", cwd: sandbox }, { STACKMAP_CONFIG: example });
    check("house-rules accepts config.example.json", rules.status === 0 && rules.stdout.includes("additionalContext"), `exit ${rules.status}: ${rules.stdout.slice(0, 200)}`);
  }

  console.log("\n-- freshness.mjs: states the repo position, and what it could not check --");
  {
    const origin = join(sandbox, "origin.git");
    const repo = join(sandbox, "repo");
    git(["init", "-q", "--bare", "-b", "main", origin], sandbox);
    git(["init", "-q", "-b", "main", repo], sandbox);
    git(["config", "user.email", "t@t"], repo);
    git(["config", "user.name", "t"], repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "a.txt"], repo);
    git(["commit", "-q", "-m", "first"], repo);
    git(["remote", "add", "origin", origin], repo);
    git(["push", "-q", "-u", "origin", "main"], repo);
    const head = git(["rev-parse", "--short", "HEAD"], repo).trim();

    const session = (cwd) => run("freshness.mjs", { hook_event_name: "SessionStart", source: "startup", cwd });
    const contextOf = (r) => {
      try {
        return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      } catch {
        return null;
      }
    };

    let r = session(repo);
    let ctx = contextOf(r);
    check("reports branch, upstream, and HEAD", r.status === 0 && ctx?.includes("Branch: main") && ctx?.includes("origin/main — 0 ahead, 0 behind") && ctx?.includes(`HEAD: ${head}`), ctx ?? r.stdout);
    check("no fetch warning when the fetch worked", !ctx?.includes("git fetch failed"));

    writeFileSync(join(repo, "b.txt"), "b\n");
    ctx = contextOf(session(repo));
    check("counts uncommitted files", ctx?.includes("Uncommitted changes: 1 file(s)"), ctx);

    git(["remote", "set-url", "origin", join(sandbox, "gone.git")], repo);
    ctx = contextOf(session(repo));
    check("regression: a failed fetch is stated, not swallowed", /WARNING: git fetch failed/.test(ctx ?? ""), ctx);
    check("…and the counts are marked as possibly stale", /may be stale/.test(ctx ?? ""), ctx);

    r = session(sandbox);
    check("not a repo: says nothing, exits 0", r.status === 0 && r.stdout.trim() === "", `exit ${r.status}, stdout ${r.stdout.slice(0, 80)}`);

    r = run("freshness.mjs", "{not json");
    check("unreadable payload: fails open with exit 1", r.status === 1, `exit ${r.status}`);
    check("unreadable payload: tells the user instead of guessing a cwd", /"systemMessage":"stackmap freshness:/.test(r.stdout), r.stdout.slice(0, 120));
  }

  console.log("\n-- fetch-sanity.mjs: warns on a success that isn't one --");
  {
    const fetched = (tool_response) => ({ hook_event_name: "PostToolUse", tool_name: "WebFetch", tool_input: { url: "https://example.test/a" }, tool_response });
    const real = "genuine article content that is comfortably past the minimum length. ".repeat(5);

    let r = run("fetch-sanity.mjs", fetched({ content: "Please sign in to continue reading this article." }));
    check("login wall warns Claude (exit 2)", r.status === 2, `exit ${r.status}`);
    check("login wall names the url and says not to conclude from it", /example\.test/.test(r.stderr) && /Do NOT state conclusions/.test(r.stderr));

    r = run("fetch-sanity.mjs", fetched({ content: real }));
    check("genuine content passes quietly", r.status === 0 && r.stderr.trim() === "", `exit ${r.status}`);

    r = run("fetch-sanity.mjs", fetched({ content: "tiny" }));
    check("a suspiciously short body warns", r.status === 2, `exit ${r.status}`);

    r = run("fetch-sanity.mjs", fetched({ content: `${real} Are you a robot?` }));
    check("a bot check inside a long body still warns", r.status === 2, `exit ${r.status}`);

    r = run("fetch-sanity.mjs", fetched({ content: [{ text: real }] }));
    check("block-array response shape is understood", r.status === 0, `exit ${r.status}`);

    r = run("fetch-sanity.mjs", "{not json");
    check("malformed payload fails OPEN (exit 1, non-blocking)", r.status === 1, `exit ${r.status}`);
    check("malformed payload is reported in a systemMessage", /"systemMessage":"stackmap fetch-sanity:/.test(r.stdout), r.stdout.slice(0, 120));
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall informational-hook checks passed" : `\n${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
