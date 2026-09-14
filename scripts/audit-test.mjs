#!/usr/bin/env node
/**
 * Suite for audit-check.mjs: what counts as a complete audit report, loop safety, and that a hook
 * called for the wrong agent or event says so instead of passing.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const runner = join(scripts, "hook-open.sh");
const sandbox = mkdtempSync(join(tmpdir(), "stackmap-audit-"));
const env = { ...process.env, STACKMAP_STATE: join(sandbox, "state"), STACKMAP_CONFIG: join(sandbox, "config.json") };

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};
const AGENT = "stackmap:adversarial-auditor";
const stop = (msg, extra = {}) =>
  spawnSync(runner, ["audit-check.mjs"], {
    input: JSON.stringify({ hook_event_name: "SubagentStop", session_id: "s", agent_id: "a1", agent_type: AGENT, last_assistant_message: msg, ...extra }),
    encoding: "utf8",
    env,
  });
const reason = (r) => {
  try {
    return JSON.parse(r.stdout).reason ?? "";
  } catch {
    return "";
  }
};
const blocked = (r, pattern) => r.status === 2 && pattern.test(reason(r));

const SURVIVED = [
  "Claim: guard.sh exits 2 when the named script is missing",
  "Audited at: main@85a8dee",
  "Verdict: SURVIVED",
  "Tested:",
  "- ran scripts/guard.sh nope.mjs with an empty payload → exit 2, stderr names the missing file",
  "- read scripts/guard.sh:25 → the missing-file branch calls block, which exits 2",
  "Grade: PROVEN",
  "Unchecked: behaviour when node itself is missing",
].join("\n");
const FALSIFIED = SURVIVED.replace("Verdict: SURVIVED", "Verdict: FALSIFIED");
const UNTESTED = [
  "Claim: the production queue drains within 5 minutes",
  "Audited at: main@85a8dee",
  "Verdict: UNTESTED",
  "Tested: nothing",
  "Grade: SPECULATIVE",
  "Unchecked: all of it",
  "Needs: read access to the production queue metrics",
].join("\n");

try {
  writeFileSync(join(sandbox, "config.json"), "{}");

  console.log("-- complete reports pass --");
  let r = stop(`I checked the wrapper.\n\n${SURVIVED}`);
  check("SURVIVED with PROVEN evidence passes", r.status === 0 && r.stdout.trim() === "", `exit ${r.status} ${r.stdout.slice(0, 200)}`);
  check("FALSIFIED with PROVEN evidence passes", stop(FALSIFIED).status === 0);
  check("UNTESTED with Needs passes", stop(UNTESTED).status === 0, stop(UNTESTED).stdout.slice(0, 200));
  r = stop(SURVIVED.replace(/^(\w[\w ]*):/gm, "**$1:**"));
  check("bold labels pass", r.status === 0, `exit ${r.status} ${r.stdout.slice(0, 200)}`);
  r = stop(SURVIVED.replace("Audited at: main@85a8dee", "Audited at: feature/house-rules-and-guards@85a8dee"));
  check("a named ref with slashes passes", r.status === 0, `exit ${r.status} ${r.stdout.slice(0, 200)}`);

  console.log("\n-- incomplete reports are blocked, naming what is missing --");
  r = stop("The claim looks correct.");
  check("prose with no report is blocked", blocked(r, /Claim:/) && /Verdict:/.test(reason(r)), r.stdout.slice(0, 200));
  check("block uses the documented decision shape", (() => { try { return JSON.parse(r.stdout).decision === "block"; } catch { return false; } })(), r.stdout.slice(0, 120));
  check("block shows the report form", /Audited at: <ref>@<short sha>/.test(reason(r)));
  check("a copied template verdict is blocked", blocked(stop(SURVIVED.replace("Verdict: SURVIVED", "Verdict: FALSIFIED | SURVIVED | UNTESTED")), /exactly one of FALSIFIED, SURVIVED, UNTESTED/));
  check("SURVIVED graded INFERRED is blocked", blocked(stop(SURVIVED.replace("Grade: PROVEN", "Grade: INFERRED")), /SURVIVED graded INFERRED .* report UNTESTED/));
  check("FALSIFIED graded SPECULATIVE is blocked", blocked(stop(FALSIFIED.replace("Grade: PROVEN", "Grade: SPECULATIVE")), /FALSIFIED graded SPECULATIVE/));
  check("SURVIVED with no Tested items is blocked", blocked(stop(SURVIVED.replace(/Tested:\n(- .*\n)+/, "Tested: nothing\n")), /at least one .* item under `Tested:`/));
  check("a Tested item with no result is blocked", blocked(stop(SURVIVED.replace(" → exit 2, stderr names the missing file", "")), /result on every `Tested:` item/));
  check("a base with no sha is blocked", blocked(stop(SURVIVED.replace("main@85a8dee", "main")), /Audited at: <ref>@<short sha>/));
  check("a missing Unchecked line is blocked", blocked(stop(SURVIVED.replace(/Unchecked: .*/, "")), /Unchecked:/));
  check("UNTESTED without Needs is blocked", blocked(stop(UNTESTED.replace(/Needs: .*/, "")), /Needs:/));
  check("an unfilled placeholder is blocked", blocked(stop(SURVIVED.replace(/Claim: .*/, "Claim: <the claim as given>")), /Claim:/));

  console.log("\n-- loop safety --");
  r = stop("still prose", { stop_hook_active: true });
  check("does not re-block after a block", r.status === 0, `exit ${r.status}`);
  check("…and tells the user the report is incomplete", /"systemMessage":"stackmap audit-check: the adversarial auditor finished with an incomplete report/.test(r.stdout), r.stdout.slice(0, 200));
  r = stop(SURVIVED, { stop_hook_active: true });
  check("a complete retry ends quietly", r.status === 0 && r.stdout.trim() === "", `exit ${r.status} ${r.stdout.slice(0, 120)}`);

  console.log("\n-- failures are visible, never silent --");
  r = stop(SURVIVED, { agent_type: "Explore" });
  check("another agent type is reported, not passed", r.status === 1 && /called for \\"Explore\\"; that report was not checked/.test(r.stdout), `exit ${r.status} ${r.stdout.slice(0, 200)}`);
  r = stop(SURVIVED, { hook_event_name: "Stop" });
  check("an unexpected event is reported", r.status === 1 && /unexpected event/.test(r.stdout), `exit ${r.status} ${r.stdout.slice(0, 200)}`);
  r = spawnSync(runner, ["audit-check.mjs"], { input: "{not json", encoding: "utf8", env });
  check("a broken payload fails OPEN (exit 1) with a systemMessage", r.status === 1 && /"systemMessage":"stackmap audit-check:/.test(r.stdout), `exit ${r.status} ${r.stdout.slice(0, 120)}`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall audit-check checks passed" : `\n${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
