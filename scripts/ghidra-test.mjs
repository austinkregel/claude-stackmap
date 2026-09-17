#!/usr/bin/env node
/**
 * Ghidra adapter suite: the export reader, the SQLite index built from it, and the staleness check
 * against a Ghidra project. Every fixture is written here as JSON and a directory layout — no Ghidra,
 * and no real project. Needs `npm run build`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { FORMAT_VERSION, ROW_SECTIONS, VALUE_KEYS } = await import(pathToFileURL(join(root, "dist/adapters/ghidra/format.js")).href);
const { buildIndex, INDEX_VERSION } = await import(pathToFileURL(join(root, "dist/adapters/ghidra/index-build.js")).href);
const { openIndex, indexPathFor, exportFreshness, exportedDatabase } = await import(pathToFileURL(join(root, "dist/adapters/ghidra/index-open.js")).href);
const { readProgramDatabase, freshness } = await import(pathToFileURL(join(root, "dist/adapters/ghidra/project.js")).href);
const { readExport } = await import(pathToFileURL(join(root, "dist/adapters/ghidra/stream.js")).href);

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};
const rejects = async (fn, pattern) => {
  try {
    await fn();
    return { ok: false, detail: "did not throw" };
  } catch (err) {
    return { ok: pattern.test(err.message), detail: err.message.slice(0, 300) };
  }
};

const sandbox = mkdtempSync(join(tmpdir(), "stackmap-ghidra-"));

/** A Ghidra project on disk, as far as staleness cares: an index file and a program database folder. */
function project(name, { fileId = "abc123", id = "00000000", versions = [4] } = {}) {
  const location = join(sandbox, `${name}-project`);
  const rep = join(location, `${name}.rep`);
  const idata = join(rep, "idata");
  mkdirSync(idata, { recursive: true });
  writeFileSync(join(idata, "~index.dat"), `VERSION=1\n/\n  ${id}:${name}.exe:${fileId}\nNEXT-ID:1\nMD5:d41d8cd98f00b204e9800998ecf8427e\n`);
  const db = join(idata, id.slice(0, 2), `~${id}.db`);
  mkdirSync(db, { recursive: true });
  for (const v of versions) writeFileSync(join(db, `db.${v}.gbf`), `database version ${v}`);
  return { location: `${location}/`, name, dbDir: db, fileId };
}

/** The smallest complete export: one program, one function, one instruction, one string, one type. */
function exportObject(overrides = {}) {
  const proj = overrides.project ?? { location: "/tmp/p/", name: "p", gpr: "/tmp/p/p.gpr" };
  return {
    format_version: FORMAT_VERSION,
    exporter: { script: "StackmapExport", ghidra_version: "12.1.3", exported_at: "2026-09-17T00:00:00Z", decompile_timeout_seconds: 60 },
    project: proj,
    program_database: { file_id: "abc123", folder: "00/~00000000.db", file: "db.4.gbf", version: 4, size: 18, mtime_ms: 1700000000000 },
    program: {
      path: "/p.exe", name: "p.exe", executable_path: "C:/p.exe", executable_format: "Portable Executable (PE)",
      language: "x86:LE:32:default", compiler: "windows", image_base: "0x400000", pointer_size: 4, big_endian: false,
      info: { Analyzed: "true", "PDB Loaded": "true" },
    },
    memory_blocks: [{ name: ".text", start: "0x401000", end: "0x401fff", size: 4096, read: true, write: false, execute: true, initialized: true, overlay: false }],
    undefined_string_min_length: 4,
    strings: [
      { address: "0x402000", value: "VZ.WAD", length: 7, type: null, defined: false },
      { address: "0x402100", value: "hello", length: 6, type: "string", defined: true },
    ],
    pointer_scan: { widths: [4], blocks_scanned: [".data"] },
    pointer_hits: [{ address: "0x403000", target: "0x402000", width: 4 }],
    types: [{
      path: "/p.pdb/Header", name: "Header", kind: "struct", size: 8, zero_length: false, alignment: 4,
      packing_enabled: true, explicit_packing: -1, description: null, source_archive: "p.exe",
      fields: [
        { name: "magic", offset: 0, size: 4, type: "uint", type_path: "/uint", comment: null },
        { name: null, offset: 4, size: 4, type: "Inner", type_path: "/p.pdb/Header/Inner", comment: "anonymous union" },
      ],
    }],
    instructions: [
      ["0x401000", "0x401000", "PUSH EBP", [], []],
      ["0x401001", "0x401000", "MOV EAX,0x1a0", ["0x1a0"], [["0x402100", "READ"]]],
    ],
    functions: [{
      name: "FUN_00401000", entry: "0x401000", size: 16, body: [["0x401000", "0x40100f"]],
      signature: "undefined FUN_00401000()", calling_convention: "unknown", noreturn: false, thunk_of: null,
      source: "DEFAULT", refs_to: [["0x401500", "0x401400", "UNCONDITIONAL_CALL", true], ["0x404000", null, "DATA", false]],
      callees: ["0x401200"], computed_calls_unresolved: 1, decompile: "ok", pseudocode: "void FUN_00401000(void)\n{\n  return;\n}\n",
    }],
    counts: { functions: 1, function_bytes: 16, decompiled: 1, decompile_failed: 0, decompile_timeout: 0 },
    export_seconds: 1.5,
    ...overrides,
  };
}

const writeExport = (name, value) => {
  const path = join(sandbox, `${name}.json`);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 1));
  return path;
};

try {
  console.log("-- the export reader --");
  {
    const path = writeExport("stream", exportObject());
    const values = [];
    const elements = [];
    await readExport(path, { value: (k, v) => values.push([k, v]), element: (k, i, v) => elements.push([k, i, v]) });
    check("every top-level value is handed over once, in file order",
      values.map(([k]) => k).join() === "format_version,exporter,project,program_database,program,undefined_string_min_length,pointer_scan,counts,export_seconds",
      values.map(([k]) => k).join());
    check("every array section is handed over element by element",
      JSON.stringify(elements.reduce((acc, [k]) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {})) === '{"memory_blocks":1,"strings":2,"pointer_hits":1,"types":1,"instructions":2,"functions":1}',
      JSON.stringify(elements.map(([k, i]) => `${k}[${i}]`)));
    check("each key of the export is either a value key or a row section",
      [...new Set([...values.map(([k]) => k), ...elements.map(([k]) => k)])].every((k) => VALUE_KEYS.includes(k) || ROW_SECTIONS.includes(k)));

    // A function's pseudocode can be far larger than the read buffer, so an element must be able to
    // span chunks; this one is 4 MB with braces and quotes inside it.
    const big = exportObject();
    big.functions[0].pseudocode = `/* ${"x".repeat(2_000_000)} */\n{ "not': [a string] }\n${"y".repeat(2_000_000)}`;
    const bigPath = writeExport("big", big);
    let seen = null;
    await readExport(bigPath, { value: () => {}, element: (k, i, v) => { if (k === "functions") seen = v; } });
    check("an element much larger than the read buffer parses whole", seen?.pseudocode === big.functions[0].pseudocode, `${seen?.pseudocode?.length} chars`);

    // Where the cut lands decides which error names it: inside a string, or between values.
    let r = await rejects(() => readExport(writeExport("truncated", JSON.stringify(exportObject()).slice(0, 400)), { value: () => {}, element: () => {} }), /an unterminated string \(at key "program"\)/);
    check("an export cut off inside a string is an error naming the key", r.ok, r.detail);
    r = await rejects(() => readExport(writeExport("truncated2", `{"format_version": ${FORMAT_VERSION},`), { value: () => {}, element: () => {} }), /ends in state "key"/);
    check("an export cut off between values is an error", r.ok, r.detail);
    r = await rejects(() => readExport(writeExport("truncated3", '{"exporter": {"script": "StackmapExport"'), { value: () => {}, element: () => {} }), /a value that is never closed \(at key "exporter"\)/);
    check("an export cut off inside an object is an error naming the key", r.ok, r.detail);
    r = await rejects(() => readExport(writeExport("notobject", "[1,2,3]"), { value: () => {}, element: () => {} }), /expected "\{" at the start/);
    check("an export that is not an object is an error", r.ok, r.detail);
    r = await rejects(() => readExport(writeExport("badjson", '{"counts": {oops}}'), { value: () => {}, element: () => {} }), /counts.*not JSON|not JSON.*counts/s);
    check("a value that is not JSON is an error naming its key", r.ok, r.detail);
  }

  console.log("\n-- building the index --");
  {
    const path = writeExport("index", exportObject());
    const built = await buildIndex(path, join(sandbox, "index.sqlite"));
    check("every row is counted per section", JSON.stringify(built.rows) === '{"memory_blocks":1,"strings":2,"pointer_hits":1,"types":1,"instructions":2,"functions":1}', JSON.stringify(built.rows));
    const db = new DatabaseSync(join(sandbox, "index.sqlite"), { readOnly: true });
    const one = (sql, ...args) => db.prepare(sql).get(...args);
    const all = (sql, ...args) => db.prepare(sql).all(...args);
    check("a function's row keeps its signature, decompile status, and pseudocode",
      one("SELECT * FROM functions WHERE entry = ?", "0x401000").signature === "undefined FUN_00401000()" &&
      one("SELECT * FROM functions WHERE entry = ?", "0x401000").decompile === "ok" &&
      one("SELECT * FROM functions WHERE entry = ?", "0x401000").pseudocode.includes("return;"));
    check("noreturn and unresolved computed calls are kept as numbers",
      one("SELECT noreturn, computed_calls_unresolved FROM functions").noreturn === 0 && one("SELECT computed_calls_unresolved FROM functions").computed_calls_unresolved === 1);
    check("a call reference and a data reference are both stored, told apart by is_call",
      JSON.stringify(all("SELECT from_addr, from_fn, ref_type, is_call FROM function_refs ORDER BY from_addr")) ===
        '[{"from_addr":"0x401500","from_fn":"0x401400","ref_type":"UNCONDITIONAL_CALL","is_call":1},{"from_addr":"0x404000","from_fn":null,"ref_type":"DATA","is_call":0}]',
      JSON.stringify(all("SELECT from_addr, is_call FROM function_refs")));
    check("body ranges and callees are stored", one("SELECT lo, hi FROM function_bodies").hi === "0x40100f" && one("SELECT callee FROM function_callees").callee === "0x401200");
    check("an instruction's scalars and references are queryable",
      one("SELECT scalar FROM instruction_scalars WHERE addr = ?", "0x401001").scalar === "0x1a0" &&
      one("SELECT to_addr, ref_type FROM instruction_refs WHERE addr = ?", "0x401001").to_addr === "0x402100");
    check("an undefined string is marked as such and still queryable by value",
      one("SELECT address, defined FROM strings WHERE value = ?", "VZ.WAD").address === "0x402000" &&
      one("SELECT defined FROM strings WHERE value = ?", "VZ.WAD").defined === 0);
    check("a pointer word to a string is queryable by its target", one("SELECT address FROM pointer_hits WHERE target = ?", "0x402000").address === "0x403000");
    check("a type's fields keep their order, and an anonymous member keeps a null name",
      JSON.stringify(all("SELECT ordinal, name, offset, type_path FROM type_fields WHERE path = ? ORDER BY ordinal", "/p.pdb/Header")) ===
        '[{"ordinal":0,"name":"magic","offset":0,"type_path":"/uint"},{"ordinal":1,"name":null,"offset":4,"type_path":"/p.pdb/Header/Inner"}]',
      JSON.stringify(all("SELECT ordinal, name FROM type_fields")));
    check("a memory block keeps its permissions", one("SELECT execute, write FROM memory_blocks").execute === 1 && one("SELECT write FROM memory_blocks").write === 0);
    const meta = new Map(all("SELECT key, value FROM meta").map((r) => [r.key, r.value]));
    check("the export's own sections are kept in meta", JSON.parse(meta.get("program")).language === "x86:LE:32:default" && JSON.parse(meta.get("counts")).functions === 1);
    check("the index records what it was built from", meta.get("export_path") === path && Number(meta.get("export_size")) === statSync(path).size && meta.get("index_version") === String(INDEX_VERSION));
    db.close();
  }

  console.log("\n-- exports the index refuses --");
  {
    let r = await rejects(() => buildIndex(writeExport("oldformat", exportObject({ format_version: FORMAT_VERSION - 1 })), join(sandbox, "old.sqlite")), new RegExp(`format_version is ${FORMAT_VERSION - 1}, but this stackmap reads ${FORMAT_VERSION}`));
    check("an export of another format version is refused, naming both", r.ok, r.detail);
    r = await rejects(() => buildIndex(writeExport("noformat", { program: {} }), join(sandbox, "noformat.sqlite")), /no format_version/);
    check("a file with no format_version is refused", r.ok, r.detail);
    r = await rejects(() => buildIndex(writeExport("unknownkey", { ...exportObject(), surprise: 1 }), join(sandbox, "unknownkey.sqlite")), /unknown top-level key "surprise"/);
    check("an unknown top-level key is refused rather than ignored", r.ok, r.detail);
    r = await rejects(() => buildIndex(writeExport("unknownsection", { ...exportObject(), extras: [1] }), join(sandbox, "unknownsection.sqlite")), /unknown array section "extras"/);
    check("an unknown array section is refused rather than ignored", r.ok, r.detail);
    const wrongType = exportObject();
    wrongType.functions[0].noreturn = "no";
    r = await rejects(() => buildIndex(writeExport("wrongtype", wrongType), join(sandbox, "wrongtype.sqlite")), /functions\[0\]\.noreturn: expected true or false, got "no"/);
    check("a field of the wrong type is refused, naming the row and field", r.ok, r.detail);
    const missing = exportObject();
    delete missing.functions[0].refs_to;
    r = await rejects(() => buildIndex(writeExport("missingfield", missing), join(sandbox, "missingfield.sqlite")), /functions\[0\]\.refs_to: expected an array/);
    check("a missing field is refused, naming it", r.ok, r.detail);
    check("a refused build leaves no index behind", !["old.sqlite", "noformat.sqlite", "unknownkey.sqlite", "unknownsection.sqlite", "wrongtype.sqlite", "missingfield.sqlite"].some((f) => {
      try {
        statSync(join(sandbox, f));
        return true;
      } catch {
        return false;
      }
    }));
  }

  console.log("\n-- opening and rebuilding --");
  {
    const path = writeExport("open", exportObject());
    let open = await openIndex(path);
    check("the first open builds the index", open.built === "no index yet" && typeof open.buildSeconds === "number", JSON.stringify(open.built));
    check("the index sits beside the export", open.indexPath === indexPathFor(path) && open.indexPath === `${path}.sqlite`);
    open.db.close();
    open = await openIndex(path);
    check("the second open reuses it", open.built === null && open.buildSeconds === null, JSON.stringify(open.built));
    open.db.close();
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
    open = await openIndex(path);
    check("an export that changed on disk is reindexed", open.built === "the export changed on disk", JSON.stringify(open.built));
    open.db.close();
    const write = new DatabaseSync(indexPathFor(path));
    write.prepare("UPDATE meta SET value = ? WHERE key = ?").run(String(INDEX_VERSION + 1), "index_version");
    write.close();
    open = await openIndex(path);
    check("an index built by another stackmap version is rebuilt", /index version/.test(open.built ?? ""), JSON.stringify(open.built));
    open.db.close();
    const r = await rejects(() => openIndex(join(sandbox, "does-not-exist.json")), /the Ghidra export .*does-not-exist\.json is missing/);
    check("a missing export is an error", r.ok, r.detail);
  }

  console.log("\n-- staleness against the Ghidra project --");
  {
    const p = project("fresh", { versions: [4] });
    const db = statSync(join(p.dbDir, "db.4.gbf"));
    const exported = { file_id: p.fileId, folder: "00/~00000000.db", file: "db.4.gbf", version: 4, size: db.size, mtime_ms: db.mtimeMs };
    check("a project saved no further is fresh", freshness(exported, p.location, p.name).state === "fresh", JSON.stringify(freshness(exported, p.location, p.name)));
    writeFileSync(join(p.dbDir, "db.5.gbf"), "a newer save");
    const stale = freshness(exported, p.location, p.name);
    check("a newer database version is stale, naming both versions", stale.state === "stale" && /db\.4\.gbf -> db\.5\.gbf/.test(stale.reason) && /Re-run ghidra_scripts\/StackmapExport\.java/.test(stale.reason), JSON.stringify(stale));
    check("…and reports what it compared", stale.exported.file === "db.4.gbf" && stale.now.file === "db.5.gbf");
    rmSync(join(p.dbDir, "db.5.gbf"));
    check("removing it makes the export fresh again", freshness(exported, p.location, p.name).state === "fresh");
    // A read-only open (which is how an export is produced) rewrites the project's index files but
    // never the .gbf files, so touching the index must not make an export look stale.
    const index = join(p.location, `${p.name}.rep`, "idata", "~index.dat");
    const later = new Date(Date.now() + 60_000);
    utimesSync(index, later, later);
    check("rewriting the project index (what a read-only open does) leaves it fresh", freshness(exported, p.location, p.name).state === "fresh");

    check("an unreadable project is 'unknown', not fresh and not stale",
      freshness(exported, join(sandbox, "nope/"), "nope").state === "unknown" && /~index\.dat is missing/.test(freshness(exported, join(sandbox, "nope/"), "nope").reason));
    const gone = project("gone", { fileId: "other" });
    const lost = freshness(exported, gone.location, gone.name);
    check("a program that is no longer in the project is 'unknown', naming its file id", lost.state === "unknown" && /no program with file id abc123/.test(lost.reason), JSON.stringify(lost));
    const empty = project("empty", { versions: [] });
    check("a database folder with no db.<N>.gbf is 'unknown'", /no db\.<N>\.gbf/.test(freshness(exported, empty.location, empty.name).reason ?? ""));
    const many = project("many", { versions: [2, 10, 9] });
    const newest = readProgramDatabase(many.location, many.name, many.fileId);
    check("the newest database version is chosen numerically, not by name", newest.found && newest.database.file === "db.10.gbf", JSON.stringify(newest));

    // Through an export: its recorded project path and file id drive the check.
    const real = project("real", { versions: [4] });
    const stat4 = statSync(join(real.dbDir, "db.4.gbf"));
    const path = writeExport("stale", exportObject({
      project: { location: real.location, name: real.name, gpr: `${real.location}${real.name}.gpr` },
      program_database: { file_id: real.fileId, folder: "00/~00000000.db", file: "db.4.gbf", version: 4, size: stat4.size, mtime_ms: stat4.mtimeMs },
    }));
    const open = await openIndex(path);
    check("an export reports itself fresh against its own project", exportFreshness(open.meta, path).state === "fresh", JSON.stringify(exportFreshness(open.meta, path)));
    check("the recorded database is read back from the index", exportedDatabase(open.meta, path).file === "db.4.gbf");
    writeFileSync(join(real.dbDir, "db.5.gbf"), "saved again");
    check("…and stale once the program is saved again", exportFreshness(open.meta, path).state === "stale");
    open.db.close();
    const noProject = await openIndex(writeExport("noproject", exportObject({ project: { location: join(sandbox, "missing/"), name: "missing", gpr: "x" } })));
    check("an export whose project is gone is 'unknown'", exportFreshness(noProject.meta, "noproject").state === "unknown");
    noProject.db.close();
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall ghidra checks passed" : `\n${failed} ghidra check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
