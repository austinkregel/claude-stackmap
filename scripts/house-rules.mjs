#!/usr/bin/env node
/**
 * SessionStart / SubagentStart hook: inject the house rules into Claude's context.
 *
 * Why a hook and not a file: a rule kept in a file nobody reads changes behaviour very little; the
 * same rule held in context does. SessionStart fires on startup, resume, clear, compact, and fork,
 * so the rules come back after compaction. SubagentStart injects them into every sub-agent, which
 * otherwise inherits no standing rules at all.
 *
 * What gets injected (houseRules config):
 *   mode "extend"  (default) the shipped house-rules/default.md, minus sections listed in
 *                  `disable` (by their `<!-- id: … -->`), followed by each file in `files`.
 *   mode "replace" only the files in `files`.
 * Then a short list, generated from the guard config, of which rules this plugin's hooks enforce
 * mechanically. The rules text never claims enforcement the config has switched off.
 *
 * Informational, so it fails OPEN, but never silently and never partially: a configured file that
 * is missing, unreadable, or empty, an unknown `disable` id, or a total over Claude Code's 10,000
 * character limit for hook output injects NOTHING and shows the user why. Injecting the rest would
 * make a partial rule set read as the complete one. Over the limit, Claude Code would replace the
 * text with a preview and a file path, which is a truncation the model would not notice.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addContext, readPayload, reportError } from "./hook-lib.mjs";
import { loadHookConfig } from "./hook-config.mjs";
import { CATEGORIES } from "./suppression-rules.mjs";

const HOOK = "house-rules";
const EVENTS = new Set(["SessionStart", "SubagentStart"]);

/** Claude Code caps additionalContext at 10,000 characters (hooks reference, "JSON output"). */
const MAX_CONTEXT_CHARS = 10000;

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RULES = join(pluginRoot, "house-rules", "default.md");

const ID_LINE = /^<!--\s*id:\s*([a-z0-9-]+)\s*-->$/;

/**
 * Split a ruleset into its preamble and `## ` sections. Each section in the shipped default must
 * carry an id line directly under its heading; a missing or duplicate id is a defect in that file.
 */
function parseDefault(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const preamble = [];
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      const idMatch = ID_LINE.exec((lines[i + 1] ?? "").trim());
      if (!idMatch) throw new Error(`${DEFAULT_RULES}: section "${line}" has no "<!-- id: … -->" line under its heading`);
      if (sections.some((s) => s.id === idMatch[1])) throw new Error(`${DEFAULT_RULES}: duplicate section id "${idMatch[1]}"`);
      current = { id: idMatch[1], lines: [line] };
      sections.push(current);
      i++; // the id line is metadata, not rule text
      continue;
    }
    (current ? current.lines : preamble).push(line);
  }
  const render = (ls) => ls.join("\n").trim();
  return { preamble: render(preamble), sections: sections.map((s) => ({ id: s.id, text: render(s.lines) })) };
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
    const kept = parsed.sections.filter((s) => !houseRules.disable.includes(s.id));
    parts.push({ source: `default rules (${kept.length} of ${known.length} sections)`, text: [parsed.preamble, ...kept.map((s) => s.text)].join("\n\n") });
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

  addContext(event, assemble(cfg));
}

main().catch((err) => reportError(HOOK, err?.message ?? err));
