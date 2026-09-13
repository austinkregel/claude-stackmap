#!/usr/bin/env node
/**
 * Review-enforcement suite: arming precision, blocking, satisfaction, and loop safety.
 *
 * Runs against a temporary state directory ($STACKMAP_STATE), so it never touches real session
 * markers. It used to write into ~/.config/stackmap/sessions directly.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const runner = join(scripts, "hook-open.sh");
const state = mkdtempSync(join(tmpdir(), "stackmap-review-"));
const env = { ...process.env, STACKMAP_STATE: state, STACKMAP_CONFIG: join(state, "config.json") };
const DIR = join(state, "sessions");
const SID = "test-session-stackmap";
const marker = join(DIR, `${SID}.review.json`);

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};
const run = (script, payload) => spawnSync(runner, [script], { input: JSON.stringify(payload), encoding: "utf8", env });
const arm = (prompt, extra = {}) => run("review-arm.mjs", { hook_event_name: "UserPromptSubmit", session_id: SID, prompt, cwd: state, ...extra });
const stop = (msg, extra = {}) => run("review-check.mjs", { hook_event_name: "Stop", session_id: SID, last_assistant_message: msg, ...extra });

try {
  writeFileSync(join(state, "config.json"), "{}");

  console.log("-- arming is precise --");
  arm("please summarise the release notes");
  check("ordinary prompt does not arm", !existsSync(marker));
  arm("/stackmap:review 1234");
  check("/stackmap:review arms", existsSync(marker));
  check("marker is written under $STACKMAP_STATE", existsSync(join(state, "sessions", `${SID}.review.json`)));
  rmSync(marker, { force: true });
  arm("/review the incentives branch");
  check("/review arms", existsSync(marker));

  console.log("\n-- enforcement --");
  let r = stop("Looks good to me, no blocking issues found.");
  check("unstamped review is blocked", r.status === 2, `exit ${r.status}`);
  let decision = null;
  try {
    decision = JSON.parse(r.stdout);
  } catch {
    // reported below
  }
  check("block uses the documented Stop shape: top-level decision + reason", decision?.decision === "block" && /Reviewed at <sha>/.test(decision?.reason ?? ""), r.stdout.slice(0, 160));
  check("marker survives a block so the retry is still enforced", existsSync(marker));

  r = stop("Findings: none.\n\nReviewed at 8b57424, 15 uncommitted file(s) present, 2026-09-10T00:00:00Z.\nAxes covered: correctness, security. Verification: ran npm test.");
  check("stamped review passes", r.status === 0, `exit ${r.status}`);
  check("marker cleared once satisfied", !existsSync(marker));

  console.log("\n-- loop safety and scope --");
  r = stop("no stamp here");
  check("unarmed session is untouched", r.status === 0, `exit ${r.status}`);

  arm("/stackmap:review x");
  r = stop("still no stamp", { stop_hook_active: true });
  check("does not re-block when another hook already blocked", r.status === 0, `exit ${r.status}`);
  check("marker cleared to end the turn", !existsSync(marker));

  mkdirSync(DIR, { recursive: true });
  writeFileSync(marker, JSON.stringify({ armedAt: Date.now() - 7 * 60 * 60 * 1000 }));
  r = stop("no stamp");
  check("stale arm (>6h) does not block", r.status === 0, `exit ${r.status}`);
  check("stale marker cleaned up", !existsSync(marker));

  writeFileSync(marker, "{corrupt");
  r = stop("no stamp");
  check("corrupt marker does not trap the session", r.status === 0, `exit ${r.status}`);

  console.log("\n-- failures are visible, never silent --");
  r = arm("/review x", { session_id: undefined });
  check("arming with no session id is reported, not swallowed", r.status === 1 && /NOT armed/.test(r.stdout), `exit ${r.status}, stdout ${r.stdout.slice(0, 120)}`);
  r = spawnSync(runner, ["review-arm.mjs"], { input: JSON.stringify({ prompt: "/review", session_id: SID }), encoding: "utf8", env: { ...env, STACKMAP_STATE: "relative/state" } });
  check("a relative $STACKMAP_STATE is rejected visibly", r.status === 1 && /must be an absolute path/.test(r.stdout), `exit ${r.status}, stdout ${r.stdout.slice(0, 120)}`);
  r = spawnSync(runner, ["review-check.mjs"], { input: "{not json", encoding: "utf8", env });
  check("a broken Stop payload fails OPEN (exit 1, non-blocking)", r.status === 1, `exit ${r.status}`);
  check("…and says so in a systemMessage", /"systemMessage":"stackmap review-check:/.test(r.stdout), r.stdout.slice(0, 120));
} finally {
  rmSync(state, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall review-enforcement checks passed" : `\n${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
