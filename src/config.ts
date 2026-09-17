import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, isAbsolute, dirname } from "node:path";
import { z } from "zod";

/** Expand a leading `~` and make the path absolute. */
export function expandPath(p: string): string {
  let out = p;
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  return isAbsolute(out) ? out : resolve(out);
}

/** An extra root of the same project. Without its own include/exclude it inherits the project's. */
export const AliasSchema = z.strictObject({
  /** Directory. `~` is expanded. */
  path: z.string().min(1),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});
export type AliasConfig = z.infer<typeof AliasSchema>;

/** One project. Unknown keys are errors, so a misspelled field is reported rather than dropped. */
export const IndexConfigSchema = z.strictObject({
  /** Short handle used to select this project in tool calls. */
  name: z.string().min(1),
  /** The project's main root; it owns the index. `~` is expanded. */
  root: z.string().min(1),
  /** Which stack adapter to use. `auto` detects from the root. */
  adapter: z.enum(["auto", "laravel", "ghidra", "phoenix", "node"]).default("auto"),
  /** Directories scanned for source. Adapter supplies defaults when omitted. */
  include: z.array(z.string()).optional(),
  /** Directories never scanned, merged with adapter + global defaults. */
  exclude: z.array(z.string()).optional(),
  /** Free-form per-adapter settings. */
  options: z.record(z.string(), z.unknown()).default({}),
  /** Set false to keep the entry but skip it at load time. */
  enabled: z.boolean().default(true),
  /** Extra roots searched as part of this project. */
  aliases: z.array(AliasSchema).default([]),
});
export type IndexConfig = z.infer<typeof IndexConfigSchema>;

/**
 * The file's top level. `indexes` is validated entry by entry in parseConfig, so one bad entry
 * invalidates only itself. Other top-level keys (`guard`, `houseRules`) belong to the hooks'
 * hook-config.mjs and are not modelled here.
 */
const RawConfigSchema = z.object({
  indexes: z.array(z.unknown()).default([]),
  /** Project used when a tool call omits `scope` and more than one is configured. */
  defaultIndex: z.string().optional(),
  /** Where cross-session notes live. Plain markdown files, git-friendly. */
  notesDir: z.string().default("~/.config/stackmap/notes"),
  /** Applied to every index in addition to its own excludes. */
  globalExclude: z
    .array(z.string())
    .default(["vendor", "node_modules", "_build", "deps", ".git", "storage", "dist", "build"]),
});

/** An index entry that was not loaded, and why. */
export interface IndexLoadError {
  /** Position in the file's `indexes` array. */
  entry: number;
  name: string | null;
  kind: "invalid" | "duplicate";
  message: string;
}

export interface Config {
  indexes: IndexConfig[];
  defaultIndex?: string;
  notesDir: string;
  globalExclude: string[];
  /** Entries left out: invalid ones, and later entries reusing an earlier name. */
  indexErrors: IndexLoadError[];
}

export interface LoadedConfig {
  config: Config;
  /** Absolute path the config was read from, or null when defaults were used. */
  path: string | null;
}

/**
 * Include directories a root's own exclude list rules out, as the walker would: an exclude without a
 * `/` is a directory name at any depth, one with a `/` a root-relative path and everything under it.
 * Such a pair is a contradiction in the entry, reported rather than resolved one way.
 */
function contradictions(include: string[] | undefined, exclude: string[] | undefined): string[] {
  if (!include || !exclude) return [];
  const clean = (p: string) => p.replace(/^\/+|\/+$/g, "");
  const names = exclude.filter((e) => !e.includes("/"));
  const paths = exclude.filter((e) => e.includes("/")).map(clean);
  return include.filter((dir) => {
    const d = clean(dir);
    return d.split("/").some((part) => names.includes(part)) || paths.some((p) => d === p || d.startsWith(`${p}/`));
  });
}

function entryContradictions(entry: IndexConfig): string[] {
  const out: string[] = [];
  const own = contradictions(entry.include, entry.exclude);
  if (own.length) out.push(`include ${own.join(", ")} is also excluded`);
  for (const [i, a] of entry.aliases.entries()) {
    const hit = contradictions(a.include ?? entry.include, a.exclude ?? entry.exclude);
    if (hit.length) out.push(`aliases.${i} (${a.path}): include ${hit.join(", ")} is also excluded`);
  }
  return out;
}

const issueList = (issues: z.ZodError["issues"]) => issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

/**
 * Validate a config object. The top level must be valid. Each index entry is validated on its own:
 * an invalid entry, or a later entry reusing an earlier entry's name, is left out and recorded in
 * `indexErrors`, and the rest load.
 */
export function parseConfig(raw: unknown, source = "config"): Config {
  const parsed = RawConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`stackmap: ${source} is invalid:\n${issues}`);
  }
  const indexes: IndexConfig[] = [];
  const indexErrors: IndexLoadError[] = [];
  for (const [entry, value] of parsed.data.indexes.entries()) {
    const name = value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string" ? (value as { name: string }).name : null;
    const one = IndexConfigSchema.safeParse(value);
    if (!one.success) {
      indexErrors.push({ entry, name, kind: "invalid", message: `indexes.${entry}${name ? ` ("${name}")` : ""} is invalid: ${issueList(one.error.issues)}` });
      continue;
    }
    const contradicted = entryContradictions(one.data);
    if (contradicted.length) {
      indexErrors.push({ entry, name: one.data.name, kind: "invalid", message: `indexes.${entry} ("${one.data.name}") is invalid: ${contradicted.join("; ")}` });
      continue;
    }
    const first = indexes.find((i) => i.name === one.data.name);
    if (first) {
      indexErrors.push({
        entry,
        name: one.data.name,
        kind: "duplicate",
        message: `indexes.${entry} reuses the name "${one.data.name}"; the first entry with that name is used and this one is ignored`,
      });
      continue;
    }
    indexes.push(one.data);
  }
  const { indexes: _raw, ...rest } = parsed.data;
  return { ...rest, indexes, indexErrors };
}

/**
 * Resolution order, first hit wins:
 *   1. $STACKMAP_CONFIG
 *   2. $XDG_CONFIG_HOME/stackmap/config.json
 *   3. ~/.config/stackmap/config.json
 */
export function configCandidates(): string[] {
  const out: string[] = [];
  if (process.env.STACKMAP_CONFIG) out.push(expandPath(process.env.STACKMAP_CONFIG));
  if (process.env.XDG_CONFIG_HOME) out.push(join(expandPath(process.env.XDG_CONFIG_HOME), "stackmap", "config.json"));
  out.push(join(homedir(), ".config", "stackmap", "config.json"));
  return out;
}

export function loadConfig(): LoadedConfig {
  for (const candidate of configCandidates()) {
    if (!existsSync(candidate)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(candidate, "utf8"));
    } catch (err) {
      throw new Error(`stackmap: config at ${candidate} is not valid JSON — ${(err as Error).message}`);
    }
    return { config: parseConfig(raw, `config at ${candidate}`), path: candidate };
  }
  return { config: parseConfig({}), path: null };
}

/** Why a name that isn't a loaded, enabled index can't be used. */
function unusableName(config: Config, name: string): string {
  const invalid = config.indexErrors.find((e) => e.kind === "invalid" && e.name === name);
  if (invalid) return `stackmap: index "${name}" was not loaded — ${invalid.message}`;
  const enabled = config.indexes.filter((i) => i.enabled);
  if (config.indexes.some((i) => i.name === name)) return `stackmap: index "${name}" is disabled. Enabled: ${enabled.map((i) => i.name).join(", ") || "(none)"}`;
  return `stackmap: no enabled index named "${name}". Known: ${enabled.map((i) => i.name).join(", ") || "(none)"}`;
}

/** Pick one project by name, falling back to defaultIndex, then to a lone enabled entry. */
export function selectIndex(config: Config, name?: string): IndexConfig {
  const enabled = config.indexes.filter((i) => i.enabled);
  if (enabled.length === 0) {
    throw new Error(
      `stackmap: no enabled indexes configured. Add one to ${configCandidates().at(-1)} — see config.example.json.`,
    );
  }
  const wanted = name ?? config.defaultIndex;
  if (!wanted) {
    if (enabled.length === 1) return enabled[0]!;
    throw new Error(
      `stackmap: multiple indexes configured (${enabled.map((i) => i.name).join(", ")}). ` +
        `Pass "scope", or set "defaultIndex" in the config.`,
    );
  }
  const hit = enabled.find((i) => i.name === wanted);
  if (!hit) throw new Error(unusableName(config, wanted));
  return hit;
}

/**
 * The projects a query searches, in the order given. Omitted: the one selectIndex picks. Otherwise
 * a non-empty list of distinct names of loaded, enabled projects.
 */
export function selectScope(config: Config, scope: unknown): IndexConfig[] {
  if (scope === undefined) return [selectIndex(config)];
  if (!Array.isArray(scope) || scope.length === 0 || scope.some((s) => typeof s !== "string" || s === "")) {
    throw new Error('stackmap: "scope" must be a non-empty list of project names.');
  }
  const seen = new Set<string>();
  for (const name of scope as string[]) {
    if (seen.has(name)) throw new Error(`stackmap: "scope" lists "${name}" more than once.`);
    seen.add(name);
  }
  return (scope as string[]).map((name) => selectIndex(config, name));
}

/**
 * Append a project to the config file, editing its JSON as written, so sections this module doesn't
 * model (`guard`, `houseRules`) and every other entry are kept exactly. The file is the one
 * loadConfig reads, or the first resolution candidate when none exists yet. The entry must be valid
 * on its own, and its name must not be used by any entry already in the file, valid or not.
 */
export function addIndex(entry: unknown): { configPath: string; created: boolean; added: string } {
  const one = IndexConfigSchema.safeParse(entry);
  if (!one.success) throw new Error(`stackmap_add_index: the index is invalid: ${issueList(one.error.issues)}`);
  const contradicted = entryContradictions(one.data);
  if (contradicted.length) throw new Error(`stackmap_add_index: the index is invalid: ${contradicted.join("; ")}`);
  const target = configCandidates().find((c) => existsSync(c)) ?? configCandidates()[0]!;
  const created = !existsSync(target);
  let raw: Record<string, unknown> = {};
  if (!created) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(target, "utf8"));
    } catch (err) {
      throw new Error(`stackmap_add_index: config at ${target} is not valid JSON — ${(err as Error).message}; not changed.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`stackmap_add_index: config at ${target} is not a JSON object; not changed.`);
    raw = parsed as Record<string, unknown>;
  }
  if (raw.indexes !== undefined && !Array.isArray(raw.indexes)) throw new Error(`stackmap_add_index: "indexes" in ${target} is not a list; not changed.`);
  const entries = (raw.indexes as unknown[] | undefined) ?? [];
  const taken = entries.some((e) => e && typeof e === "object" && (e as { name?: unknown }).name === one.data.name);
  if (taken) throw new Error(`stackmap_add_index: ${target} already has an index named "${one.data.name}"; not changed.`);
  raw.indexes = [...entries, entry];
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(raw, null, 2)}\n`);
  return { configPath: target, created, added: one.data.name };
}

/** Caveats every query carries while the config has duplicate index names. */
export function duplicateCaveats(config: Config): string[] {
  return config.indexErrors.filter((e) => e.kind === "duplicate").map((e) => `config: ${e.message}`);
}
