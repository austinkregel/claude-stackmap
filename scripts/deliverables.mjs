/**
 * The closing blocks that enforced skills and the adversarial auditor must end with, and the
 * checks that name what a final message is missing. An empty list means satisfied.
 *
 * Labels match at the start of a line, with or without `**bold**`; the last occurrence wins, so
 * an earlier mention of a label doesn't count as the block.
 */

/** The auditor's agent type as Claude Code reports it: `<plugin name>:<agent name>`. */
export const AUDITOR_AGENT = "stackmap:adversarial-auditor";

export const VERDICTS = ["FALSIFIED", "SURVIVED", "UNTESTED"];
export const GRADES = ["PROVEN", "INFERRED", "SPECULATIVE"];
export const METHODS = ["static", "dynamic", "byte-level", "differential", "documentary", "reconstructive"];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const labelRe = (label) => new RegExp(`^[ \\t]*(?:\\*\\*)?${escape(label)}:(?:\\*\\*)?[ \\t]*(.*)$`, "gim");
const DASH = "(?:—|–|-{1,2})";
const BASE = /^`?[^\s@`]+@[0-9a-f]{7,40}`?(?:\s|$)/i;

/** Value after the last `Label:` line, trimmed, or null when the label is absent. */
function field(text, label) {
  let value = null;
  for (const m of text.matchAll(labelRe(label))) value = m[1].trim();
  return value;
}

/** Present, and not an unfilled `<placeholder>`. */
const filled = (v) => typeof v === "string" && v.length > 0 && !/^<[^>]*>$/.test(v);

/** The single word from `words` in `value`, or null when there are none or several. */
function exactlyOne(value, words) {
  if (value === null) return null;
  const found = words.filter((w) => new RegExp(`(?:^|[^A-Za-z-])${escape(w)}(?![A-Za-z-])`, "i").test(value));
  return found.length === 1 ? found[0] : null;
}

/** The `- ` items under the last `Label:` line (wrapped lines join their item), plus any inline text. */
function listAfter(text, label) {
  const lines = text.split("\n");
  let at = -1;
  for (let i = 0; i < lines.length; i++) if (labelRe(label).test(lines[i])) at = i;
  if (at === -1) return null;
  const inline = labelRe(label).exec(lines[at])[1].trim();
  const items = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*[-*]\s+\S/.test(line)) items.push(line.replace(/^\s*[-*]\s+/, ""));
    else if (items.length && /^\s{2,}\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    else break;
  }
  return { inline, items };
}

export const AUDIT_BLOCK = [
  "Claim: <the claim as given>",
  "Audited at: <ref>@<short sha>",
  "Verdict: FALSIFIED | SURVIVED | UNTESTED",
  "Tested:",
  "- <command run or file:line read> → <what it showed>",
  "Grade: PROVEN | INFERRED | SPECULATIVE",
  "Unchecked: <what went unchecked, or \"nothing\">",
  "Needs: <the access that would let you test it>   (UNTESTED only)",
];
export const AUDIT_FORM = AUDIT_BLOCK.join("\n");

export function auditReportProblems(text) {
  const missing = [];
  if (!filled(field(text, "Claim"))) missing.push("a `Claim:` line restating the claim you audited");
  const base = field(text, "Audited at");
  if (!base || !BASE.test(base)) missing.push("an `Audited at: <ref>@<short sha>` line naming what you checked out (e.g. main@1a2b3c4)");

  const verdict = exactlyOne(field(text, "Verdict"), VERDICTS);
  if (!verdict) missing.push("a `Verdict:` line with exactly one of FALSIFIED, SURVIVED, UNTESTED");
  const grade = exactlyOne(field(text, "Grade"), GRADES);
  if (!grade) missing.push("a `Grade:` line with exactly one of PROVEN, INFERRED, SPECULATIVE");
  const decided = verdict === "FALSIFIED" || verdict === "SURVIVED";
  if (decided && grade && grade !== "PROVEN") {
    missing.push(`a PROVEN grade: ${verdict} graded ${grade} was not checked against ground truth, so report UNTESTED`);
  }

  const tested = listAfter(text, "Tested");
  if (!tested) {
    missing.push("a `Tested:` list of what you ran or read");
  } else {
    if (decided && tested.items.length === 0) missing.push(`at least one \`- <what you ran or read> → <what it showed>\` item under \`Tested:\` for a ${verdict} verdict`);
    const bare = tested.items.filter((item) => !/\S\s*(?:→|->)\s*\S/.test(item));
    if (bare.length) missing.push(`a "→ <what it showed>" result on every \`Tested:\` item (missing on: ${bare.map((b) => `"${b.slice(0, 60)}"`).join(", ")})`);
    if (!decided && tested.items.length === 0 && !filled(tested.inline)) missing.push("a `Tested:` list, or `Tested: nothing` if no attempt was possible");
  }

  if (!filled(field(text, "Unchecked"))) missing.push('an `Unchecked:` line — say "nothing" if everything was checked');
  if (verdict === "UNTESTED" && !filled(field(text, "Needs"))) missing.push("a `Needs:` line naming the access that would let the claim be tested");
  return missing;
}

export const REVIEW_BLOCK = [
  "Reviewed at <sha>, <N> uncommitted file(s) present, <timestamp>.",
  "Axes covered: <list>. Axes skipped: <list, with why>.",
  "Verification: <what was actually run>.",
  "Audited: <n> — <n> survived, <n> falsified, <n> untested   (or: Audited: none — <why>)",
];
export const REVIEW_FORM = REVIEW_BLOCK.join("\n");

export function reviewProblems(text) {
  const missing = [];
  if (!/reviewed at\s+[`"']?[0-9a-f]{7,40}/i.test(text)) {
    missing.push("a `Reviewed at <sha>` stamp (get the sha from the checkout you reviewed; for a PR, confirm it matches the PR head)");
  }
  const audited = field(text, "Audited");
  const none = new RegExp(`^none\\s*${DASH}\\s*\\S`, "i");
  const counts = new RegExp(`^(\\d+)\\s*${DASH}\\s*(\\d+)\\s+survived,\\s*(\\d+)\\s+falsified,\\s*(\\d+)\\s+untested\\b`, "i").exec(audited ?? "");
  if (audited === null || !(none.test(audited) || counts)) {
    missing.push("an `Audited: <n> — <n> survived, <n> falsified, <n> untested` line, or `Audited: none — <why>`");
  } else if (counts && Number(counts[1]) !== Number(counts[2]) + Number(counts[3]) + Number(counts[4])) {
    missing.push(`an \`Audited:\` line whose counts add up (${counts[1]} audited, but ${counts[2]} + ${counts[3]} + ${counts[4]})`);
  }
  return missing;
}

export const DOUBLE_BLIND_BLOCK = [
  "Double-blind on: <the falsifiable claim>",
  "Base: <ref>@<short sha>",
  "Methods: <method> — <PROVEN|INFERRED|SPECULATIVE>; <method> — <grade>",
  "Adversarial wave: <FALSIFIED|SURVIVED|UNTESTED> — <what was actually tested>",
  "Unverified: <what remains unproven, or \"nothing\">",
];
export const DOUBLE_BLIND_ABORT = "Double-blind aborted: <why there is nothing to check against>";
export const DOUBLE_BLIND_FORM = [
  ...DOUBLE_BLIND_BLOCK,
  "",
  `Methods are: ${METHODS.join(", ")}. At least two, all different.`,
  "If the question could not be stated falsifiably, end instead with:",
  DOUBLE_BLIND_ABORT,
].join("\n");

export function doubleBlindProblems(text) {
  if (filled(field(text, "Double-blind aborted"))) return [];
  const missing = [];
  if (!filled(field(text, "Double-blind on"))) missing.push("a `Double-blind on:` line stating the falsifiable claim");
  const base = field(text, "Base");
  if (!base || !BASE.test(base)) missing.push("a `Base: <ref>@<short sha>` line naming the code the agents checked");

  const methods = field(text, "Methods");
  if (methods === null) {
    missing.push("a `Methods:` line naming how each agent reached its answer, with a grade for each");
  } else {
    const segments = methods.split(";").map((s) => s.trim()).filter(Boolean);
    const parsed = segments.map((s) => ({ s, method: exactlyOne(s, METHODS), grade: exactlyOne(s, GRADES) }));
    const bad = parsed.filter((p) => !p.method || !p.grade);
    if (bad.length) missing.push(`one method and one grade in each \`;\`-separated part of \`Methods:\` (not in: ${bad.map((p) => `"${p.s.slice(0, 60)}"`).join(", ")})`);
    const distinct = new Set(parsed.filter((p) => p.method).map((p) => p.method));
    if (distinct.size < 2) missing.push(`at least two different methods on the \`Methods:\` line (found ${distinct.size ? [...distinct].join(", ") : "none"})`);
  }

  const wave = field(text, "Adversarial wave");
  if (wave === null || !new RegExp(`^(?:FALSIFIED|SURVIVED|UNTESTED)\\s*${DASH}\\s*\\S`).test(wave)) {
    missing.push("an `Adversarial wave: <FALSIFIED|SURVIVED|UNTESTED> — <what was tested>` line");
  }
  if (!filled(field(text, "Unverified"))) missing.push('an `Unverified:` line — say "nothing" if everything was proven');
  return missing;
}

/** Skills whose turn can't end until the final message carries their closing block. */
export const ENFORCED_SKILLS = [
  { name: "review", trigger: /(^|\s)\/(stackmap:)?review(\s|$)/i, problems: reviewProblems, form: REVIEW_FORM, blocks: [REVIEW_BLOCK] },
  {
    name: "double-blind",
    trigger: /(^|\s)\/(stackmap:)?double-blind(\s|$)/i,
    problems: doubleBlindProblems,
    form: DOUBLE_BLIND_FORM,
    blocks: [DOUBLE_BLIND_BLOCK, [DOUBLE_BLIND_ABORT]],
  },
];
