import { existsSync } from "node:fs";
import { join } from "node:path";
import { expandPath, type Config, type IndexConfig } from "../config.js";
import { laravelFactory } from "./laravel.js";
import type { AdapterFactory, AdapterId, StackAdapter } from "./types.js";

/** Implemented adapters. Phoenix and node are declared below but not built yet. */
const FACTORIES: AdapterFactory[] = [laravelFactory];

/** Stacks we can detect but cannot serve yet — detected so the error message is useful. */
const PLANNED: Array<{ id: AdapterId; markers: string[] }> = [
  { id: "phoenix", markers: ["mix.exs"] },
  { id: "node", markers: ["package.json"] },
];

export function detectAdapter(root: string): AdapterId | null {
  if (existsSync(join(root, "artisan"))) return "laravel";
  for (const p of PLANNED) {
    if (p.markers.some((m) => existsSync(join(root, m)))) return p.id;
  }
  return null;
}

const cache = new Map<string, StackAdapter>();

export function getAdapter(config: Config, cfg: IndexConfig): StackAdapter {
  const cached = cache.get(cfg.name);
  if (cached) return cached;

  const root = expandPath(cfg.root);
  if (!existsSync(root)) {
    throw new Error(`stackmap: index "${cfg.name}" points at ${root}, which does not exist.`);
  }

  const wanted = cfg.adapter === "auto" ? detectAdapter(root) : cfg.adapter;
  if (!wanted) {
    throw new Error(
      `stackmap: could not detect a stack at ${root}. Set "adapter" explicitly on index "${cfg.name}".`,
    );
  }
  const factory = FACTORIES.find((f) => f.id === wanted);
  if (!factory) {
    throw new Error(
      `stackmap: adapter "${wanted}" is not implemented yet (index "${cfg.name}"). ` +
        `Implemented: ${FACTORIES.map((f) => f.id).join(", ")}.`,
    );
  }
  const adapter = factory.create(cfg, root, config.globalExclude);
  cache.set(cfg.name, adapter);
  return adapter;
}

export function clearAdapterCache() {
  cache.clear();
}
