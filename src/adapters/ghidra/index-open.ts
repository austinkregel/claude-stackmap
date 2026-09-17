import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { buildIndex, INDEX_VERSION } from "./index-build.js";
import { freshness, type Freshness, type ProgramDatabase } from "./project.js";

/**
 * Open the SQLite index of an export, building it when it is missing, was built by another stackmap
 * version, or no longer matches the export file. The export's own size and mtime are recorded in the
 * index, so an export that changed on disk is reindexed rather than answered from stale rows.
 */
export interface OpenIndex {
  db: DatabaseSync;
  indexPath: string;
  /** Why the index was built, or null when the existing one was used as is. */
  built: string | null;
  buildSeconds: number | null;
  meta: Map<string, unknown>;
}

export const indexPathFor = (exportPath: string) => `${exportPath}.sqlite`;

export async function openIndex(exportPath: string): Promise<OpenIndex> {
  if (!existsSync(exportPath)) throw new Error(`stackmap: the Ghidra export ${exportPath} is missing`);
  const indexPath = indexPathFor(exportPath);
  const stat = statSync(exportPath);
  let reason: string | null = null;
  if (!existsSync(indexPath)) reason = "no index yet";
  else {
    const existing = new DatabaseSync(indexPath, { readOnly: true });
    try {
      const meta = readMeta(existing);
      const version = Number(meta.get("index_version"));
      if (version !== INDEX_VERSION) reason = `the index was built for stackmap index version ${meta.get("index_version")}, this stackmap uses ${INDEX_VERSION}`;
      else if (Number(meta.get("export_mtime_ms")) !== stat.mtimeMs || Number(meta.get("export_size")) !== stat.size) reason = "the export changed on disk";
    } finally {
      existing.close();
    }
  }

  let buildSeconds: number | null = null;
  if (reason !== null) buildSeconds = (await buildIndex(exportPath, indexPath)).seconds;
  const db = new DatabaseSync(indexPath, { readOnly: true });
  return { db, indexPath, built: reason, buildSeconds, meta: readMeta(db) };
}

/** Meta rows, each value the JSON the builder stored (index_version and the export stats are plain text). */
function readMeta(db: DatabaseSync): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const row of db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]) {
    try {
      out.set(row.key, JSON.parse(row.value));
    } catch {
      out.set(row.key, row.value);
    }
  }
  return out;
}

/** The export's own view of the program database, for the staleness check. */
export function exportedDatabase(meta: Map<string, unknown>, exportPath: string): ProgramDatabase {
  const value = meta.get("program_database");
  if (!value || typeof value !== "object") throw new Error(`${exportPath}: no program_database section, so staleness can't be checked`);
  const db = value as Partial<ProgramDatabase>;
  for (const key of ["file_id", "folder", "file"] as const) {
    if (typeof db[key] !== "string") throw new Error(`${exportPath}: program_database.${key} is not a string`);
  }
  for (const key of ["version", "size", "mtime_ms"] as const) {
    if (typeof db[key] !== "number") throw new Error(`${exportPath}: program_database.${key} is not a number`);
  }
  return db as ProgramDatabase;
}

/** Whether the project has been saved since this export was written. */
export function exportFreshness(meta: Map<string, unknown>, exportPath: string): Freshness {
  const project = meta.get("project") as { location?: unknown; name?: unknown } | undefined;
  if (!project || typeof project.location !== "string" || typeof project.name !== "string") {
    return { state: "unknown", reason: `${exportPath}: no project location and name, so its Ghidra project can't be checked` };
  }
  return freshness(exportedDatabase(meta, exportPath), project.location, project.name);
}
