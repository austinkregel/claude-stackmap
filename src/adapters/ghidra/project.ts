import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Reading a Ghidra project directory, for one purpose: telling a fresh export from a stale one.
 *
 * Saving a program writes the next `db.<N>.gbf` in that program's database folder, while opening a
 * project read-only — which is what producing an export does — leaves the `.gbf` files alone but does
 * rewrite the project's index files. So the fingerprint is the program's own newest `.gbf`, never a
 * timestamp taken across the project (user decision, after both were measured).
 *
 * The folder is found by the program's file id in `idata/~index.dat`, whose entry lines read
 * `<id>:<name>:<fileID>`. `programDatabase` in ghidra_scripts/StackmapExport.java does the same lookup
 * when it writes the export; change both together.
 */
export interface ProgramDatabase {
  file_id: string;
  folder: string;
  file: string;
  version: number;
  size: number;
  mtime_ms: number;
}

export type DatabaseLookup = { found: true; database: ProgramDatabase } | { found: false; reason: string };

/** The program database the project holds now, or why it can't be read. */
export function readProgramDatabase(projectLocation: string, projectName: string, fileId: string): DatabaseLookup {
  const idata = join(projectLocation, `${projectName}.rep`, "idata");
  const index = join(idata, "~index.dat");
  if (!existsSync(index)) return { found: false, reason: `${index} is missing, so the project's programs can't be listed` };
  let id: string | null = null;
  let lines: string[];
  try {
    lines = readFileSync(index, "utf8").split("\n");
  } catch (err) {
    return { found: false, reason: `${index} can't be read: ${(err as Error).message}` };
  }
  for (const line of lines) {
    const parts = line.trim().split(":");
    if (parts.length === 3 && parts[2] === fileId) {
      id = parts[0]!;
      break;
    }
  }
  if (id === null) return { found: false, reason: `no program with file id ${fileId} in ${index}; it may have been deleted from the project` };
  const folder = `${id.slice(0, 2)}/~${id}.db`;
  const dir = join(idata, id.slice(0, 2), `~${id}.db`);
  if (!existsSync(dir)) return { found: false, reason: `the program's database folder ${dir} is missing` };
  let newest: ProgramDatabase | null = null;
  for (const name of readdirSync(dir)) {
    const m = /^db\.(\d+)\.gbf$/.exec(name);
    if (!m) continue;
    const version = Number(m[1]);
    if (newest && newest.version >= version) continue;
    const stat = statSync(join(dir, name));
    newest = { file_id: fileId, folder, file: name, version, size: stat.size, mtime_ms: stat.mtimeMs };
  }
  if (!newest) return { found: false, reason: `no db.<N>.gbf file in ${dir}` };
  return { found: true, database: newest };
}

export type Freshness =
  | { state: "fresh" }
  | { state: "stale"; reason: string; exported: ProgramDatabase; now: ProgramDatabase }
  | { state: "unknown"; reason: string };

/**
 * Compare the database the export recorded with the one the project holds now. `unknown` means the
 * project can't be read at all, which is reported rather than treated as either fresh or stale.
 */
export function freshness(exported: ProgramDatabase, projectLocation: string, projectName: string): Freshness {
  const lookup = readProgramDatabase(projectLocation, projectName, exported.file_id);
  if (!lookup.found) return { state: "unknown", reason: lookup.reason };
  const now = lookup.database;
  if (now.file === exported.file && now.size === exported.size && now.mtime_ms === exported.mtime_ms) return { state: "fresh" };
  const changes = [
    now.file !== exported.file ? `${exported.file} -> ${now.file}` : null,
    now.size !== exported.size ? `${exported.size} -> ${now.size} bytes` : null,
    now.mtime_ms !== exported.mtime_ms ? `modified ${new Date(exported.mtime_ms).toISOString()} -> ${new Date(now.mtime_ms).toISOString()}` : null,
  ].filter(Boolean);
  return {
    state: "stale",
    reason: `the program was saved in Ghidra since this export was written (${changes.join(", ")}). Re-run ghidra_scripts/StackmapExport.java to refresh it.`,
    exported,
    now,
  };
}
