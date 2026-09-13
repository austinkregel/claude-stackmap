#!/usr/bin/env node
/**
 * PreToolUse(Edit|Write|NotebookEdit): block edits that SILENCE a check instead of fixing it.
 *
 * Why: a suppressed lint, a skipped test, or a relaxed type check turns a real problem into a
 * green result. Dead code in particular should be deleted, not annotated to keep the tooling
 * quiet — it is tech debt and a liability. The catalog lives in suppression-rules.mjs.
 *
 * Only an edit that INTRODUCES a directive is blocked: per rule, the number of matches after the
 * edit must not exceed the number before it. Removing a directive, or editing around one that was
 * already there, passes.
 *
 * Where "before" comes from:
 *   - Edit:         old_string → new_string.
 *   - Write:        the file currently on disk → the new content. Comparing against "" would
 *                   block every rewrite of a file that already carries a directive.
 *   - NotebookEdit: the existing cell's source → new_source. Rules come from the notebook's
 *                   declared language; when it declares none, the cell is checked against every
 *                   inline-code rule. Markdown cells are prose and pass.
 *
 * Fails CLOSED: an unreadable payload, invalid config, a file that exists but cannot be read, or a
 * notebook cell that cannot be located blocks.
 */
import { existsSync, readFileSync } from "node:fs";
import { deny, failClosed, readPayload } from "./hook-lib.mjs";
import { loadHookConfig } from "./hook-config.mjs";
import { inlineCodeRules, introduced, isProse, rulesForPath } from "./suppression-rules.mjs";

const HOOK = "no-suppress";

class CannotEvaluate extends Error {}

/** Extension whose rules apply to a notebook kernel language. */
const NOTEBOOK_LANGUAGE_EXT = {
  python: ".py", javascript: ".js", typescript: ".ts", rust: ".rs", go: ".go", java: ".java",
  kotlin: ".kt", scala: ".scala", "c#": ".cs", csharp: ".cs", "c++": ".cpp", cpp: ".cpp", c: ".c",
  ruby: ".rb", php: ".php", elixir: ".ex", bash: ".sh", sh: ".sh", swift: ".swift",
};

function readExisting(path) {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new CannotEvaluate(`${path} exists but could not be read to compare against (${err.code ?? err.message})`);
  }
}

const cellSource = (cell) => (Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? ""));

/** { rules, pairs } for this tool call, or null when there is nothing to check. */
function whatToCheck(toolName, ti, disabled) {
  if (toolName === "Edit") {
    if (typeof ti.file_path !== "string" || typeof ti.new_string !== "string") {
      throw new CannotEvaluate("Edit call with no readable file_path/new_string");
    }
    if (isProse(ti.file_path)) return null;
    const before = typeof ti.old_string === "string" ? ti.old_string : "";
    return { rules: rulesForPath(ti.file_path, disabled), pairs: [{ before, after: ti.new_string }] };
  }

  if (toolName === "Write") {
    if (typeof ti.file_path !== "string" || typeof ti.content !== "string") {
      throw new CannotEvaluate("Write call with no readable file_path/content");
    }
    if (isProse(ti.file_path)) return null;
    return { rules: rulesForPath(ti.file_path, disabled), pairs: [{ before: readExisting(ti.file_path), after: ti.content }] };
  }

  if (toolName === "NotebookEdit") {
    const path = ti.notebook_path;
    if (typeof path !== "string") throw new CannotEvaluate("NotebookEdit call with no readable notebook_path");
    const mode = ti.edit_mode ?? "replace";
    if (mode === "delete") return null;
    if (typeof ti.new_source !== "string") throw new CannotEvaluate("NotebookEdit call with no readable new_source");

    let notebook;
    try {
      notebook = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new CannotEvaluate(`could not read notebook ${path} (${err.code ?? err.message})`);
    }
    const cells = Array.isArray(notebook.cells) ? notebook.cells : [];
    let before = "";
    let cellType = ti.cell_type;
    if (mode === "replace") {
      const cell = cells.find((c) => c.id === ti.cell_id);
      if (!cell) throw new CannotEvaluate(`notebook ${path} has no cell with id "${ti.cell_id}"`);
      before = cellSource(cell);
      cellType ??= cell.cell_type;
    }
    if (cellType === "markdown") return null;

    const meta = notebook.metadata ?? {};
    const language = String(meta.kernelspec?.language ?? meta.language_info?.name ?? "").toLowerCase();
    const ext = NOTEBOOK_LANGUAGE_EXT[language];
    const rules = ext ? rulesForPath(`cell${ext}`, disabled) : inlineCodeRules(disabled);
    return { rules, pairs: [{ before, after: ti.new_source }] };
  }

  return null; // not a tool this guard inspects
}

const reasonFor = (hits) =>
  "Blocked: this edit introduces a check-silencing directive:\n" +
  hits.map(({ rule, line }) => `  - ${rule.id} (${rule.category})${line ? `: ${line}` : ""}`).join("\n") +
  "\n\nHouse rule: never disable, skip, suppress, or relax a test, assertion, lint, or type check to " +
  "get a green result. If the code is dead, delete it. If the check is failing, fix what it reports. " +
  "A green result obtained by narrowing the check is not a pass.\n\n" +
  "If you believe the check itself is wrong, stop and tell the user what it reports and why — let " +
  "them decide. Do not silence it and continue.";

async function main() {
  let input;
  try {
    input = await readPayload();
  } catch (err) {
    return failClosed(HOOK, `unreadable hook payload (${err.message})`);
  }
  if (!["Edit", "Write", "NotebookEdit"].includes(input.tool_name)) return;

  let cfg;
  try {
    cfg = loadHookConfig();
  } catch (err) {
    return failClosed(HOOK, err.message);
  }
  const { enabled, disableCategories } = cfg.guard.noSuppress;
  if (!enabled) return;

  const ti = input.tool_input;
  if (!ti || typeof ti !== "object") return failClosed(HOOK, `${input.tool_name} call with no readable tool_input`);

  let check;
  try {
    check = whatToCheck(input.tool_name, ti, disableCategories);
  } catch (err) {
    if (err instanceof CannotEvaluate) return failClosed(HOOK, err.message);
    throw err;
  }
  if (!check) return;

  const hits = introduced(check.rules, check.pairs);
  if (hits.length) return deny(reasonFor(hits));
}

main().catch((err) => failClosed(HOOK, `internal error (${err?.message ?? err})`));
