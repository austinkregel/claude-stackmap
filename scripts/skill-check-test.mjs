#!/usr/bin/env node
/**
 * Closing-block enforcement suite for skill-arm.mjs and skill-check.mjs: arming precision, each
 * skill's closing block, both skills in one turn, and loop safety.
 *
 * Runs against a temporary state directory ($STACKMAP_STATE), so it never touches real session
 * markers.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const runner = join(scripts, "hook-open.sh");
const state = mkdtempSync(join(tmpdir(), "stackmap-skill-check-"));
const env = { ...process.env, STACKMAP_STATE: state, STACKMAP_CONFIG: join(state, "config.json") };
const DIR = join(state, "sessions");
const SID = "test-session-stackmap";
const reviewMarker = join(DIR, `${SID}.review.json`);
const dbMarker = join(DIR, `${SID}.double-blind.json`);

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};
const run = (script, payload) => spawnSync(runner, [script], { input: JSON.stringify(payload), encoding: "utf8", env });
const arm = (prompt, extra = {}) => run("skill-arm.mjs", { hook_event_name: "UserPromptSubmit", session_id: SID, prompt, cwd: state, ...extra });
const stop = (msg, extra = {}) => run("skill-check.mjs", { hook_event_name: "Stop", session_id: SID, last_assistant_message: msg, ...extra });
const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};
const clearMarkers = () => {
  rmSync(reviewMarker, { force: true });
  rmSync(dbMarker, { force: true });
};

const REVIEW_OK =
  "Findings: none.\n\nReviewed at 8b57424, 15 uncommitted file(s) present, 2026-09-10T00:00:00Z.\n" +
  "Axes covered: correctness, security. Verification: ran npm test.\nAudited: 3 — 2 survived, 1 falsified, 0 untested";
const DB_OK = [
  "Double-blind on: the header stores the sample count at offset 0x10 as a little-endian u32",
  "Base: main@1a2b3c4",
  "Methods: byte-level — PROVEN; static — INFERRED",
  "Adversarial wave: SURVIVED — read offsets 0x0c–0x14 of three files",
  "Unverified: nothing",
].join("\n");

try {
  writeFileSync(join(state, "config.json"), "{}");

  console.log("-- arming is precise --");
  arm("please summarise the release notes");
  check("ordinary prompt does not arm", !existsSync(reviewMarker) && !existsSync(dbMarker));
  arm("/stackmap:review 1234");
  check("/stackmap:review arms review", existsSync(reviewMarker) && !existsSync(dbMarker));
  check("marker is written under $STACKMAP_STATE", existsSync(join(state, "sessions", `${SID}.review.json`)));
  clearMarkers();
  arm("/review the incentives branch");
  check("/review arms review", existsSync(reviewMarker));
  clearMarkers();
  arm("/double-blind is the offset 0x10?");
  check("/double-blind arms double-blind only", existsSync(dbMarker) && !existsSync(reviewMarker));
  clearMarkers();
  arm("/stackmap:double-blind x");
  check("/stackmap:double-blind arms double-blind", existsSync(dbMarker));
  clearMarkers();
  arm("see docs/review/notes and the double-blind section");
  check("a path or a bare word does not arm", !existsSync(reviewMarker) && !existsSync(dbMarker));

  console.log("\n-- review --");
  arm("/review x");
  let r = stop("Looks good to me, no blocking issues found.");
  check("unstamped review is blocked", r.status === 2, `exit ${r.status}`);
  check("block uses the documented Stop shape: top-level decision + reason", json(r)?.decision === "block" && /Reviewed at <sha>/.test(json(r)?.reason ?? ""), r.stdout.slice(0, 160));
  check("marker survives a block so the retry is still enforced", existsSync(reviewMarker));
  r = stop("Reviewed at 8b57424, 0 uncommitted file(s) present, 2026-09-10T00:00:00Z.");
  check("a stamp without an Audited line is blocked", r.status === 2 && /Audited:/.test(json(r)?.reason ?? ""), r.stdout.slice(0, 160));
  r = stop(REVIEW_OK.replace("Audited: 3 — 2 survived", "Audited: 4 — 2 survived"));
  check("Audited counts that don't add up are blocked", r.status === 2 && /counts add up/.test(json(r)?.reason ?? ""), r.stdout.slice(0, 160));
  r = stop(REVIEW_OK.replace(/Audited: .*/, "Audited: none — no finding ranked high and every finding was backed by a test run"));
  check("Audited: none with a reason passes", r.status === 0, `exit ${r.status} ${r.stdout.slice(0, 160)}`);
  check("marker cleared once satisfied", !existsSync(reviewMarker));
  arm("/review x");
  r = stop(REVIEW_OK);
  check("stamped, audited review passes", r.status === 0, `exit ${r.status} ${r.stdout.slice(0, 160)}`);

  console.log("\n-- double-blind --");
  arm("/double-blind x");
  r = stop("Both agents agree it is 0x10.");
  check("a prose answer is blocked", r.status === 2 && /Double-blind on:/.test(json(r)?.reason ?? ""), r.stdout.slice(0, 160));
  r = stop(DB_OK.replace("static — INFERRED", "byte-level — INFERRED"));
  check("two agents with the same method are blocked", r.status === 2 && /at least two different methods/.test(json(r)?.reason ?? ""), r.stdout.slice(0, 200));
  r = stop(DB_OK.replace("static — INFERRED", "static"));
  check("a method with no grade is blocked", r.status === 2 && /one method and one grade/.test(json(r)?.reason ?? ""), r.stdout.slice(0, 200));
  r = stop(DB_OK.replace("Base: main@1a2b3c4", "Base: main"));
  check("a base with no sha is blocked", r.status === 2 && /Base: <ref>@<short sha>/.test(json(r)?.reason ?? ""), r.stdout.slice(0, 200));
  r = stop(DB_OK.replace("Adversarial wave: SURVIVED", "Adversarial wave: skipped"));
  check("a skipped adversarial wave is blocked", r.status === 2 && /Adversarial wave:/.test(json(r)?.reason ?? ""), r.stdout.slice(0, 200));
  r = stop(DB_OK.replace("Adversarial wave: SURVIVED", "Adversarial wave: UNTESTED"));
  check("an UNTESTED wave is a valid outcome", r.status === 0, `exit ${r.status} ${r.stdout.slice(0, 200)}`);
  arm("/double-blind x");
  r = stop(DB_OK.replace("Unverified: nothing", "Unverified: <what remains unproven>"));
  check("an unfilled placeholder is blocked", r.status === 2 && /Unverified:/.test(json(r)?.reason ?? ""), r.stdout.slice(0, 200));
  r = stop("Double-blind aborted: the question is a design preference with nothing to check against.");
  check("a declared abort passes", r.status === 0, `exit ${r.status}`);
  arm("/double-blind x");
  r = stop(`Here is the result.\n\n**Double-blind on:** offset 0x10\n**Base:** main@1a2b3c4\n**Methods:** byte-level — PROVEN; static — INFERRED\n**Adversarial wave:** SURVIVED — read the bytes\n**Unverified:** nothing`);
  check("bold labels are accepted", r.status === 0, `exit ${r.status} ${r.stdout.slice(0, 200)}`);

  console.log("\n-- both skills in one turn --");
  arm("/review x then /double-blind y");
  check("both markers armed", existsSync(reviewMarker) && existsSync(dbMarker));
  r = stop(REVIEW_OK);
  check("satisfying one skill still blocks on the other", r.status === 2 && /invoked as \/double-blind/.test(json(r)?.reason ?? "") && !/invoked as \/review/.test(json(r)?.reason ?? ""), r.stdout.slice(0, 200));
  check("…the satisfied marker is cleared, the other kept", !existsSync(reviewMarker) && existsSync(dbMarker));
  arm("/review x then /double-blind y");
  r = stop(`${REVIEW_OK}\n\n${DB_OK}`);
  check("both closing blocks pass", r.status === 0 && !existsSync(reviewMarker) && !existsSync(dbMarker), `exit ${r.status}`);

  console.log("\n-- loop safety and scope --");
  r = stop("no stamp here");
  check("unarmed session is untouched", r.status === 0 && r.stdout.trim() === "", `exit ${r.status}`);

  arm("/stackmap:review x");
  r = stop("still no stamp", { stop_hook_active: true });
  check("does not re-block after a block", r.status === 0, `exit ${r.status}`);
  check("…and tells the user what is still missing", /"systemMessage":"stackmap skill-check: the turn ended without a complete closing block/.test(r.stdout) && /Reviewed at <sha>/.test(r.stdout), r.stdout.slice(0, 200));
  check("marker cleared to end the turn", !existsSync(reviewMarker));
  arm("/review x");
  r = stop(REVIEW_OK, { stop_hook_active: true });
  check("a satisfied retry ends quietly", r.status === 0 && r.stdout.trim() === "" && !existsSync(reviewMarker), `exit ${r.status} ${r.stdout.slice(0, 120)}`);

  mkdirSync(DIR, { recursive: true });
  writeFileSync(reviewMarker, JSON.stringify({ armedAt: Date.now() - 7 * 60 * 60 * 1000 }));
  r = stop("no stamp");
  check("stale arm (>6h) does not block", r.status === 0, `exit ${r.status}`);
  check("stale marker cleaned up", !existsSync(reviewMarker));

  writeFileSync(dbMarker, "{corrupt");
  r = stop("no block");
  check("corrupt marker does not trap the session", r.status === 0 && !existsSync(dbMarker), `exit ${r.status}`);

  console.log("\n-- failures are visible, never silent --");
  r = arm("/review x", { session_id: undefined });
  check("arming with no session id is reported, not swallowed", r.status === 1 && /NOT armed/.test(r.stdout), `exit ${r.status}, stdout ${r.stdout.slice(0, 120)}`);
  r = spawnSync(runner, ["skill-arm.mjs"], { input: JSON.stringify({ prompt: "/review", session_id: SID }), encoding: "utf8", env: { ...env, STACKMAP_STATE: "relative/state" } });
  check("a relative $STACKMAP_STATE is rejected visibly", r.status === 1 && /must be an absolute path/.test(r.stdout), `exit ${r.status}, stdout ${r.stdout.slice(0, 120)}`);
  r = spawnSync(runner, ["skill-check.mjs"], { input: "{not json", encoding: "utf8", env });
  check("a broken Stop payload fails OPEN (exit 1, non-blocking)", r.status === 1, `exit ${r.status}`);
  check("…and says so in a systemMessage", /"systemMessage":"stackmap skill-check:/.test(r.stdout), r.stdout.slice(0, 120));
} finally {
  rmSync(state, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall skill-check checks passed" : `\n${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
