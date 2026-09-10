import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Recursively list files under `dirs` (repo-relative), skipping excluded directory names. */
export function walkFiles(root: string, dirs: string[], exclude: string[], ext: string): string[] {
  const skip = new Set(exclude);
  const out: string[] = [];
  const visit = (abs: string) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip rather than fail the whole walk
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const child = join(abs, e.name);
      if (e.isDirectory()) visit(child);
      else if (e.isFile() && e.name.endsWith(ext)) out.push(relative(root, child).split(sep).join("/"));
    }
  };
  for (const d of dirs) {
    const abs = join(root, d);
    try {
      if (statSync(abs).isDirectory()) visit(abs);
    } catch {
      // configured dir doesn't exist — ignore, stats() reports the empty result
    }
  }
  return out;
}
