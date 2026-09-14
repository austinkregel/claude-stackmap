import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { expandPath, type Config, type IndexConfig } from "../config.js";
import { laravelFactory } from "./laravel.js";
import type { AdapterFactory, AdapterId, Capability, IndexedAdapter, IndexRoot } from "./types.js";

/** Implemented adapters, in detection order: the first whose `detect` matches wins. */
const FACTORIES: AdapterFactory[] = [laravelFactory];

/**
 * Stacks detected by marker file but not served yet, checked after every implemented adapter, so the
 * error names what was found. Their manifest-based detection arrives with their adapters.
 */
const PLANNED: Array<{ id: AdapterId; markers: string[] }> = [
  { id: "phoenix", markers: ["mix.exs"] },
  { id: "node", markers: ["package.json"] },
];

export interface DetectedStack {
  adapter: AdapterId | null;
  /** What detection had to say along the way, e.g. a manifest it couldn't read. */
  notes: string[];
}

/** The first stack whose check matches `root`, in declared order: implemented adapters, then planned markers. */
export function detectAdapter(root: string): DetectedStack {
  const notes: string[] = [];
  for (const factory of FACTORIES) {
    const d = factory.detect(root);
    notes.push(...d.notes);
    if (d.matched) return { adapter: factory.id, notes };
  }
  for (const p of PLANNED) {
    if (p.markers.some((m) => existsSync(join(root, m)))) return { adapter: p.id, notes };
  }
  return { adapter: null, notes };
}

/** The project's roots, main root first, with real paths. Any root that isn't a usable directory is an error. */
export function resolveRoots(cfg: IndexConfig): IndexRoot[] {
  const one = (kind: IndexRoot["kind"], configured: string, include: string[] | null, exclude: string[] | null): IndexRoot => {
    const abs = expandPath(configured);
    if (!existsSync(abs)) {
      throw new Error(
        kind === "root"
          ? `stackmap: index "${cfg.name}" points at ${abs}, which does not exist.`
          : `stackmap: index "${cfg.name}" has an alias ${configured} (${abs}), which does not exist.`,
      );
    }
    if (!statSync(abs).isDirectory()) {
      throw new Error(`stackmap: index "${cfg.name}" ${kind === "root" ? "root" : `alias ${configured}`} (${abs}) is not a directory.`);
    }
    return { kind, configured, path: realpathSync(abs), include, exclude };
  };
  const roots = [one("root", cfg.root, null, null), ...cfg.aliases.map((a) => one("alias", a.path, a.include ?? null, a.exclude ?? null))];
  const seen = new Map<string, string>();
  for (const r of roots) {
    const earlier = seen.get(r.path);
    if (earlier !== undefined) {
      throw new Error(`stackmap: index "${cfg.name}" lists the same directory twice: ${earlier} and ${r.configured} both resolve to ${r.path}.`);
    }
    seen.set(r.path, r.configured);
  }
  return roots;
}

const cache = new Map<string, { fingerprint: string; adapter: IndexedAdapter }>();

/**
 * The adapter for an index, built once and reused until anything it was built from changes: its
 * roots' real paths and rules, adapter, include, exclude, options, or the global excludes.
 */
export function getAdapter(config: Config, cfg: IndexConfig): IndexedAdapter {
  const roots = resolveRoots(cfg);
  const fingerprint = JSON.stringify({ roots, adapter: cfg.adapter, include: cfg.include ?? null, exclude: cfg.exclude ?? null, options: cfg.options, globalExclude: config.globalExclude });
  const cached = cache.get(cfg.name);
  if (cached && cached.fingerprint === fingerprint) return cached.adapter;

  const main = roots[0]!;
  let wanted: AdapterId;
  if (cfg.adapter === "auto") {
    const detected = detectAdapter(main.path);
    if (!detected.adapter) {
      throw new Error(
        `stackmap: could not detect a stack at ${main.path}${detected.notes.length ? ` (${detected.notes.join("; ")})` : ""}. ` +
          `Set "adapter" explicitly on index "${cfg.name}".`,
      );
    }
    wanted = detected.adapter;
  } else {
    wanted = cfg.adapter;
  }
  const factory = FACTORIES.find((f) => f.id === wanted);
  if (!factory) {
    throw new Error(
      `stackmap: adapter "${wanted}" is not implemented yet (index "${cfg.name}"). ` +
        `Implemented: ${FACTORIES.map((f) => f.id).join(", ")}.`,
    );
  }
  const adapter = factory.create(cfg, roots, config.globalExclude);
  cache.set(cfg.name, { fingerprint, adapter });
  return adapter;
}

/** The capability, or an error naming the index, its adapter, and what it lacks. */
export function requireCapability<C extends Capability>(adapter: IndexedAdapter, capability: C, indexName: string, tool: string): NonNullable<IndexedAdapter[C]> {
  const provided = adapter[capability];
  if (provided === null) {
    throw new Error(`stackmap: ${tool} needs the "${capability}" capability, which index "${indexName}" (adapter "${adapter.id}") does not provide.`);
  }
  return provided as NonNullable<IndexedAdapter[C]>;
}

export function clearAdapterCache() {
  cache.clear();
}
