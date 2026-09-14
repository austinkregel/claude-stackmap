/**
 * The closing blocks that enforced skills and the adversarial auditor must end with, and the
 * checks that name what a final message is missing. An empty list means satisfied.
 *
 * Labels match at the start of a line, with or without `**bold**`; the last occurrence wins, so
 * an earlier mention of a label doesn't count as the block.
 */

import { parse } from "./shell-tokens.mjs";

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
  "Reproducer:",
  "  Command: <the command exactly as you ran it with Bash>",
  "  Expected: <what the claim predicts it prints>",
  "  Actual: <the lines it printed, copied exactly>",
  "Tested:",
  "- <command run or file:line read> → <what it showed>",
  "Grade: PROVEN | INFERRED | SPECULATIVE",
  "Unchecked: <what went unchecked, or \"nothing\">",
  "Needs: <the access that would let you test it>   (UNTESTED only)",
];
export const AUDIT_FORM = AUDIT_BLOCK.join("\n");

/** The template's own text after `Label:`, so a report that copies the form unfilled is caught. */
const templateValue = (label) => {
  const line = AUDIT_BLOCK.find((l) => l.trimStart().startsWith(`${label}:`));
  return line ? line.trimStart().slice(label.length + 1).trim() : null;
};
const TEMPLATE_TESTED_ITEM = AUDIT_BLOCK.find((l) => l.startsWith("- ")).slice(2);
const auditFilled = (label, value) => filled(value) && value !== templateValue(label);

/** The report proper: everything from the last `Claim:` line on, so earlier prose doesn't count. */
function reportSection(text) {
  let start = -1;
  for (const m of text.matchAll(labelRe("Claim"))) start = m.index;
  return start === -1 ? text : text.slice(start);
}

export function auditVerdict(text) {
  return exactlyOne(field(text, "Verdict"), VERDICTS);
}

export function auditReportProblems(text) {
  const missing = [];
  if (!auditFilled("Claim", field(text, "Claim"))) missing.push("a `Claim:` line restating the claim you audited");
  const base = field(text, "Audited at");
  if (!base || !BASE.test(base)) missing.push("an `Audited at: <ref>@<short sha>` line naming what you checked out (e.g. main@1a2b3c4)");

  const verdict = auditVerdict(text);
  if (!verdict) missing.push("a `Verdict:` line with exactly one of FALSIFIED, SURVIVED, UNTESTED");
  const grade = exactlyOne(field(text, "Grade"), GRADES);
  if (!grade) missing.push("a `Grade:` line with exactly one of PROVEN, INFERRED, SPECULATIVE");
  const decided = verdict === "FALSIFIED" || verdict === "SURVIVED";
  if (decided && grade && grade !== "PROVEN") {
    missing.push(`a PROVEN grade: ${verdict} graded ${grade} was not checked against ground truth, so report UNTESTED`);
  }

  const { groups, problems } = auditReproducers(text);
  missing.push(...problems);
  if (decided && groups.length === 0 && problems.length === 0) {
    missing.push(`at least one \`Reproducer:\` group (Command, Expected, Actual) for a ${verdict} verdict — a command you ran with Bash and the lines it printed; without one, report UNTESTED`);
  }

  const tested = listAfter(text, "Tested");
  if (!tested) {
    missing.push("a `Tested:` list of what you ran or read");
  } else {
    if (decided && tested.items.length === 0) missing.push(`at least one \`- <what you ran or read> → <what it showed>\` item under \`Tested:\` for a ${verdict} verdict`);
    const bare = tested.items.filter((item) => !/\S\s*(?:→|->)\s*\S/.test(item));
    if (bare.length) missing.push(`a "→ <what it showed>" result on every \`Tested:\` item (missing on: ${bare.map((b) => `"${b.slice(0, 60)}"`).join(", ")})`);
    if (tested.items.some((item) => item === TEMPLATE_TESTED_ITEM)) missing.push("a real `Tested:` item in place of the template's `- <command run or file:line read> → <what it showed>`");
    if (!decided && tested.items.length === 0 && !filled(tested.inline)) missing.push("a `Tested:` list, or `Tested: nothing` if no attempt was possible");
  }

  if (!auditFilled("Unchecked", field(text, "Unchecked"))) missing.push('an `Unchecked:` line — say "nothing" if everything was checked');
  if (verdict === "UNTESTED" && !auditFilled("Needs", field(text, "Needs"))) missing.push("a `Needs:` line naming the access that would let the claim be tested");
  return missing;
}

const REPRODUCER_FIELDS = ["Command", "Expected", "Actual"];
const subLabelRe = (label) => new RegExp(`^[ \\t]+(?:\\*\\*)?${escape(label)}:(?:\\*\\*)?[ \\t]?(.*)$`);
const headerRe = /^[ \t]*(?:\*\*)?Reproducer:(?:\*\*)?[ \t]*$/;

const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

/**
 * The `Reproducer:` groups in the report section. Each group is the header line followed, in order,
 * by indented `Command:`, `Expected:`, and `Actual:` lines. A value continues on the following lines
 * that are indented deeper than its label; the first such line sets the indentation, every line
 * must keep it, and it is removed, so a multi-line command or output keeps its line breaks. A
 * `Command:`, `Expected:`, or `Actual:` line outside a group is a problem, never skipped.
 */
export function auditReproducers(text) {
  const lines = reportSection(text).split("\n");
  const groups = [];
  const problems = [];
  const consumed = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!headerRe.test(lines[i])) continue;
    consumed.add(i);
    const n = groups.length + problems.length + 1;
    const group = { index: n };
    let at = i + 1;
    let ok = true;
    for (const [f, label] of REPRODUCER_FIELDS.entries()) {
      const m = at < lines.length ? subLabelRe(label).exec(lines[at]) : null;
      if (!m) {
        problems.push(`Reproducer ${n}: an indented \`${label}:\` line ${f === 0 ? "right after `Reproducer:`" : `after \`${REPRODUCER_FIELDS[f - 1]}:\``}`);
        ok = false;
        break;
      }
      consumed.add(at);
      const labelIndent = indentOf(lines[at]);
      const value = [m[1]];
      at++;
      let blockIndent = null;
      while (at < lines.length && lines[at].trim() !== "" && indentOf(lines[at]) > labelIndent) {
        blockIndent ??= indentOf(lines[at]);
        if (indentOf(lines[at]) < blockIndent) {
          problems.push(`Reproducer ${n}: every continuation line of \`${label}:\` indented the same as its first continuation line (line "${lines[at].trim().slice(0, 60)}" is indented less)`);
          ok = false;
          break;
        }
        value.push(lines[at].slice(blockIndent));
        consumed.add(at);
        at++;
      }
      if (!ok) break;
      group[label.toLowerCase()] = value.join("\n");
      if (!auditFilled(label, group[label.toLowerCase()].trim())) {
        problems.push(`Reproducer ${n}: a filled-in \`${label}:\` value, not the template's placeholder`);
        ok = false;
        break;
      }
    }
    if (ok) {
      groups.push(group);
    } else {
      // The rest of a broken group is already reported; don't report its lines again as strays.
      while (at < lines.length && !headerRe.test(lines[at]) && (indentOf(lines[at]) > 0 && lines[at].trim() !== "")) consumed.add(at++);
    }
    i = at - 1;
  }
  for (const [i, line] of lines.entries()) {
    if (consumed.has(i)) continue;
    const label = REPRODUCER_FIELDS.find((l) => subLabelRe(l).test(line));
    if (label) problems.push(`a \`Reproducer:\` line before the \`${label}:\` line "${line.trim().slice(0, 60)}" — each group starts with its own \`Reproducer:\``);
  }
  return { groups, problems };
}

/** Word parts are merged when quoting can't change their meaning, so `a\ b`, `'a b'`, and `"a b"` compare equal. */
const QUOTE_SENSITIVE = /[*?[\]{}~]/;
function canonicalShell(node) {
  if (Array.isArray(node)) return node.map(canonicalShell);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "source" || key === "raw") continue;
    out[key] = key === "parts" ? canonicalParts(value) : canonicalShell(value);
  }
  return out;
}
function canonicalParts(parts) {
  const out = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    const plain = part.kind === "lit" && !QUOTE_SENSITIVE.test(part.text);
    if (plain && prev?.kind === "lit" && prev.merged) {
      prev.text += part.text;
    } else if (plain) {
      out.push({ kind: "lit", text: part.text, merged: true });
    } else {
      out.push(canonicalShell(part));
    }
  }
  return out;
}

/**
 * Whether two commands are the same to the shell: equal after parsing, ignoring spacing, line
 * continuations, and quoting that can't change a word's meaning. Throws ShellParseError when the
 * reproducer's command can't be parsed; a transcript command that can't be parsed only matches
 * character for character.
 */
export function sameShellCommand(reproducerCommand, ranCommand) {
  const wanted = JSON.stringify(canonicalShell(parse(reproducerCommand)));
  if (reproducerCommand === ranCommand) return true;
  try {
    return wanted === JSON.stringify(canonicalShell(parse(ranCommand)));
  } catch {
    return false;
  }
}

/** `actual`'s lines appear, exactly and consecutively, among `output`'s lines. */
function containsLineBlock(output, actual) {
  const out = output.split("\n");
  const want = actual.split("\n");
  for (let i = 0; i + want.length <= out.length; i++) {
    if (want.every((line, j) => out[i + j] === line)) return true;
  }
  return false;
}

/** The marker Claude Code leaves where it cut the middle out of a long failed command's output. */
const EXCERPT_MARKER = /^\.\.\. \[\d+ characters truncated\] \.\.\.$/m;

/**
 * Check each reproducer against the Bash calls a transcript recorded.
 *   blocking — problems the auditor can fix: a command that never ran, output that doesn't match.
 *   surfaced — things that can't be checked: an unparseable command, output cut from an excerpt.
 *   waiting  — reproducers whose command ran but whose result isn't written yet (write lag).
 */
export function verifyReproducers(groups, calls) {
  const blocking = [];
  const surfaced = [];
  const waiting = [];
  for (const group of groups) {
    const label = `Reproducer ${group.index} (\`${group.command.split("\n")[0].slice(0, 80)}\`)`;
    let candidates;
    try {
      candidates = calls.filter((call) => sameShellCommand(group.command, call.command));
    } catch (err) {
      surfaced.push(`${label}: the command can't be parsed as shell (${err.message}), so it could not be checked against the transcript`);
      continue;
    }
    if (candidates.length === 0) {
      blocking.push(`${label}: no Bash call in your session ran this command; copy the command exactly as you ran it`);
      continue;
    }
    const finished = candidates.filter((call) => call.result !== null);
    if (finished.some((call) => containsLineBlock(call.result.output, group.actual))) continue;
    if (finished.length < candidates.length) {
      waiting.push(label);
      continue;
    }
    if (finished.some((call) => call.result.isError && EXCERPT_MARKER.test(call.result.output))) {
      surfaced.push(`${label}: its output was cut to a head-and-tail excerpt in the transcript, and \`Actual\` isn't in the part that was kept, so it could not be checked`);
      continue;
    }
    blocking.push(`${label}: \`Actual\` isn't an exact run of lines in what that command printed (${finished.length} run${finished.length === 1 ? "" : "s"} checked); copy the lines exactly`);
  }
  return { blocking, surfaced, waiting };
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

/**
 * True when a UserPromptSubmit prompt is a background-task notification rather than something the
 * user typed. Claude Code delivers a finished background agent or command as a prompt shaped
 * `<task-notification>\n<task-id>…</task-id>…\n</task-notification>`, with the agent's output inside;
 * the payload carries no other marker of its origin. Such a prompt never invokes a skill, however
 * its output mentions one.
 */
export function isTaskNotification(prompt) {
  return /^<task-notification>\n<task-id>[^<\n]+<\/task-id>\n[\s\S]*\n<\/task-notification>\s*$/.test(String(prompt ?? ""));
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
