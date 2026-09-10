#!/usr/bin/env node
/** Review-enforcement suite: arming precision, blocking, satisfaction, and loop safety. */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const runner = join(scripts, "hook-open.sh");
const DIR = join(homedir(), ".config", "stackmap", "sessions");
const SID = "test-session-stackmap";
const marker = join(DIR, `${SID}.review.json`);

let failed = 0;
const check = (label, cond, detail = "") => { if (!cond) failed++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`); };
const run = (script, payload) => spawnSync(runner, [script], { input: JSON.stringify(payload), encoding: "utf8" });
const arm = (prompt) => run("review-arm.mjs", { hook_event_name: "UserPromptSubmit", session_id: SID, prompt, cwd: process.cwd() });
const stop = (msg, extra = {}) => run("review-check.mjs", { hook_event_name: "Stop", session_id: SID, last_assistant_message: msg, ...extra });

rmSync(marker, { force: true });
try {
  console.log("-- arming is precise --");
  arm("please summarise the release notes");
  check("ordinary prompt does not arm", !existsSync(marker));
  arm("/stackmap:review 1234");
  check("/stackmap:review arms", existsSync(marker));
  rmSync(marker, { force: true });
  arm("/review the incentives branch");
  check("/review arms", existsSync(marker));

  console.log("\n-- enforcement --");
  let r = stop("Looks good to me, no blocking issues found.");
  check("unstamped review is blocked", r.status === 2, `exit ${r.status}`);
  check("block reason names the required form", /Reviewed at <sha>/.test(r.stdout + r.stderr));
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
} finally { rmSync(marker, { force: true }); }

console.log(failed === 0 ? "\nall review-enforcement checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
