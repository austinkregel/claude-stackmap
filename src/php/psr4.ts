import { readFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Psr4Map {
  /** Namespace prefix (with trailing backslash) -> one or more source dirs, relative to repo root. */
  prefixes: Array<{ prefix: string; dirs: string[] }>;
}

/** Read PSR-4 roots out of composer.json (`autoload` + `autoload-dev`). */
export function readPsr4(repoRoot: string): Psr4Map {
  const composer = join(repoRoot, "composer.json");
  if (!existsSync(composer)) return { prefixes: [] };
  let json: any;
  try {
    json = JSON.parse(readFileSync(composer, "utf8"));
  } catch {
    return { prefixes: [] };
  }
  const merged: Record<string, string[]> = {};
  for (const key of ["autoload", "autoload-dev"]) {
    const psr4 = json?.[key]?.["psr-4"];
    if (!psr4 || typeof psr4 !== "object") continue;
    for (const [prefix, dirs] of Object.entries(psr4)) {
      const list = Array.isArray(dirs) ? (dirs as string[]) : [dirs as string];
      merged[prefix] = [...(merged[prefix] ?? []), ...list.map((d) => d.replace(/\/+$/, ""))];
    }
  }
  // Longest prefix first so `App\Domain\` wins over `App\`.
  const prefixes = Object.entries(merged)
    .map(([prefix, dirs]) => ({ prefix, dirs }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return { prefixes };
}

/** Fully-qualified class name -> candidate file paths (relative to repo root). */
export function symbolToFiles(map: Psr4Map, fqcn: string): string[] {
  const clean = fqcn.replace(/^\\+/, "");
  for (const { prefix, dirs } of map.prefixes) {
    if (!clean.startsWith(prefix)) continue;
    const rest = clean.slice(prefix.length).split("\\").join("/");
    return dirs.map((d) => (d ? `${d}/${rest}.php` : `${rest}.php`));
  }
  return [];
}

/** Inverse of symbolToFiles: a repo-relative .php path -> its FQCN, when PSR-4 covers it. */
export function fileToSymbol(map: Psr4Map, repoRoot: string, absPath: string): string | null {
  const rel = relative(repoRoot, absPath).split(sep).join("/");
  if (!rel.endsWith(".php")) return null;
  const noExt = rel.slice(0, -".php".length);
  let best: { prefix: string; dir: string } | null = null;
  for (const { prefix, dirs } of map.prefixes) {
    for (const dir of dirs) {
      const withSlash = dir ? `${dir}/` : "";
      if (!noExt.startsWith(withSlash)) continue;
      if (!best || withSlash.length > (best.dir ? best.dir.length + 1 : 0)) best = { prefix, dir };
    }
  }
  if (!best) return null;
  const withSlash = best.dir ? `${best.dir}/` : "";
  return best.prefix + noExt.slice(withSlash.length).split("/").join("\\");
}
