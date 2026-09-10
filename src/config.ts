import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, isAbsolute } from "node:path";
import { z } from "zod";

/** Expand a leading `~` and make the path absolute. */
export function expandPath(p: string): string {
  let out = p;
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  return isAbsolute(out) ? out : resolve(out);
}

export const IndexConfigSchema = z.object({
  /** Short handle used to select this index in tool calls. */
  name: z.string().min(1),
  /** Repo root. `~` is expanded. */
  root: z.string().min(1),
  /** Which stack adapter to use. `auto` detects from marker files. */
  adapter: z.enum(["auto", "laravel", "phoenix", "node"]).default("auto"),
  /** Directories scanned for source. Adapter supplies defaults when omitted. */
  include: z.array(z.string()).optional(),
  /** Directories never scanned, merged with adapter + global defaults. */
  exclude: z.array(z.string()).optional(),
  /** Free-form per-adapter settings. */
  options: z.record(z.unknown()).default({}),
  /** Set false to keep the entry but skip it at load time. */
  enabled: z.boolean().default(true),
});
export type IndexConfig = z.infer<typeof IndexConfigSchema>;

export const ConfigSchema = z.object({
  indexes: z.array(IndexConfigSchema).default([]),
  /** Index used when a tool call omits `index` and more than one is configured. */
  defaultIndex: z.string().optional(),
  /** Where cross-session notes live. Plain markdown files, git-friendly. */
  notesDir: z.string().default("~/.config/stackmap/notes"),
  /** Applied to every index in addition to its own excludes. */
  globalExclude: z
    .array(z.string())
    .default(["vendor", "node_modules", "_build", "deps", ".git", "storage", "dist", "build"]),
});
export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  config: Config;
  /** Absolute path the config was read from, or null when defaults were used. */
  path: string | null;
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
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
      throw new Error(`stackmap: config at ${candidate} is invalid:\n${issues}`);
    }
    return { config: parsed.data, path: candidate };
  }
  return { config: ConfigSchema.parse({}), path: null };
}

/** Pick an index by name, falling back to defaultIndex, then to a lone entry. */
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
        `Pass "index", or set "defaultIndex" in the config.`,
    );
  }
  const hit = enabled.find((i) => i.name === wanted);
  if (!hit) {
    throw new Error(`stackmap: no enabled index named "${wanted}". Known: ${enabled.map((i) => i.name).join(", ") || "(none)"}`);
  }
  return hit;
}
