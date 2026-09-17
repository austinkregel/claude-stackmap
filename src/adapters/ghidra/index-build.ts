import { DatabaseSync, type StatementSync } from "node:sqlite";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { FORMAT_VERSION, ROW_SECTIONS, VALUE_KEYS, type RowSection } from "./format.js";
import { readExport } from "./stream.js";

/**
 * A Ghidra export is JSON (one file per program, written beside its .gpr) and can be hundreds of
 * megabytes; parsing one whole costs over a gigabyte of memory. So stackmap indexes it into SQLite once
 * and queries that (user decision). The index is built by streaming the export, so building it costs
 * one element of memory rather than the whole file.
 *
 * Bump INDEX_VERSION whenever the tables change, so an index built by an older stackmap is rebuilt
 * instead of queried with the wrong shape.
 */
export const INDEX_VERSION = 1;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE functions (
  entry TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, signature TEXT,
  calling_convention TEXT, noreturn INTEGER NOT NULL, thunk_of TEXT, source TEXT,
  computed_calls_unresolved INTEGER NOT NULL, decompile TEXT NOT NULL, decompile_error TEXT, pseudocode TEXT
);
CREATE TABLE function_bodies (entry TEXT NOT NULL, lo TEXT NOT NULL, hi TEXT NOT NULL);
CREATE TABLE function_refs (entry TEXT NOT NULL, from_addr TEXT NOT NULL, from_fn TEXT, ref_type TEXT NOT NULL, is_call INTEGER NOT NULL);
CREATE TABLE function_callees (entry TEXT NOT NULL, callee TEXT NOT NULL);
CREATE TABLE instructions (addr TEXT PRIMARY KEY, fn TEXT, text TEXT NOT NULL);
CREATE TABLE instruction_scalars (addr TEXT NOT NULL, scalar TEXT NOT NULL);
CREATE TABLE instruction_refs (addr TEXT NOT NULL, to_addr TEXT NOT NULL, ref_type TEXT NOT NULL);
CREATE TABLE strings (address TEXT PRIMARY KEY, value TEXT, length INTEGER NOT NULL, type TEXT, defined INTEGER NOT NULL);
CREATE TABLE pointer_hits (address TEXT NOT NULL, target TEXT NOT NULL, width INTEGER NOT NULL);
CREATE TABLE types (
  path TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
  zero_length INTEGER NOT NULL, alignment INTEGER, packing_enabled INTEGER, explicit_packing INTEGER,
  description TEXT, source_archive TEXT
);
CREATE TABLE type_fields (
  path TEXT NOT NULL, ordinal INTEGER NOT NULL, name TEXT, offset INTEGER NOT NULL, size INTEGER NOT NULL,
  type TEXT, type_path TEXT, bit_offset INTEGER, bit_size INTEGER, comment TEXT
);
CREATE TABLE memory_blocks (
  name TEXT NOT NULL, start_addr TEXT NOT NULL, end_addr TEXT NOT NULL, size INTEGER NOT NULL,
  read INTEGER NOT NULL, write INTEGER NOT NULL, execute INTEGER NOT NULL, initialized INTEGER NOT NULL, overlay INTEGER NOT NULL
);
`;

const INDEXES = `
CREATE INDEX functions_name ON functions (name);
CREATE INDEX function_bodies_entry ON function_bodies (entry);
CREATE INDEX function_refs_entry ON function_refs (entry);
CREATE INDEX function_refs_from ON function_refs (from_addr);
CREATE INDEX function_callees_entry ON function_callees (entry);
CREATE INDEX instructions_fn ON instructions (fn);
CREATE INDEX instruction_scalars_scalar ON instruction_scalars (scalar);
CREATE INDEX instruction_scalars_addr ON instruction_scalars (addr);
CREATE INDEX instruction_refs_to ON instruction_refs (to_addr);
CREATE INDEX instruction_refs_addr ON instruction_refs (addr);
CREATE INDEX strings_value ON strings (value);
CREATE INDEX pointer_hits_target ON pointer_hits (target);
CREATE INDEX pointer_hits_address ON pointer_hits (address);
CREATE INDEX types_name ON types (name);
CREATE INDEX type_fields_path ON type_fields (path);
`;

/** Every field is checked as it is read: a shape the export shouldn't have is an error naming the row. */
const bool = (v: unknown, where: string): number => {
  if (typeof v !== "boolean") throw new Error(`${where}: expected true or false, got ${JSON.stringify(v)}`);
  return v ? 1 : 0;
};
const int = (v: unknown, where: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${where}: expected an integer, got ${JSON.stringify(v)}`);
  return v;
};
const str = (v: unknown, where: string): string => {
  if (typeof v !== "string") throw new Error(`${where}: expected a string, got ${JSON.stringify(v)}`);
  return v;
};
const maybeStr = (v: unknown, where: string): string | null => (v === null || v === undefined ? null : str(v, where));
const maybeInt = (v: unknown, where: string): number | null => (v === null || v === undefined ? null : int(v, where));
const obj = (v: unknown, where: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${where}: expected an object, got ${JSON.stringify(v)}`);
  return v as Record<string, unknown>;
};
const arr = (v: unknown, where: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`${where}: expected an array, got ${JSON.stringify(v)}`);
  return v;
};

interface Inserts {
  function: StatementSync;
  body: StatementSync;
  ref: StatementSync;
  callee: StatementSync;
  instruction: StatementSync;
  scalar: StatementSync;
  insRef: StatementSync;
  string: StatementSync;
  pointer: StatementSync;
  type: StatementSync;
  field: StatementSync;
  block: StatementSync;
  meta: StatementSync;
}

/** Build the index for `exportPath` at `indexPath`, replacing whatever is there. */
export async function buildIndex(exportPath: string, indexPath: string): Promise<{ rows: Record<string, number>; seconds: number }> {
  const started = Date.now();
  const stat = statSync(exportPath);
  const tmp = `${indexPath}.tmp-${process.pid}`;
  for (const leftover of [tmp, `${tmp}-journal`]) if (existsSync(leftover)) rmSync(leftover);

  const db = new DatabaseSync(tmp);
  const rows: Record<string, number> = {};
  const values = new Map<string, unknown>();
  try {
    db.exec("PRAGMA journal_mode = OFF");
    db.exec(SCHEMA);
    const insert: Inserts = {
      function: db.prepare("INSERT INTO functions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"),
      body: db.prepare("INSERT INTO function_bodies VALUES (?,?,?)"),
      ref: db.prepare("INSERT INTO function_refs VALUES (?,?,?,?,?)"),
      callee: db.prepare("INSERT INTO function_callees VALUES (?,?)"),
      instruction: db.prepare("INSERT INTO instructions VALUES (?,?,?)"),
      scalar: db.prepare("INSERT INTO instruction_scalars VALUES (?,?)"),
      insRef: db.prepare("INSERT INTO instruction_refs VALUES (?,?,?)"),
      string: db.prepare("INSERT INTO strings VALUES (?,?,?,?,?)"),
      pointer: db.prepare("INSERT INTO pointer_hits VALUES (?,?,?)"),
      type: db.prepare("INSERT INTO types VALUES (?,?,?,?,?,?,?,?,?,?)"),
      field: db.prepare("INSERT INTO type_fields VALUES (?,?,?,?,?,?,?,?,?,?)"),
      block: db.prepare("INSERT INTO memory_blocks VALUES (?,?,?,?,?,?,?,?,?)"),
      meta: db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)"),
    };

    db.exec("BEGIN");
    await readExport(exportPath, {
      value: (key, value) => {
        if (!(VALUE_KEYS as readonly string[]).includes(key)) {
          throw new Error(`${exportPath}: unknown top-level key "${key}"; this stackmap reads format ${FORMAT_VERSION}`);
        }
        if (key === "format_version" && value !== FORMAT_VERSION) {
          throw new Error(
            `${exportPath}: format_version is ${JSON.stringify(value)}, but this stackmap reads ${FORMAT_VERSION}. ` +
              `Re-run ghidra_scripts/StackmapExport.java from this version of stackmap.`,
          );
        }
        values.set(key, value);
      },
      element: (key, index, value) => {
        if (!(ROW_SECTIONS as readonly string[]).includes(key)) {
          throw new Error(`${exportPath}: unknown array section "${key}"; this stackmap reads format ${FORMAT_VERSION}`);
        }
        rows[key] = (rows[key] ?? 0) + 1;
        addRow(insert, key as RowSection, value, `${exportPath}: ${key}[${index}]`);
      },
    });
    db.exec("COMMIT");
    db.exec(INDEXES);

    if (!values.has("format_version")) throw new Error(`${exportPath}: no format_version, so it is not a stackmap Ghidra export`);
    for (const [key, value] of values) insert.meta.run(key, JSON.stringify(value));
    insert.meta.run("index_version", String(INDEX_VERSION));
    insert.meta.run("export_path", exportPath);
    insert.meta.run("export_mtime_ms", String(stat.mtimeMs));
    insert.meta.run("export_size", String(stat.size));
    insert.meta.run("rows", JSON.stringify(rows));
  } catch (err) {
    db.close();
    rmSync(tmp, { force: true });
    throw err;
  }
  db.close();
  renameSync(tmp, indexPath);
  return { rows, seconds: (Date.now() - started) / 1000 };
}

function addRow(insert: Inserts, section: RowSection, row: unknown, where: string): void {
  switch (section) {
    case "functions": {
      const r = obj(row, where);
      const entry = str(r.entry, `${where}.entry`);
      insert.function.run(
        entry,
        str(r.name, `${where}.name`),
        int(r.size, `${where}.size`),
        maybeStr(r.signature, `${where}.signature`),
        maybeStr(r.calling_convention, `${where}.calling_convention`),
        bool(r.noreturn, `${where}.noreturn`),
        maybeStr(r.thunk_of, `${where}.thunk_of`),
        maybeStr(r.source, `${where}.source`),
        int(r.computed_calls_unresolved, `${where}.computed_calls_unresolved`),
        str(r.decompile, `${where}.decompile`),
        maybeStr(r.decompile_error, `${where}.decompile_error`),
        maybeStr(r.pseudocode, `${where}.pseudocode`),
      );
      for (const range of arr(r.body, `${where}.body`)) {
        const [lo, hi] = arr(range, `${where}.body[]`);
        insert.body.run(entry, str(lo, `${where}.body[][0]`), str(hi, `${where}.body[][1]`));
      }
      for (const ref of arr(r.refs_to, `${where}.refs_to`)) {
        const [from, fromFn, type, isCall] = arr(ref, `${where}.refs_to[]`);
        insert.ref.run(
          entry,
          str(from, `${where}.refs_to[][0]`),
          maybeStr(fromFn, `${where}.refs_to[][1]`),
          str(type, `${where}.refs_to[][2]`),
          bool(isCall, `${where}.refs_to[][3]`),
        );
      }
      for (const callee of arr(r.callees, `${where}.callees`)) insert.callee.run(entry, str(callee, `${where}.callees[]`));
      return;
    }
    case "instructions": {
      const [addr, fn, text, scalars, refs] = arr(row, where);
      const at = str(addr, `${where}[0]`);
      insert.instruction.run(at, maybeStr(fn, `${where}[1]`), str(text, `${where}[2]`));
      for (const s of arr(scalars, `${where}[3]`)) insert.scalar.run(at, str(s, `${where}[3][]`));
      for (const ref of arr(refs, `${where}[4]`)) {
        const [to, type] = arr(ref, `${where}[4][]`);
        insert.insRef.run(at, str(to, `${where}[4][][0]`), str(type, `${where}[4][][1]`));
      }
      return;
    }
    case "strings": {
      const r = obj(row, where);
      insert.string.run(
        str(r.address, `${where}.address`),
        maybeStr(r.value, `${where}.value`),
        int(r.length, `${where}.length`),
        maybeStr(r.type, `${where}.type`),
        bool(r.defined, `${where}.defined`),
      );
      return;
    }
    case "pointer_hits": {
      const r = obj(row, where);
      insert.pointer.run(str(r.address, `${where}.address`), str(r.target, `${where}.target`), int(r.width, `${where}.width`));
      return;
    }
    case "types": {
      const r = obj(row, where);
      const path = str(r.path, `${where}.path`);
      insert.type.run(
        path,
        str(r.name, `${where}.name`),
        str(r.kind, `${where}.kind`),
        int(r.size, `${where}.size`),
        bool(r.zero_length, `${where}.zero_length`),
        maybeInt(r.alignment, `${where}.alignment`),
        bool(r.packing_enabled, `${where}.packing_enabled`),
        maybeInt(r.explicit_packing, `${where}.explicit_packing`),
        maybeStr(r.description, `${where}.description`),
        maybeStr(r.source_archive, `${where}.source_archive`),
      );
      let ordinal = 0;
      for (const field of arr(r.fields, `${where}.fields`)) {
        const f = obj(field, `${where}.fields[]`);
        insert.field.run(
          path,
          ordinal++,
          maybeStr(f.name, `${where}.fields[].name`),
          int(f.offset, `${where}.fields[].offset`),
          int(f.size, `${where}.fields[].size`),
          maybeStr(f.type, `${where}.fields[].type`),
          maybeStr(f.type_path, `${where}.fields[].type_path`),
          maybeInt(f.bit_offset, `${where}.fields[].bit_offset`),
          maybeInt(f.bit_size, `${where}.fields[].bit_size`),
          maybeStr(f.comment, `${where}.fields[].comment`),
        );
      }
      return;
    }
    case "memory_blocks": {
      const r = obj(row, where);
      insert.block.run(
        str(r.name, `${where}.name`),
        str(r.start, `${where}.start`),
        str(r.end, `${where}.end`),
        int(r.size, `${where}.size`),
        bool(r.read, `${where}.read`),
        bool(r.write, `${where}.write`),
        bool(r.execute, `${where}.execute`),
        bool(r.initialized, `${where}.initialized`),
        bool(r.overlay, `${where}.overlay`),
      );
      return;
    }
  }
}
