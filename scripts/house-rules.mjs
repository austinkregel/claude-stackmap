#!/usr/bin/env node
/**
 * SessionStart / SubagentStart hook: inject the house rules into Claude's context.
 *
 * What gets injected (houseRules config):
 *   mode "extend"  (default) the shipped house-rules/default.md, minus sections listed in
 *                  `disable` (by their `<!-- id: … -->`), followed by each file in `files`.
 *   mode "replace" only the files in `files`.
 * Then a list, generated from the guard config, of which rules the hooks enforce, so the text never
 * claims enforcement the config has switched off.
 *
 * In the default, an `<!-- enforced-by: name -->` line directly above a `## ` heading or a `- `
 * bullet drops that section or bullet while the named guard is enabled; the enforcement list and
 * the guard's block message carry it instead. `houseRules.subagents: false` skips SubagentStart.
 *
 * Fails open, visibly, and never partially: a configured file that is missing, unreadable, or
 * empty, an unknown `disable` id, or a total over the 10,000-character hook output limit injects
 * nothing and reports why.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addContext, readPayload, reportError } from "./hook-lib.mjs";
import { loadHookConfig } from "./hook-config.mjs";
import { CATEGORIES } from "./suppression-rules.mjs";

const HOOK = "house-rules";
const EVENTS = new Set(["SessionStart", "SubagentStart"]);

/** Claude Code caps additionalContext at 10,000 characters. */
const MAX_CONTEXT_CHARS = 10000;

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RULES = join(pluginRoot, "house-rules", "default.md");

const ID_LINE = /^<!--\s*id:\s*([a-z0-9-]+)\s*-->$/;
const ENFORCED_BY_LINE = /^<!--\s*enforced-by:\s*([^\s]+)\s*-->$/;

/** Whether the guard an `enforced-by` name refers to is currently enforcing. Throws on an unknown name. */
function isEnforced(name, guard) {
  const [key, category, ...rest] = name.split(":");
  const known = () => `known: guard, noTruncate, commitMessage, noSuppress, ${CATEGORIES.map((c) => `noSuppress:${c}`).join(", ")}`;
  if (rest.length || (category !== undefined && key !== "noSuppress")) throw new Error(`unknown enforced-by name "${name}" (${known()})`);
  switch (key) {
    case "guard":
      return guard.enabled;
    case "noTruncate":
      return guard.noTruncate.enabled;
    case "commitMessage":
      return guard.commitMessage.enabled;
    case "noSuppress":
      if (category === undefined) return guard.noSuppress.enabled;
      if (!CATEGORIES.includes(category)) throw new Error(`unknown enforced-by name "${name}" (${known()})`);
      return guard.noSuppress.enabled && !guard.noSuppress.disableCategories.includes(category);
    default:
      throw new Error(`unknown enforced-by name "${name}" (${known()})`);
  }
}

/**
 * Split a ruleset into its preamble and `## ` sections, each a list of blocks. Each section in the
 * shipped default must carry an id line directly under its heading; a missing or duplicate id, or an
 * `enforced-by` line that tags neither a heading nor a bullet, is a defect in that file.
 */
function parseDefault(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const preamble = [];
  const sections = [];
  let current = null;
  let pending = null; // enforced-by name for the heading or bullet on the next line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const enforced = ENFORCED_BY_LINE.exec(line.trim());
    if (enforced) {
      const next = lines[i + 1] ?? "";
      if (!next.startsWith("## ") && !next.startsWith("- ")) {
        throw new Error(`${DEFAULT_RULES}:${i + 1}: an enforced-by line must be directly above a "## " heading or a "- " bullet`);
      }
      pending = enforced[1];
      continue;
    }
    if (line.startsWith("## ")) {
      const idMatch = ID_LINE.exec((lines[i + 1] ?? "").trim());
      if (!idMatch) throw new Error(`${DEFAULT_RULES}: section "${line}" has no "<!-- id: … -->" line under its heading`);
      if (sections.some((s) => s.id === idMatch[1])) throw new Error(`${DEFAULT_RULES}: duplicate section id "${idMatch[1]}"`);
      current = { id: idMatch[1], enforcedBy: pending, blocks: [{ enforcedBy: null, lines: [line] }] };
      pending = null;
      sections.push(current);
      i++; // the id line is metadata, not rule text
      continue;
    }
    const blocks = current ? current.blocks : preamble;
    const last = blocks[blocks.length - 1];
    if (line.startsWith("- ")) {
      blocks.push({ enforcedBy: pending, bullet: true, lines: [line] });
      pending = null;
    } else if (last?.bullet && /^\s+\S/.test(line)) {
      last.lines.push(line); // a wrapped bullet's continuation line
    } else {
      blocks.push({ enforcedBy: null, lines: [line] });
    }
  }
  return { preamble, sections };
}

/** Render blocks, leaving out the ones whose guard is enforcing. */
function renderBlocks(blocks, guard) {
  return blocks
    .filter((b) => !(b.enforcedBy && isEnforced(b.enforcedBy, guard)))
    .flatMap((b) => b.lines)
    .join("\n")
    .trim();
}

function readRulesFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8").replace(/\r\n/g, "\n").trim();
  } catch (err) {
    throw new Error(`house rules file ${path} could not be read (${err.code ?? err.message}); no house rules were injected`);
  }
  if (!text) throw new Error(`house rules file ${path} is empty; no house rules were injected`);
  return text;
}

/** Plain-language list of what the guard config actually enforces. */
function enforcementNote(guard) {
  const items = [];
  if (guard.enabled) {
    items.push(
      `Destructive commands are blocked: ${guard.allowMerge ? "" : "git merge, "}force push, pushes and ` +
        `commits on ${guard.protectedBranches.join(", ")}, git reset --hard, migrate:fresh/refresh/reset, ` +
        `db:wipe, and DROP/TRUNCATE TABLE.`,
    );
  }
  if (guard.noTruncate.enabled) {
    items.push(
      `Piping a command's output into ${guard.noTruncate.consumers.join(", ")} is blocked unless tee ` +
        `is the command straight after the pipe.`,
    );
  }
  if (guard.noSuppress.enabled) {
    const active = CATEGORIES.filter((c) => !guard.noSuppress.disableCategories.includes(c));
    items.push(`Edits that introduce a check-silencing directive are blocked (${active.join(", ")}).`);
  }
  if (guard.commitMessage.enabled) {
    items.push(`Commit messages that contain a ${guard.commitMessage.commands.map((c) => c.name).join("/")} subcommand are blocked.`);
  }
  const header = "## Enforced by stackmap hooks";
  if (items.length === 0) {
    return `${header}\nNo stackmap guard is enabled in the current config; every rule above is guidance only.`;
  }
  return `${header}\nEverything above is guidance. These parts are also enforced by hooks, as currently configured:\n${items
    .map((i) => `- ${i}`)
    .join("\n")}`;
}

function assemble(cfg) {
  const { houseRules, guard } = cfg;
  const parts = []; // { source, text }

  if (houseRules.mode === "extend") {
    const parsed = parseDefault(readFileSync(DEFAULT_RULES, "utf8"));
    const known = parsed.sections.map((s) => s.id);
    const unknown = houseRules.disable.filter((id) => !known.includes(id));
    if (unknown.length) {
      throw new Error(
        `houseRules.disable names unknown section id(s) ${unknown.join(", ")} (known: ${known.join(", ")}); no house rules were injected`,
      );
    }
    // Every enforced-by name is checked, including ones in disabled sections, so a typo can't hide.
    for (const s of parsed.sections) {
      for (const name of [s.enforcedBy, ...s.blocks.map((b) => b.enforcedBy)]) if (name) isEnforced(name, guard);
    }
    const kept = parsed.sections.filter(
      (s) => !houseRules.disable.includes(s.id) && !(s.enforcedBy && isEnforced(s.enforcedBy, guard)),
    );
    const text = [renderBlocks(parsed.preamble, guard), ...kept.map((s) => renderBlocks(s.blocks, guard))].join("\n\n");
    parts.push({ source: `default rules (${kept.length} of ${known.length} sections)`, text });
  }
  for (const file of houseRules.files) parts.push({ source: file, text: readRulesFile(file) });
  parts.push({ source: "enforcement list", text: enforcementNote(guard) });

  const text = parts.map((p) => p.text).join("\n\n");
  if (text.length > MAX_CONTEXT_CHARS) {
    const sizes = parts.map((p) => `${p.source}: ${p.text.length}`).join("; ");
    throw new Error(
      `house rules total ${text.length} characters, over Claude Code's ${MAX_CONTEXT_CHARS}-character hook output limit ` +
        `(${sizes}). No house rules were injected. Disable default sections, use mode "replace", or shorten a file.`,
    );
  }
  return text;
}

async function main() {
  const input = await readPayload();
  const event = input.hook_event_name;
  if (!EVENTS.has(event)) throw new Error(`registered for an unexpected event "${event}"; no house rules were injected`);

  const cfg = loadHookConfig();
  if (!cfg.houseRules.enabled) return;
  if (event === "SubagentStart" && !cfg.houseRules.subagents) return;

  addContext(event, assemble(cfg));
}

main().catch((err) => reportError(HOOK, err?.message ?? err));
