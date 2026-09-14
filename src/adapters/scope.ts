import type { Config, IndexConfig } from "../config.js";
import { getAdapter } from "./registry.js";
import type { IndexedAdapter } from "./types.js";

/** One project's answer, or why it has none. A project that can't answer is reported, never dropped. */
export type ProjectOutcome<T> = { index: string; value: T } | { index: string; error: string };

/** Run `query` against every project in scope, in scope order, each failure kept as that project's result. */
export function acrossScope<T>(config: Config, scope: IndexConfig[], query: (adapter: IndexedAdapter, idx: IndexConfig) => T): ProjectOutcome<T>[] {
  return scope.map((idx) => {
    try {
      return { index: idx.name, value: query(getAdapter(config, idx), idx) };
    } catch (err) {
      return { index: idx.name, error: (err as Error).message };
    }
  });
}
