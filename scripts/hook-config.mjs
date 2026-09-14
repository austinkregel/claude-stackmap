/**
 * The hooks' view of the stackmap config: the `guard` and `houseRules` sections.
 *
 * Dependency-free and not imported from dist/, so a broken TypeScript build cannot disable a
 * guardrail. src/config.ts does not model these two sections; this file is their only owner.
 *
 * Resolution order matches src/config.ts, first hit wins:
 *   $STACKMAP_CONFIG, $XDG_CONFIG_HOME/stackmap/config.json, ~/.config/stackmap/config.json
 *
 * Validation is strict: invalid JSON, a wrong type, or an unknown key throws `ConfigError` naming
 * the file and every issue, never a fallback to defaults.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CATEGORIES } from "./suppression-rules.mjs";

export class ConfigError extends Error {}

/** Programs that cut down a command's output, per the no-truncate rule. Configurable. */
export const DEFAULT_TRUNCATING_CONSUMERS = [
  "head", "tail", "less", "more", "cut", "grep", "egrep", "rg", "sed", "awk",
  "Select-Object", "Select-String", "Format-Table", "findstr",
];

const DEFAULTS = {
  guard: {
    enabled: true,
    protectedBranches: ["develop", "main", "master"],
    allowMerge: false,
    noTruncate: { enabled: true, consumers: DEFAULT_TRUNCATING_CONSUMERS },
    noSuppress: { enabled: true, disableCategories: [] },
    commitMessage: {
      enabled: true,
      // Subcommand names come from the tool itself, so the list never goes stale.
      commands: [{ name: "git", listCommand: ["git", "--list-cmds=main,alias"] }],
    },
  },
  houseRules: { enabled: true, subagents: true, mode: "extend", files: [], disable: [] },
};

function expandPath(p) {
  let out = p;
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  return isAbsolute(out) ? out : resolve(out);
}

export function configCandidates() {
  const out = [];
  if (process.env.STACKMAP_CONFIG) out.push(expandPath(process.env.STACKMAP_CONFIG));
  if (process.env.XDG_CONFIG_HOME) {
    out.push(join(expandPath(process.env.XDG_CONFIG_HOME), "stackmap", "config.json"));
  }
  out.push(join(homedir(), ".config", "stackmap", "config.json"));
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);

/** Validate `value` against the shape of `defaults`, collecting issues instead of stopping early. */
function merge(defaults, value, path, issues, validators = {}) {
  if (value === undefined) return defaults;
  if (!isPlainObject(value)) {
    issues.push(`${path}: expected an object`);
    return defaults;
  }
  const out = { ...defaults };
  for (const key of Object.keys(value)) {
    if (!(key in defaults)) {
      issues.push(`${path}.${key}: unknown key (known: ${Object.keys(defaults).join(", ")})`);
      continue;
    }
    const v = value[key];
    const d = defaults[key];
    const where = `${path}.${key}`;
    if (validators[key]) {
      const problem = validators[key](v);
      if (problem) issues.push(`${where}: ${problem}`);
      else out[key] = v;
    } else if (typeof d === "boolean") {
      if (typeof v !== "boolean") issues.push(`${where}: expected true or false`);
      else out[key] = v;
    } else if (Array.isArray(d)) {
      if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
        issues.push(`${where}: expected an array of strings`);
      } else out[key] = v;
    } else if (isPlainObject(d)) {
      out[key] = merge(d, v, where, issues, validators[`${key}.*`] ?? {});
    } else {
      issues.push(`${where}: no validator for this key (hook-config.mjs defect)`);
    }
  }
  return out;
}

function validateCommands(v) {
  if (!Array.isArray(v)) return "expected an array of { name, subcommands | listCommand }";
  for (const [i, entry] of v.entries()) {
    if (!isPlainObject(entry)) return `[${i}]: expected an object`;
    const keys = Object.keys(entry);
    const unknown = keys.filter((k) => !["name", "subcommands", "listCommand"].includes(k));
    if (unknown.length) return `[${i}]: unknown key(s) ${unknown.join(", ")}`;
    if (typeof entry.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(entry.name)) {
      return `[${i}].name: expected a command name`;
    }
    const hasList = "subcommands" in entry;
    const hasCmd = "listCommand" in entry;
    if (hasList === hasCmd) return `[${i}]: give exactly one of "subcommands" or "listCommand"`;
    if (hasList && !isStringArray(entry.subcommands)) return `[${i}].subcommands: expected non-empty strings`;
    if (hasCmd && (!isStringArray(entry.listCommand) || entry.listCommand.length === 0)) {
      return `[${i}].listCommand: expected a non-empty argv array`;
    }
  }
  return null;
}

/**
 * Load and validate. Returns `{ path, guard, houseRules }`; `path` is null when no config file
 * exists, in which case the defaults apply (having no config is not an error).
 */
export function loadHookConfig() {
  for (const candidate of configCandidates()) {
    if (!existsSync(candidate)) continue;
    let raw;
    try {
      raw = JSON.parse(readFileSync(candidate, "utf8"));
    } catch (err) {
      throw new ConfigError(`config at ${candidate} is not valid JSON — ${err.message}`);
    }
    if (!isPlainObject(raw)) throw new ConfigError(`config at ${candidate} is not a JSON object`);

    const issues = [];
    const guard = merge(DEFAULTS.guard, raw.guard, "guard", issues, {
      protectedBranches: (v) => (isStringArray(v) ? null : "expected an array of branch names"),
      "noTruncate.*": {
        consumers: (v) => (isStringArray(v) ? null : "expected an array of program names"),
      },
      "noSuppress.*": {
        disableCategories: (v) => {
          if (!isStringArray(v)) return "expected an array of category names";
          const bad = v.filter((c) => !CATEGORIES.includes(c));
          return bad.length ? `unknown categor${bad.length > 1 ? "ies" : "y"} ${bad.join(", ")} (known: ${CATEGORIES.join(", ")})` : null;
        },
      },
      "commitMessage.*": { commands: validateCommands },
    });
    const houseRules = merge(DEFAULTS.houseRules, raw.houseRules, "houseRules", issues, {
      mode: (v) => (v === "extend" || v === "replace" ? null : 'expected "extend" or "replace"'),
      files: (v) => {
        if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s.length > 0)) {
          return "expected an array of file paths";
        }
        const relative = v.filter((p) => !(p === "~" || p.startsWith("~/") || isAbsolute(p)));
        return relative.length
          ? `paths must be absolute or start with ~/ (hooks run with the project as cwd): ${relative.join(", ")}`
          : null;
      },
      disable: (v) => (Array.isArray(v) && v.every((s) => typeof s === "string") ? null : "expected an array of section ids"),
    });
    if (houseRules.mode === "replace" && houseRules.files.length === 0) {
      issues.push('houseRules: mode "replace" needs at least one entry in "files"');
    }
    if (houseRules.mode === "replace" && houseRules.disable.length > 0) {
      issues.push('houseRules.disable: has no effect with mode "replace", which drops the defaults entirely');
    }

    if (issues.length) {
      throw new ConfigError(`config at ${candidate} is invalid:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    }
    return { path: candidate, guard, houseRules: { ...houseRules, files: houseRules.files.map(expandPath) } };
  }
  return { path: null, guard: DEFAULTS.guard, houseRules: DEFAULTS.houseRules };
}
