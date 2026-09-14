import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface WalkResult {
  /** Root-relative paths with `/` separators, sorted, so paging over them is stable. */
  files: string[];
  /** Configured directories that don't exist under the root. */
  missingDirs: string[];
  /** Directories that exist but could not be read. */
  unreadableDirs: string[];
  /** Configured directories not walked because an exclude entry matches them. */
  excludedDirs: string[];
}

/**
 * Recursively list files under `dirs` (root-relative). An `exclude` entry without a `/` is a
 * directory name skipped at any depth; one with a `/` is a root-relative path skipped with
 * everything under it. Nothing is dropped silently: a configured directory that is missing, or one
 * that can't be read, is returned for the caller to report.
 */
export function walkFiles(root: string, dirs: string[], exclude: string[], ext: string): WalkResult {
  const names = new Set(exclude.filter((e) => !e.includes("/")));
  const paths = exclude.filter((e) => e.includes("/")).map((e) => e.replace(/^\/+|\/+$/g, ""));
  const excludedPath = (rel: string) => paths.some((p) => rel === p || rel.startsWith(`${p}/`));
  const files: string[] = [];
  const unreadableDirs: string[] = [];
  const missingDirs: string[] = [];
  const excludedDirs: string[] = [];
  const toRel = (abs: string) => relative(root, abs).split(sep).join("/");

  const visit = (abs: string) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      unreadableDirs.push(toRel(abs) || ".");
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || names.has(e.name)) continue;
      const child = join(abs, e.name);
      const rel = toRel(child);
      if (excludedPath(rel)) continue;
      if (e.isDirectory()) visit(child);
      else if (e.isFile() && e.name.endsWith(ext)) files.push(rel);
    }
  };
  for (const d of dirs) {
    const abs = join(root, d);
    const rel = toRel(abs);
    // An exclude applies to configured directories too; a contradiction is reported, not resolved silently.
    if (rel.split("/").some((part) => names.has(part)) || excludedPath(rel)) {
      excludedDirs.push(d);
      continue;
    }
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) visit(abs);
    else missingDirs.push(d);
  }
  return { files: [...new Set(files)].sort(), missingDirs, unreadableDirs, excludedDirs };
}
