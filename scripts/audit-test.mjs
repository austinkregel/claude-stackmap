#!/usr/bin/env node
/**
 * Suite for audit-check.mjs: what counts as a complete audit report, how each Reproducer is checked
 * against the auditor's own transcript, what blocks versus what is only surfaced to the user, loop
 * safety, and that a hook called for the wrong agent or event says so instead of passing.
 *
 * Transcript fixtures use the record shapes captured from a real auditor stop (Claude Code 2.1.231),
 * laid out as <projects>/<session>/subagents/agent-<id>.jsonl beside <session>/tool-results/.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTranscript, readBashCalls, TranscriptError } from "./agent-transcript.mjs";
import { sameShellCommand, verifyReproducers } from "./deliverables.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const runner = join(scripts, "hook-open.sh");
const sandbox = mkdtempSync(join(tmpdir(), "stackmap-audit-"));
const env = { ...process.env, STACKMAP_STATE: join(sandbox, "state"), STACKMAP_CONFIG: join(sandbox, "config.json") };
const session = join(sandbox, "projects", "session-1");
const subagents = join(session, "subagents");
const toolResults = join(session, "tool-results");

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};
const AGENT = "stackmap:adversarial-auditor";

let transcriptCount = 0;
/** Write a transcript from records and return its path. `tail` is appended without a newline. */
const transcript = (records, tail = "") => {
  const path = join(subagents, `agent-t${++transcriptCount}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n" + tail);
  return path;
};
const record = (type, content, extra = {}) => ({ type, isSidechain: true, agentId: "a1", message: { role: type, content }, ...extra });
const bash = (id, command, name = "Bash") => record("assistant", [{ type: "tool_use", id, name, input: { command, description: "x" } }]);
const result = (id, content, isError = false) =>
  record("user", [{ tool_use_id: id, type: "tool_result", content, is_error: isError }], isError ? { toolUseResult: `Error: ${content}` } : {});
const say = (text) => record("assistant", [{ type: "text", text }]);

const CMD = 'sh scripts/guard.sh nope.mjs; echo "exit=$?"';
const OUT = "stackmap guard: scripts/nope.mjs is missing\nexit=2";
let DEFAULT_TRANSCRIPT;

const stop = (msg, extra = {}) =>
  spawnSync(runner, ["audit-check.mjs"], {
    input: JSON.stringify({
      hook_event_name: "SubagentStop",
      session_id: "s",
      agent_id: "a1",
      agent_type: AGENT,
      agent_transcript_path: DEFAULT_TRANSCRIPT,
      last_assistant_message: msg,
      ...extra,
    }),
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
const systemMessage = (r) => {
  try {
    return JSON.parse(r.stdout).systemMessage ?? "";
  } catch {
    return "";
  }
};
const blocked = (r, pattern) => r.status === 2 && pattern.test(reason(r));
const quiet = (r) => r.status === 0 && r.stdout.trim() === "";
const surfacedOnly = (r, pattern) => r.status === 0 && pattern.test(systemMessage(r)) && !/"decision"/.test(r.stdout);
const show = (r) => `exit ${r.status} ${r.stdout.slice(0, 300)}`;

const reproducer = (command = CMD, actual = "exit=2", expected = "exit=2") =>
  ["Reproducer:", `  Command: ${command}`, `  Expected: ${expected}`, `  Actual: ${actual}`].join("\n");
const report = (verdict, repro = reproducer()) =>
  [
    "Claim: guard.sh exits 2 when the named script is missing",
    "Audited at: main@85a8dee",
    `Verdict: ${verdict}`,
    ...(repro ? [repro] : []),
    "Tested:",
    `- ran ${CMD} → exit=2, stderr names the missing file`,
    "- read scripts/guard.sh:25 → the missing-file branch calls block, which exits 2",
    "Grade: PROVEN",
    "Unchecked: behaviour when node itself is missing",
  ].join("\n");
const SURVIVED = report("SURVIVED");
const FALSIFIED = report("FALSIFIED");
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
  mkdirSync(subagents, { recursive: true });
  mkdirSync(toolResults, { recursive: true });
  writeFileSync(join(sandbox, "config.json"), "{}");
  DEFAULT_TRANSCRIPT = transcript([say("checking the wrapper"), bash("t1", CMD), result("t1", OUT)]);

  console.log("-- complete, verified reports pass --");
  let r = stop(`I checked the wrapper.\n\n${SURVIVED}`);
  check("SURVIVED whose Reproducer matches the transcript passes quietly", quiet(r), show(r));
  check("FALSIFIED whose Reproducer matches passes", quiet(stop(FALSIFIED)), show(stop(FALSIFIED)));
  check("UNTESTED with Needs and no Reproducer passes", quiet(stop(UNTESTED)), show(stop(UNTESTED)));
  r = stop(SURVIVED.replace(/^(\w[\w ]*):/gm, "**$1:**"));
  check("bold labels pass", quiet(r), show(r));
  r = stop(SURVIVED.replace("Audited at: main@85a8dee", "Audited at: feature/house-rules-and-guards@85a8dee"));
  check("a named ref with slashes passes", quiet(r), show(r));

  let path = transcript([bash("m1", "printf 'a\\nb\\nc\\n'"), result("m1", "a\nb\nc")]);
  r = stop(report("SURVIVED", reproducer("printf 'a\\nb\\nc\\n'", "a\n      b")), { agent_transcript_path: path });
  check("a multi-line Actual matches consecutive output lines", quiet(r), show(r));

  // Indented two deeper than the label, as a real auditor wrote it.
  r = stop(report("SURVIVED", reproducer("printf 'a\\nb\\nc\\n'", "a\n    b\n    c")), { agent_transcript_path: path });
  check("continuation lines indented any amount deeper than the label are part of Actual", quiet(r), show(r));
  r = stop(report("SURVIVED", reproducer("printf 'a\\nb\\nc\\n'", "a\n    b\n    x")), { agent_transcript_path: path });
  check("…so a wrong continuation line is caught, not dropped", blocked(r, /isn't an exact run of lines/), show(r));

  path = transcript([bash("e1", 'sh -c "echo out; echo err >&2; exit 3"'), result("e1", "Exit code 3\nout\nerr", true)]);
  r = stop(report("FALSIFIED", reproducer('sh -c "echo out; echo err >&2; exit 3"', "Exit code 3\n      out")), { agent_transcript_path: path });
  check("a failing command's recorded output verifies (is_error)", quiet(r), show(r));

  const saved = join(toolResults, "be56a1gyf.txt");
  writeFileSync(saved, Array.from({ length: 20000 }, (_, i) => String(i + 1)).join("\n") + "\n");
  path = transcript([
    bash("p1", "seq 1 20000"),
    result("p1", `<persisted-output>\nOutput too large (106.3KB). Full output saved to: ${saved}\n\nPreview (first 2KB):\n1\n2\n3\n`),
  ]);
  r = stop(report("SURVIVED", reproducer("seq 1 20000", "19999\n      20000")), { agent_transcript_path: path });
  check("output persisted to tool-results/ is read from the saved file", quiet(r), show(r));

  path = transcript([
    { ...bash("q1", "echo one"), message: { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "q1", name: "Bash", input: { command: "echo one" } }] } },
    { ...bash("q2", CMD), message: { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "q2", name: "Bash", input: { command: CMD } }] } },
    result("q1", "one"),
    result("q2", OUT),
  ]);
  check("parallel calls sharing a message id are both read", quiet(stop(SURVIVED, { agent_transcript_path: path })));

  path = transcript([bash("r1", CMD), result("r1", "exit=1"), bash("r2", CMD), result("r2", OUT)]);
  check("a rerun whose later output matches passes", quiet(stop(SURVIVED, { agent_transcript_path: path })));

  path = transcript([bash("s1", 'echo "a b"'), result("s1", "a b")]);
  r = stop(report("SURVIVED", reproducer("echo    'a b'", "a b")), { agent_transcript_path: path });
  check("spacing and quoting style don't change the command", quiet(r), show(r));
  r = stop(report("SURVIVED", reproducer("echo a\\ b", "a b")), { agent_transcript_path: path });
  check("a backslash-escaped space is the same word", quiet(r), show(r));
  path = transcript([bash("s2", "sh scripts/guard.sh \\\n  nope.mjs"), result("s2", "exit=2")]);
  r = stop(report("SURVIVED", reproducer("sh scripts/guard.sh nope.mjs", "exit=2")), { agent_transcript_path: path });
  check("a line continuation doesn't change the command", quiet(r), show(r));

  r = stop(report("UNTESTED", reproducer("never-ran --flag", "whatever")).replace("Grade: PROVEN", "Grade: SPECULATIVE") + "\nNeeds: a machine with the tool");
  check("a Reproducer on UNTESTED is not verified", quiet(r), show(r));

  console.log("\n-- incomplete reports are blocked, naming what is missing --");
  r = stop("The claim looks correct.");
  check("prose with no report is blocked", blocked(r, /Claim:/) && /Verdict:/.test(reason(r)), show(r));
  check("block uses the documented decision shape", (() => { try { return JSON.parse(r.stdout).decision === "block"; } catch { return false; } })(), r.stdout.slice(0, 120));
  check("block shows the report form, Reproducer included", /Audited at: <ref>@<short sha>/.test(reason(r)) && /Command: <the command exactly as you ran it with Bash>/.test(reason(r)));
  check("a copied template verdict is blocked", blocked(stop(SURVIVED.replace("Verdict: SURVIVED", "Verdict: FALSIFIED | SURVIVED | UNTESTED")), /exactly one of FALSIFIED, SURVIVED, UNTESTED/));
  check("SURVIVED graded INFERRED is blocked", blocked(stop(SURVIVED.replace("Grade: PROVEN", "Grade: INFERRED")), /SURVIVED graded INFERRED .* report UNTESTED/));
  check("FALSIFIED graded SPECULATIVE is blocked", blocked(stop(FALSIFIED.replace("Grade: PROVEN", "Grade: SPECULATIVE")), /FALSIFIED graded SPECULATIVE/));
  check("SURVIVED with no Tested items is blocked", blocked(stop(SURVIVED.replace(/Tested:\n(- .*\n)+/, "Tested: nothing\n")), /at least one .* item under `Tested:`/));
  check("a Tested item with no result is blocked", blocked(stop(SURVIVED.replace(" → exit=2, stderr names the missing file", "")), /result on every `Tested:` item/));
  check("a base with no sha is blocked", blocked(stop(SURVIVED.replace("main@85a8dee", "main")), /Audited at: <ref>@<short sha>/));
  check("a missing Unchecked line is blocked", blocked(stop(SURVIVED.replace(/Unchecked: .*/, "")), /Unchecked:/));
  check("UNTESTED without Needs is blocked", blocked(stop(UNTESTED.replace(/Needs: .*/, "")), /Needs:/));
  check("an unfilled placeholder is blocked", blocked(stop(SURVIVED.replace(/Claim: .*/, "Claim: <the claim as given>")), /Claim:/));
  check("a copied template Needs line is blocked", blocked(stop(UNTESTED.replace(/Needs: .*/, "Needs: <the access that would let you test it>   (UNTESTED only)")), /Needs:/));
  check("a copied template Tested item is blocked", blocked(stop(SURVIVED.replace(/- read scripts.*/, "- <command run or file:line read> → <what it showed>")), /real `Tested:` item/));

  console.log("\n-- reproducers are checked against what the auditor ran --");
  r = stop(report("SURVIVED", null));
  check("SURVIVED with no Reproducer is blocked, pointing at UNTESTED", blocked(r, /at least one `Reproducer:` group .* report UNTESTED/), show(r));
  r = stop(report("FALSIFIED", null));
  check("FALSIFIED with no Reproducer is blocked", blocked(r, /at least one `Reproducer:` group/), show(r));
  path = transcript([say(`I would run ${CMD}`), bash("x1", "ls"), result("x1", "scripts")]);
  r = stop(SURVIVED, { agent_transcript_path: path });
  check("a command that appears only in prose is blocked", blocked(r, /no Bash call in your session ran this command/), show(r));
  r = stop(report("SURVIVED", reproducer('sh scripts/guard.sh other.mjs; echo "exit=$?"')));
  check("a changed argument is a different command", blocked(r, /no Bash call/), show(r));
  r = stop(report("SURVIVED", reproducer("sh scripts/guard.sh nope.mjs; echo 'exit=$?'")));
  check("quoting that changes an expansion is a different command", blocked(r, /no Bash call/), show(r));
  path = transcript([bash("y1", CMD, "Monitor"), result("y1", OUT)]);
  r = stop(SURVIVED, { agent_transcript_path: path });
  check("the same command run by another tool is not a Bash call", blocked(r, /no Bash call/), show(r));
  r = stop(report("SURVIVED", reproducer(CMD, "exit")));
  check("Actual that is only part of a line is blocked", blocked(r, /isn't an exact run of lines/), show(r));
  r = stop(report("SURVIVED", reproducer(CMD, " exit=2")));
  check("Actual with extra whitespace is not exact", blocked(r, /isn't an exact run of lines/), show(r));
  r = stop(SURVIVED.replace(/ {2}Expected: .*\n/, ""));
  check("a group missing Expected is blocked", blocked(r, /Reproducer 1: an indented `Expected:` line after `Command:`/), show(r));
  r = stop(SURVIVED.replace("  Actual: exit=2", "  Actual: <the lines it printed, copied exactly>"));
  check("a group with the template's placeholder is blocked", blocked(r, /Reproducer 1: a filled-in `Actual:`/), show(r));
  r = stop(report("SURVIVED", `${reproducer()}\n  Command: echo second\n  Expected: second\n  Actual: second`));
  check("a second group without its own Reproducer: line is blocked, not skipped", blocked(r, /each group starts with its own `Reproducer:`/), show(r));
  path = transcript([bash("i1", "printf 'a\\nb\\nc\\n'"), result("i1", "a\nb\nc")]);
  r = stop(report("SURVIVED", reproducer("printf 'a\\nb\\nc\\n'", "a\n      b\n    c")), { agent_transcript_path: path });
  check("continuation lines that lose their indentation are blocked", blocked(r, /indented the same as its first continuation line/), show(r));
  r = stop(`Draft:\n${reproducer()}\n\n${report("SURVIVED", null)}`);
  check("a Reproducer written only before the last Claim: doesn't count", blocked(r, /at least one `Reproducer:` group/), show(r));
  r = stop(SURVIVED.replace("Grade: PROVEN", "Grade: INFERRED"), { agent_transcript_path: "" });
  check("a block also names what could not be checked", blocked(r, /Also could not be checked/) && /no agent_transcript_path/.test(reason(r)), show(r));

  console.log("\n-- what the auditor can't fix is surfaced, not blocked --");
  r = stop(SURVIVED, { agent_transcript_path: undefined });
  check("a missing transcript path is surfaced", surfacedOnly(r, /no agent_transcript_path/), show(r));
  check("…with the auditor's report, asking the user for context", /Please confirm or fill in the missing context/.test(systemMessage(r)) && /Claim: guard.sh exits 2/.test(systemMessage(r)), show(r));
  r = stop(UNTESTED, { agent_transcript_path: undefined });
  check("a missing transcript path is surfaced on UNTESTED too", surfacedOnly(r, /no agent_transcript_path/), show(r));
  r = stop(SURVIVED, { agent_transcript_path: join(subagents, "agent-missing.jsonl") });
  check("an unreadable transcript is surfaced", surfacedOnly(r, /could not be read .*cannot read the agent transcript/), show(r));
  path = join(subagents, "agent-broken.jsonl");
  writeFileSync(path, `${JSON.stringify(bash("b1", CMD))}\n{not json\n${JSON.stringify(result("b1", OUT))}\n`);
  r = stop(SURVIVED, { agent_transcript_path: path });
  check("an invalid middle line is surfaced", surfacedOnly(r, /line 2 .* is not valid JSON/), show(r));
  path = join(session, "not-a-subagent.jsonl");
  writeFileSync(path, `${JSON.stringify(bash("c1", CMD))}\n${JSON.stringify(result("c1", OUT))}\n`);
  r = stop(SURVIVED, { agent_transcript_path: path });
  check("a transcript outside subagents/ is surfaced", surfacedOnly(r, /not in a subagents\/ directory/), show(r));
  r = stop(report("SURVIVED", reproducer('echo "unterminated', "x")));
  check("a command the shell parser rejects is surfaced", surfacedOnly(r, /can't be parsed as shell/), show(r));
  const excerpt = `Exit code 7\n1\n2\n3\n\n\n... [3904 characters truncated] ...\n\n\n2999\n3000`;
  path = transcript([bash("g1", "sh -c 'seq 1 3000; exit 7'"), result("g1", excerpt, true)]);
  r = stop(report("FALSIFIED", reproducer("sh -c 'seq 1 3000; exit 7'", "1500")), { agent_transcript_path: path });
  check("Actual that fell in an excerpt's cut middle is surfaced", surfacedOnly(r, /head-and-tail excerpt/), show(r));
  r = stop(report("FALSIFIED", reproducer("sh -c 'seq 1 3000; exit 7'", "2999\n      3000")), { agent_transcript_path: path });
  check("Actual in an excerpt's kept part verifies", quiet(r), show(r));
  path = transcript([bash("h1", "seq 1 3000"), result("h1", excerpt.replace("Exit code 7\n", ""))]);
  r = stop(report("SURVIVED", reproducer("seq 1 3000", "1500")), { agent_transcript_path: path });
  check("the excerpt marker in a successful command's output is just output", blocked(r, /isn't an exact run of lines/), show(r));
  writeFileSync(join(session, "outside.txt"), "exit=2\n");
  path = transcript([bash("o1", CMD), result("o1", `<persisted-output>\nOutput too large. Full output saved to: ${join(session, "outside.txt")}\n\nPreview (first 2KB):\nexit=2\n`)]);
  r = stop(SURVIVED, { agent_transcript_path: path });
  check("a persisted-output path outside tool-results/ is surfaced", surfacedOnly(r, /not in .*tool-results/), show(r));

  console.log("\n-- write lag: re-read until the result is written --");
  const lagPath = transcript([bash("l1", CMD)]);
  let sleeps = 0;
  let lag = await checkTranscript(lagPath, (calls) => verifyReproducers([{ index: 1, command: CMD, actual: "exit=2" }], calls), {
    retryMs: 5,
    windowMs: 100,
    sleep: async () => {
      if (++sleeps === 2) appendFileSync(lagPath, `${JSON.stringify(result("l1", OUT))}\n`);
    },
  });
  check("a result written during the window is found on a re-read", lag.waiting.length === 0 && lag.blocking.length === 0 && sleeps === 2, JSON.stringify({ lag, sleeps }));
  let clock = 0;
  sleeps = 0;
  lag = await checkTranscript(transcript([bash("l2", CMD)]), (calls) => verifyReproducers([{ index: 1, command: CMD, actual: "exit=2" }], calls), {
    retryMs: 5000,
    windowMs: 50000,
    sleep: async (ms) => {
      sleeps++;
      clock += ms;
    },
    now: () => clock,
  });
  check("a result never written stops after the window, still waiting", lag.waiting.length === 1 && sleeps === 10, JSON.stringify({ lag, sleeps }));
  const partial = transcript([bash("l3", CMD)], JSON.stringify(result("l3", OUT)).slice(0, 20));
  const partialRead = await readBashCalls(partial);
  check("a last line with no newline yet is left out, not misread", partialRead.tailIncomplete && partialRead.calls[0].result === null, JSON.stringify(partialRead));
  let threw = null;
  try {
    await readBashCalls(transcript([bash("d1", CMD), result("d1", OUT), result("d1", OUT)]));
  } catch (err) {
    threw = err;
  }
  check("a duplicated tool_result is a TranscriptError", threw instanceof TranscriptError && /appears twice/.test(threw.message), String(threw));
  threw = null;
  try {
    await readBashCalls(transcript([bash("k1", CMD), result("k1", [{ type: "text", text: OUT }])]));
  } catch (err) {
    threw = err;
  }
  check("array tool_result content is a TranscriptError, not a guess", threw instanceof TranscriptError && /array content/.test(threw.message), String(threw));
  check("an unparseable transcript command only matches itself", sameShellCommand("echo ok", "echo ok") && !sameShellCommand("echo ok", 'echo "unterminated'));

  console.log("\n-- loop safety --");
  r = stop("still prose", { stop_hook_active: true });
  check("does not re-block after a block", r.status === 0, `exit ${r.status}`);
  check("…and tells the user the report is incomplete", /"systemMessage":"stackmap audit-check: the adversarial auditor finished with an incomplete or unverified report/.test(r.stdout), r.stdout.slice(0, 200));
  r = stop(report("SURVIVED", reproducer("never-ran")), { stop_hook_active: true });
  check("an unverified Reproducer on the retry is reported to the user, not re-blocked", r.status === 0 && /no Bash call/.test(systemMessage(r)), show(r));
  r = stop(SURVIVED, { stop_hook_active: true });
  check("a complete retry ends quietly", quiet(r), show(r));

  console.log("\n-- failures are visible, never silent --");
  r = stop(SURVIVED, { agent_type: "Explore" });
  check("another agent type is reported, not passed", r.status === 1 && /called for \\"Explore\\"; that report was not checked/.test(r.stdout), show(r));
  r = stop(SURVIVED, { hook_event_name: "Stop" });
  check("an unexpected event is reported", r.status === 1 && /unexpected event/.test(r.stdout), show(r));
  r = spawnSync(runner, ["audit-check.mjs"], { input: "{not json", encoding: "utf8", env });
  check("a broken payload fails OPEN (exit 1) with a systemMessage", r.status === 1 && /"systemMessage":"stackmap audit-check:/.test(r.stdout), show(r));
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall audit-check checks passed" : `\n${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
