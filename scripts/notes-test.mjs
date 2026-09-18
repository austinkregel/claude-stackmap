#!/usr/bin/env node
/**
 * Note-store suite: supersession, retraction weighting, provenance drift, stamps across a project's
 * roots, the note file format, typed notes and their data files, note_query filters, and the data
 * tokenizer.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { NoteStore } = await import(pathToFileURL(join(root, "dist/notes/store.js")).href);
const { noteWrite, noteSearch, noteGet, noteSupersede, noteQuery, noteSchemas } = await import(pathToFileURL(join(root, "dist/notes/tools.js")).href);
const { NOTE_SCHEMAS, schemaJson } = await import(pathToFileURL(join(root, "dist/notes/schemas.js")).href);
const { dataTokens } = await import(pathToFileURL(join(root, "dist/notes/search.js")).href);

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};
const throws = (fn, pattern) => {
  try {
    fn();
    return { ok: false, detail: "did not throw" };
  } catch (err) {
    return { ok: pattern.test(err.message), detail: err.message };
  }
};

const dir = mkdtempSync(join(tmpdir(), "stackmap-notes-"));
const repo = realpathSync(mkdtempSync(join(tmpdir(), "stackmap-repo-")));
const pkg = realpathSync(mkdtempSync(join(tmpdir(), "stackmap-pkg-")));
const other = realpathSync(mkdtempSync(join(tmpdir(), "stackmap-other-")));
const mainRoot = (path) => ({ kind: "root", configured: path, path, include: null, exclude: null });
const aliasRoot = (configured, path) => ({ kind: "alias", configured, path, include: null, exclude: null });
/** Projects the way the server resolves them: by the note's own repo name. */
let projects = { fuel: [mainRoot(repo), aliasRoot("~/pkg", pkg)], other: [mainRoot(other)] };
const rootsFor = (name) => (projects[name] ? { roots: projects[name] } : { roots: null, reason: `no enabled index named "${name}"` });
/**
 * After writing note files behind a store's back: mark its listing stale, as its watcher would. The
 * watcher's events can't be delivered while this synchronous code runs, and the listing's 2s backstop
 * is too slow for a test.
 */
const rescan = (store) => { store.dirty = true; };

/** sha256 of each shipped schema's JSON Schema. A schema's shape may only change with a version bump. */
const SCHEMA_FINGERPRINTS = {
  "struct_field_list@2": "a932398ad76ef2954bff21dd652d35fde86d613088687376db647a10bafb5679",
  "offset_table@1": "d1d508385f30c3ba750f5ee02361195347fcaadb7a61674ebf19696e75678bb9",
  "algorithm_params@1": "91647733b81f5852293ac84c14d039500a29c4a0db78ed4dde5026953573f0e5",
};

const LAYOUT = {
  name: "Header",
  size: 16,
  align: 4,
  fields: [
    { name: "magic", offset: 0, size: 4, type: "u32" },
    { name: "Flags", offset: 4, size: 4, type: "uint32_t", bit_offset: 0, bit_size: 3 },
    { name: "inner", offset: 8, size: 8, type: "Inner", layout: { name: "Inner", size: 8, align: null, fields: [{ name: "count", offset: 0, size: 8, type: "u64" }] } },
  ],
};
const OFFSETS = { subject: "save slot", base: "slot start", entries: [{ name: "money", offset: "0x1A0", size: 4 }, { name: "ammo", offset: "0x9" }] };
const CRC = { algorithm: "CRC-32/ISO-HDLC", variant: "reflected", site: "0x00401000", params: [{ name: "poly", value: 3988292384 }, { name: "refin", value: true }, { name: "xorout", value: "0xFFFFFFFF" }, { name: "init", value: null }] };

async function typedNotes() {
  const typedDir = join(dir, "typed");
  const store = new NoteStore(typedDir);
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const noProject = () => ({ roots: null, reason: "no project in this test" });
  let t;

  console.log("\n-- typed notes: storage --");
  const w = noteWrite(store, { id: "header", title: "Header layout", body: "The save header.", schema: "struct_field_list", data: LAYOUT }, noProject);
  check("a typed write names its data file, schema, and version", w.dataPath === join(typedDir, "header.json") && w.schema === "struct_field_list" && w.schemaVersion === 2, JSON.stringify(w));
  const dataBytes = readFileSync(join(typedDir, "header.json"));
  const onDisk = JSON.parse(dataBytes.toString("utf8"));
  check("the data file holds {schema, version, data}", onDisk.schema === "struct_field_list" && onDisk.version === 2 && JSON.stringify(onDisk.data) === JSON.stringify(LAYOUT), JSON.stringify(onDisk));
  const md = readFileSync(join(typedDir, "header.md"), "utf8");
  check("the note records the schema, version, and the data file's sha256", md.includes('schema: "struct_field_list"') && md.includes("schema_version: 2") && md.includes(`data_sha256: "${sha(dataBytes)}"`), md);
  check("the record round-trips exactly", JSON.stringify(store.get("header").record) === JSON.stringify({ schema: "struct_field_list", version: 2, data: LAYOUT }));
  check("no temporary files are left behind", readdirSync(typedDir).every((f) => f.endsWith(".md") || f.endsWith(".json")), readdirSync(typedDir).join());
  check("note_get reports the record valid", noteGet(store, { id: "header" }, noProject).validation?.valid === true);

  writeFileSync(join(typedDir, "header.json"), dataBytes.toString("utf8").replace('"magic"', '"MAGIC"'));
  rescan(store);
  t = throws(() => store.get("header"), /header\.md: its data file header\.json doesn't match the hash the note recorded/);
  check("a data file changed apart from its note (an interrupted write) is an error on read", t.ok, t.detail);
  check("…and listed as malformed, not served", store.list().every((x) => x.id !== "header") && store.malformed().some((m) => m.file === "header.md" && /doesn't match the hash/.test(m.error)), JSON.stringify(store.malformed()));
  writeFileSync(join(typedDir, "header.json"), dataBytes);
  rescan(store);
  check("restoring the data file makes the note readable again", store.list().some((x) => x.id === "header"));
  // The note file is untouched, so this checks that the parsed-note cache is keyed on the data file too.
  writeFileSync(join(typedDir, "header.json"), `${dataBytes.toString("utf8")}\n`);
  rescan(store);
  check("the parsed-note cache notices a change to the data file alone", store.list().every((x) => x.id !== "header"), JSON.stringify(store.list().map((x) => x.id)));
  writeFileSync(join(typedDir, "header.json"), dataBytes);
  rmSync(join(typedDir, "header.json"));
  t = throws(() => store.get("header"), /a typed note \(struct_field_list\) whose data file header\.json is missing/);
  check("a typed note whose data file is missing is an error", t.ok, t.detail);
  writeFileSync(join(typedDir, "header.json"), dataBytes);

  console.log("\n-- typed notes: writes --");
  noteWrite(store, { id: "header", title: "Header layout", body: "Updated prose only." }, noProject);
  check("updating a typed note without schema/data keeps its record", JSON.stringify(store.get("header").record?.data) === JSON.stringify(LAYOUT) && store.get("header").body === "Updated prose only.");
  const before = readFileSync(join(typedDir, "header.json"), "utf8");
  t = throws(() => noteWrite(store, { id: "header", title: "Header layout", body: "x", schema: "offset_table", data: OFFSETS }, noProject), /is a struct_field_list record; changing it to offset_table is not allowed/);
  check("writing an existing typed id under another schema is an error", t.ok, t.detail);
  check("…and leaves the data file untouched", readFileSync(join(typedDir, "header.json"), "utf8") === before);
  noteWrite(store, { id: "prose", title: "Prose first", body: "Untyped." }, noProject);
  noteWrite(store, { id: "prose", title: "Prose first", body: "Now typed.", schema: "offset_table", data: OFFSETS }, noProject);
  check("an untyped note can become typed", store.get("prose").record?.schema === "offset_table");
  t = throws(() => noteWrite(store, { title: "half", body: "x", schema: "offset_table" }, noProject), /'schema' and 'data' go together/);
  check("schema without data is an error", t.ok, t.detail);
  t = throws(() => noteWrite(store, { title: "half", body: "x", data: OFFSETS }, noProject), /'schema' and 'data' go together/);
  check("data without schema is an error", t.ok, t.detail);
  t = throws(() => noteWrite(store, { title: "unknown", body: "x", schema: "vtable", data: {} }, noProject), /note schema "vtable" is unknown\. Known: struct_field_list, offset_table, algorithm_params/);
  check("an unknown schema is an error naming the known ones", t.ok, t.detail);
  t = throws(() => noteWrite(store, { title: "bad offsets", body: "x", schema: "offset_table", data: { ...OFFSETS, entries: [{ name: "money", offset: "416" }] } }, noProject), /does not validate against offset_table@1:\n {2}- entries\.0\.offset: must be a hex string like 0x1A0\nSchema:\n\{/);
  check("invalid data is an error listing each issue and the schema", t.ok, t.detail);
  t = throws(() => noteWrite(store, { title: "extra key", body: "x", schema: "algorithm_params", data: { ...CRC, notes: "no" } }, noProject), /does not validate against algorithm_params@1/);
  check("a key the schema doesn't declare is invalid", t.ok, t.detail);
  check("…and nothing is written for invalid data", !existsSync(join(typedDir, "bad-offsets.md")) && !existsSync(join(typedDir, "extra-key.json")));

  noteWrite(store, { id: "crc", title: "Checksum", body: "The save checksum.", schema: "algorithm_params", data: CRC, repo: "fuel" }, noProject);
  noteWrite(store, { id: "crc-wrong", title: "Checksum guess", body: "Wrong guess.", schema: "algorithm_params", data: { ...CRC, variant: "normal" }, status: "retracted" }, noProject);
  noteWrite(store, { id: "adler", title: "Other checksum", body: "In another project.", schema: "algorithm_params", data: { algorithm: "adler32", variant: "zlib", site: "0x00402000", params: [] }, repo: "other" }, noProject);

  console.log("\n-- note_schemas --");
  const listed = noteSchemas().schemas;
  check("note_schemas lists all three with their JSON Schema", listed.map((s) => `${s.name}@${s.version}`).join() === "struct_field_list@2,offset_table@1,algorithm_params@1" && listed.every((s) => s.jsonSchema?.type === "object" && s.description), JSON.stringify(listed.map((s) => s.name)));
  for (const s of NOTE_SCHEMAS) {
    const key = `${s.name}@${s.version}`;
    const actual = sha(JSON.stringify(schemaJson(s)));
    check(`${key}'s shape matches its pinned fingerprint (bump the version to change it)`, SCHEMA_FINGERPRINTS[key] === actual, `pinned ${SCHEMA_FINGERPRINTS[key]}, now ${actual}`);
  }
  check("every shipped schema has a pinned fingerprint", Object.keys(SCHEMA_FINGERPRINTS).length === NOTE_SCHEMAS.length);

  console.log("\n-- note_query: comparators --");
  const q = (schema, filter, extra = {}) => noteQuery(store, { schema, filter, ...extra }, noProject).records.map((r) => r.id).join();
  const cond = (parameter, comparator, value) => (value === undefined ? { parameter, comparator } : { parameter, comparator, value });
  const all = (...conditions) => ({ operator: "and", conditions });
  const any = (...conditions) => ({ operator: "or", conditions });
  const S = "struct_field_list";
  const A = "algorithm_params";
  const O = "offset_table";
  const cases = [
    ["EQUAL matches any element, case-insensitively", S, all(cond("fields[].type", "EQUAL", "U32")), "header"],
    ["NOT_EQUAL means no element equals", S, all(cond("fields[].type", "NOT_EQUAL", "u32")), ""],
    ["NOT_EQUAL on a value no element has", S, all(cond("fields[].type", "NOT_EQUAL", "i8")), "header"],
    ["LIKE is a case-insensitive substring", S, all(cond("fields[].type", "LIKE", "INT32")), "header"],
    ["NOTLIKE", S, all(cond("fields[].type", "NOTLIKE", "int32")), ""],
    ["IN takes a list, case-insensitively", A, all(cond("algorithm", "IN", ["adler32", "crc-32/iso-hdlc"])), "adler,crc"],
    ["NOTIN", A, all(cond("algorithm", "NOTIN", ["ADLER32"])), "crc"],
    ["STARTS_WITH", S, all(cond("fields[].name", "STARTS_WITH", "fla")), "header"],
    ["NOT_STARTS_WITH", S, all(cond("fields[].name", "NOT_STARTS_WITH", "fla")), ""],
    ["ENDS_WITH", A, all(cond("algorithm", "ENDS_WITH", "HDLC")), "crc"],
    ["NOT_ENDS_WITH", A, all(cond("algorithm", "NOT_ENDS_WITH", "HDLC")), "adler"],
    ["REGEX is case-insensitive", S, all(cond("fields[].type", "REGEX", "^UINT\\d+_T$")), "header"],
    ["NOT_REGEX", A, all(cond("site", "NOT_REGEX", "^0x004010")), "adler"],
    ["EXISTS on an optional field", S, all(cond("fields[].bit_size", "EXISTS")), "header"],
    ["MISSING means no element has it", S, all(cond("fields[].bit_size", "MISSING")), ""],
    ["EXISTS doesn't count a key present with null", S, all(cond("fields[].layout.align", "EXISTS")), ""],
    ["MISSING counts a key present with null", S, all(cond("fields[].layout.align", "MISSING")), "header"],
    ["EXISTS on a non-null value", S, all(cond("align", "EXISTS")), "header"],
    ["EQUAL null", S, all(cond("fields[].layout.align", "EQUAL", null)), "header"],
    ["a list with no elements has nothing to match", A, all(cond("params[].name", "EXISTS")), "crc"],
    ["numbers compare numerically", A, all(cond("params[].value", "GREATER_THAN", 1000)), "crc"],
    ["LESS_THAN", S, all(cond("size", "LESS_THAN", 16)), ""],
    ["LESS_THAN_EQUAL", S, all(cond("size", "LESS_THAN_EQUAL", 16)), "header"],
    ["GREATER_THAN_EQUAL", S, all(cond("fields[].offset", "GREATER_THAN_EQUAL", 8)), "header"],
    ["a number never compares with a string", S, all(cond("size", "GREATER_THAN", "1")), ""],
    ["EQUAL on a boolean", A, all(cond("params[].value", "EQUAL", true)), "crc"],
    ["recursion follows a nested layout", S, all(cond("fields[].layout.fields[].type", "EQUAL", "u64")), "header"],
    ["hex strings compare as text: 0x9 sorts after 0x1A0", O, all(cond("entries[].offset", "GREATER_THAN", "0x1A1")), "prose"],
    ["text ranges are case-sensitive: 0x1A0 is below 0x1a0", O, all(cond("entries[].offset", "LESS_THAN", "0x1a0"), cond("entries[].offset", "GREATER_THAN_EQUAL", "0x1A0")), "prose"],
    ["and: every condition holds", A, all(cond("algorithm", "LIKE", "crc"), cond("variant", "EQUAL", "reflected")), "crc"],
    ["or: any condition holds", A, any(cond("algorithm", "EQUAL", "adler32"), cond("variant", "EQUAL", "reflected")), "adler,crc"],
    ["groups nest", A, any(all(cond("algorithm", "LIKE", "crc"), cond("variant", "EQUAL", "normal")), cond("algorithm", "EQUAL", "adler32")), "adler"],
    ["an empty group matches everything", A, all(), "adler,crc"],
  ];
  for (const [label, schema, filter, expected] of cases) {
    const got = q(schema, filter);
    check(`note_query ${label}`, got === expected, `expected "${expected}", got "${got}"`);
  }
  check("an omitted filter matches everything, sorted by id", q(A, undefined) === "adler,crc");

  console.log("\n-- note_query: statuses, repo, paging --");
  let r = noteQuery(store, { schema: A }, noProject);
  check("retracted records are left out by default and counted", r.matched === 2 && r.excludedRetracted === 1, JSON.stringify(r));
  check("include_retracted brings them back", q(A, undefined, { include_retracted: true }) === "adler,crc,crc-wrong");
  check("the retracted count follows the filter", noteQuery(store, { schema: A, filter: all(cond("variant", "EQUAL", "reflected")) }, noProject).excludedRetracted === 0);
  check("repo keeps that project's records and records with no repo", q(A, undefined, { repo: "fuel", include_retracted: true }) === "crc,crc-wrong");
  r = noteQuery(store, { schema: A, include_retracted: true, limit: 1, offset: 1 }, noProject);
  check("limit and offset page through the sorted records", r.records.map((x) => x.id).join() === "crc" && r.matched === 3 && r.returned === 1 && r.offset === 1 && r.limit === 1, JSON.stringify(r));
  check("records carry their data exactly as stored, plus status and drift", JSON.stringify(r.records[0].data) === JSON.stringify(CRC) && r.records[0].status === "current" && Array.isArray(r.records[0].drift));
  t = throws(() => noteQuery(store, { schema: A, offset: "1" }, noProject), /'offset' must be a number of at least 0, got "1"/);
  check("a non-numeric offset is an error", t.ok, t.detail);
  t = throws(() => noteQuery(store, {}, noProject), /note_query requires 'schema'/);
  check("schema is required", t.ok, t.detail);
  t = throws(() => noteQuery(store, { schema: "vtable" }, noProject), /note schema "vtable" is unknown/);
  check("an unknown schema is an error", t.ok, t.detail);

  console.log("\n-- note_query: rejected filters --");
  const rejects = [
    ["an unknown field names the valid ones", S, all(cond("fields[].typo", "EQUAL", "x")), /no field "typo" at fields\[\]\. Valid: name, anonymous, offset, size, type, bit_offset, bit_size, layout/],
    ["[] on a field that isn't a list", S, all(cond("name[]", "EXISTS")), /name is not a list, so it can't take \[\]/],
    ["walking into a list without []", S, all(cond("fields.type", "EXISTS")), /fields is not an object with fields/],
    ["walking into a scalar", S, all(cond("name.first", "EXISTS")), /name is not an object with fields/],
    ["an index instead of []", S, all(cond("fields[0].type", "EXISTS")), /invalid segment "fields\[0\]"/],
    ["an unknown comparator", S, all(cond("name", "EQUALS", "x")), /unknown comparator "EQUALS"/],
    ["EXISTS with a value", S, all(cond("name", "EXISTS", "x")), /takes no value/],
    ["EQUAL without a value", S, all(cond("name", "EQUAL")), /needs a value/],
    ["IN with an empty list", A, all(cond("algorithm", "IN", [])), /needs a non-empty list/],
    ["IN with a non-list", A, all(cond("algorithm", "IN", "crc")), /needs a non-empty list/],
    ["LIKE with a number", A, all(cond("algorithm", "LIKE", 3)), /needs a string value/],
    ["an invalid REGEX", A, all(cond("algorithm", "REGEX", "(")), /has an invalid pattern/],
    ["a range with a boolean", A, all(cond("site", "LESS_THAN", true)), /needs a number or string value/],
    ["a condition at the top level", A, cond("algorithm", "EQUAL", "crc"), /the top level must be a group/],
    ["an unknown operator", A, { operator: "xor", conditions: [] }, /needs "operator": "and" or "or"/],
    ["a group without a conditions list", A, { operator: "and" }, /needs a "conditions" list/],
    ["an unknown key on a group", A, { operator: "and", conditions: [], must_all_conditions_pass: true }, /unknown key "must_all_conditions_pass"/],
    ["an unknown key on a condition", A, all({ ...cond("algorithm", "EQUAL", "crc"), negate: true }), /unknown key "negate"/],
    ["a condition that isn't an object", A, all("algorithm = crc"), /must be an object/],
  ];
  for (const [label, schema, filter, pattern] of rejects) {
    t = throws(() => noteQuery(store, { schema, filter }, noProject), pattern);
    check(`note_query rejects ${label}`, t.ok, t.detail);
  }

  console.log("\n-- note_query: records that don't validate --");
  const rawTyped = (id, schema, version, data) => {
    const text = `${JSON.stringify({ schema, version, data }, null, 2)}\n`;
    writeFileSync(join(typedDir, `${id}.json`), text);
    writeFileSync(join(typedDir, `${id}.md`), `---\nformat: 2\nid: "${id}"\ntitle: "${id}"\nstatus: "current"\ncreated: "2026-01-01"\nverified_on: null\nrepo: null\ntags: []\nsupersedes: []\nsuperseded_by: []\nschema: "${schema}"\nschema_version: ${version}\ndata_sha256: "${sha(text)}"\nfiles:\n---\n\nWritten by hand.\n`);
  };
  rawTyped("old-version", A, 0, CRC);
  rawTyped("hand-edited", A, 1, { ...CRC, site: "" });
  rawTyped("retired", "vtable_list", 1, { entries: [] });
  rescan(store);
  r =noteQuery(store, { schema: A }, noProject);
  const invalid = (id) => r.invalid.find((x) => x.id === id);
  check("a record written under another version is reported, not matched", invalid("old-version")?.reason === "other-version" && /written under algorithm_params@0; this plugin ships algorithm_params@1/.test(invalid("old-version").message), JSON.stringify(r.invalid));
  check("a record that no longer validates is reported with its issues", invalid("hand-edited")?.reason === "fails-validation" && invalid("hand-edited").issues.some((i) => i.path === "site"), JSON.stringify(r.invalid));
  check("a record of a schema this plugin doesn't ship is reported in every query", invalid("retired")?.reason === "unknown-schema" && noteQuery(store, { schema: O }, noProject).invalid.some((x) => x.id === "retired"), JSON.stringify(r.invalid));
  check("…and none of them is returned as a match", !r.records.some((x) => ["old-version", "hand-edited", "retired"].includes(x.id)));
  check("note_get reports why a stored record is invalid", noteGet(store, { id: "hand-edited" }, noProject).validation?.reason === "fails-validation");
  writeFileSync(join(typedDir, "stray.json"), "{}\n");
  rescan(store);
  check("note_query lists malformed files too", noteQuery(store, { schema: A }, noProject).malformedFiles.some((m) => m.file === "stray.json"));
  for (const f of ["old-version", "hand-edited", "retired"]) for (const ext of [".md", ".json"]) rmSync(join(typedDir, `${f}${ext}`));
  rmSync(join(typedDir, "stray.json"));
  rescan(store);

  // struct_field_list@2: an anonymous union member has no name, and carries its own layout.
  const ANON = {
    name: "Slot", size: 8, align: 4,
    fields: [
      { name: "kind", offset: 0, size: 4, type: "u32" },
      { name: null, anonymous: true, offset: 4, size: 4, type: "Value", layout: { name: "Value", size: 4, align: 4, fields: [{ name: "index", offset: 0, size: 4, type: "u32" }] } },
    ],
  };
  const anon = noteWrite(store, { id: "slot", title: "Slot layout", body: "An anonymous union member.", schema: "struct_field_list", data: ANON }, noProject);
  check("a layout with an anonymous member is stored under struct_field_list@2", anon.schemaVersion === 2 && JSON.stringify(store.get("slot").record.data) === JSON.stringify(ANON), JSON.stringify(anon));
  check("…and is found by a filter on the anonymous flag",
    noteQuery(store, { schema: "struct_field_list", filter: { operator: "and", conditions: [{ parameter: "fields[].anonymous", comparator: "EQUAL", value: true }] } }, noProject).records.map((r) => r.id).join() === "slot");
  t = throws(() => noteWrite(store, { title: "empty name", body: "x", schema: "struct_field_list", data: { ...ANON, fields: [{ name: "", offset: 0, size: 4, type: "u32" }] } }, noProject), /does not validate against struct_field_list@2/);
  check("an empty field name is still refused", t.ok, t.detail);

  console.log("\n-- data tokenizer --");
  const tok = (text, expected) => {
    const got = JSON.stringify(dataTokens(text));
    check(`dataTokens(${JSON.stringify(text)})`, got === JSON.stringify(expected), got);
  };
  tok("3.14", ["3.14", "3", "14"]);
  tok("-2", ["-2", "2"]);
  tok("+7", ["+7"]);
  tok(".5", ["5"]);
  tok("x", ["x"]);
  tok("0x1A0", ["0x1a0"]);
  tok("fields.offset", ["fields.offset", "fields", "offset"]);
  tok("CRC-32/ISO-HDLC", ["crc-32", "crc", "32", "iso-hdlc", "iso", "hdlc"]);
  tok("ns::Type:", ["ns::type", "ns", "type"]);
  const found = (query) => noteSearch(store, { query }, noProject).results.map((x) => x.id);
  check("note_search finds a typed note by a hex value in its data", found("0x1a0").includes("prose"), JSON.stringify(found("0x1a0")));
  check("…by a short token", found("u32").includes("header"), JSON.stringify(found("u32")));
  check("…by a number", found("3988292384").includes("crc"), JSON.stringify(found("3988292384")));
  check("…by a data key", found("bit_size").includes("header"), JSON.stringify(found("bit_size")));
  check("…by the schema name", found("offset_table").includes("prose"), JSON.stringify(found("offset_table")));
  check("note_search results name each note's schema", noteSearch(store, { query: "checksum" }, noProject).results.find((x) => x.id === "crc")?.schema === "algorithm_params");
  store.close();
}

try {
  const store = new NoteStore(join(dir, "notes"));
  writeFileSync(join(repo, "service.php"), "<?php class A { function go() { return 1; } }\n");

  console.log("-- write + stamp --");
  const w = noteWrite(store, {
    title: "Budget service resolves through a closure",
    body: "AdWordsServiceProvider binds BudgetServiceContract to a closure, so the concrete type is runtime-decided.",
    files: ["service.php"], tags: ["laravel", "di"], repo: "fuel",
  }, rootsFor);
  check("note written", w.written === "budget-service-resolves-through-a-closure", w.written);
  check("file was content-stamped", w.stampedFiles === 1, JSON.stringify(w));

  console.log("\n-- search finds it, drift clean --");
  let r = noteSearch(store, { query: "budget closure" }, rootsFor);
  check("found by query", r.results.length === 1, JSON.stringify(r.results.map(x => x.id)));
  check("no drift while file is untouched", r.results[0].drift[0].state === "unchanged", JSON.stringify(r.results[0].drift));
  check("no caveat while ground is intact", r.results[0].caveat === null, String(r.results[0].caveat));
  const cleanScore = r.results[0].score;

  console.log("\n-- drift: change the file underneath the note --");
  appendFileSync(join(repo, "service.php"), "// edited after the conclusion was written\n");
  r = noteSearch(store, { query: "budget closure" }, rootsFor);
  check("drift now reports 'changed'", r.results[0].drift[0].state === "changed", JSON.stringify(r.results[0].drift));
  check("caveat warns the conclusion predates the change", /predates 1 change/.test(r.results[0].caveat ?? ""), String(r.results[0].caveat));
  check("score demoted vs clean ground", r.results[0].score < cleanScore, `${r.results[0].score} vs ${cleanScore}`);

  console.log("\n-- missing file is reported, not silently ignored --");
  rmSync(join(repo, "service.php"));
  check("drift reports 'missing'", noteGet(store, { id: w.written }, rootsFor).drift[0].state === "missing");

  console.log("\n-- stamps across a project's roots --");
  writeFileSync(join(pkg, "Contract.php"), "<?php interface Contract {}\n");
  let n = noteWrite(store, { title: "Contract lives in the package", body: "It is declared in the alias root.", files: ["Contract.php"], repo: "fuel" }, rootsFor);
  let stored = store.get(n.written);
  check("a relative path found only in an alias records that alias", stored.files[0].root === "~/pkg" && stored.files[0].path === "Contract.php" && stored.files[0].sha256 !== "missing", JSON.stringify(stored.files));
  check("…and survives a round trip through the note file", /root: "~\/pkg"/.test(readFileSync(join(dir, "notes", `${n.written}.md`), "utf8")));
  check("…and resolves back to the alias for drift", noteGet(store, { id: n.written }, rootsFor).drift[0].state === "unchanged", JSON.stringify(noteGet(store, { id: n.written }, rootsFor).drift));
  writeFileSync(join(repo, "Contract.php"), "<?php interface Contract {}\n");
  let t = throws(() => noteWrite(store, { title: "ambiguous", body: "x", files: ["Contract.php"], repo: "fuel" }, rootsFor), /exists in more than one root .*pass an absolute path/);
  check("a relative path present in two roots is an error", t.ok, t.detail);
  n = noteWrite(store, { title: "absolute in alias", body: "x", files: [join(pkg, "Contract.php")], repo: "fuel" }, rootsFor);
  stored = store.get(n.written);
  check("an absolute path inside an alias is stored relative to it", stored.files[0].root === "~/pkg" && stored.files[0].path === "Contract.php", JSON.stringify(stored.files));
  n = noteWrite(store, { title: "not there yet", body: "x", files: ["later.php"], repo: "fuel" }, rootsFor);
  stored = store.get(n.written);
  check("a relative path in no root is stamped missing against the main root", stored.files[0].sha256 === "missing" && stored.files[0].root === undefined, JSON.stringify(stored.files));
  t = throws(() => noteWrite(store, { title: "no project", body: "x", files: ["service.php"], repo: "nowhere" }, rootsFor), /can't stamp "service\.php" — no enabled index named "nowhere"/);
  check("a relative path with no resolvable project is an error", t.ok, t.detail);
  n = noteWrite(store, { title: "absolute without a project", body: "x", files: [join(pkg, "Contract.php")], repo: "nowhere" }, rootsFor);
  check("an absolute path needs no project", store.get(n.written).files[0].path === join(pkg, "Contract.php"), JSON.stringify(store.get(n.written).files));
  check("a note without files needs no project", noteWrite(store, { title: "prose only", body: "x", repo: "nowhere" }, rootsFor).stampedFiles === 0);

  writeFileSync(join(dir, "notes", "legacy.md"),
    `---\nid: "legacy"\ntitle: "Written before roots existed"\nstatus: current\ncreated: "2026-01-01T00:00:00Z"\nverified_on: null\nrepo: "fuel"\ntags: []\nsupersedes: []\nsuperseded_by: []\nfiles:\n  - path: "Contract.php"\n    sha256: "0000000000000000"\n    at: "2026-01-01T00:00:00Z"\n---\n\nOld note.\n`);
  const legacy = noteGet(store, { id: "legacy" }, rootsFor);
  check("an older stamp with no root resolves against the main root", legacy.drift[0].state === "changed" && legacy.drift[0].root === undefined, JSON.stringify(legacy.drift));
  check("a note in the older format is read as it is", legacy.found && legacy.title === "Written before roots existed" && legacy.record === null, JSON.stringify(legacy));

  const aliasNote = store.list().find((x) => x.title === "Contract lives in the package");
  projects = { fuel: [mainRoot(repo)], other: [mainRoot(other)] };
  const gone = noteGet(store, { id: aliasNote.id }, rootsFor);
  check("a stamp whose alias is no longer configured is 'unresolved', with the reason", gone.drift[0].state === "unresolved" && /alias "~\/pkg" is no longer configured/.test(gone.drift[0].reason), JSON.stringify(gone.drift));
  check("…and counts as not-unchanged in the caveat", /predates 1 change/.test(gone.caveat ?? ""), String(gone.caveat));
  const noProject = noteGet(store, { id: aliasNote.id }, () => ({ roots: null, reason: "no enabled indexes configured" }));
  check("a note whose project can't be found is 'unresolved', with the reason", noProject.drift[0].state === "unresolved" && /no enabled indexes configured/.test(noProject.drift[0].reason), JSON.stringify(noProject.drift));

  writeFileSync(join(other, "same.php"), "one\n");
  writeFileSync(join(repo, "same.php"), "two\n");
  const otherNote = noteWrite(store, { title: "about the other project", body: "x", files: ["same.php"], repo: "other" }, rootsFor);
  writeFileSync(join(repo, "same.php"), "changed in fuel only\n");
  const hits = noteSearch(store, { query: "other project" }, rootsFor).results.filter((x) => x.id === otherNote.written);
  check("drift resolves against the note's own project, not the query's", hits[0]?.drift[0]?.state === "unchanged", JSON.stringify(hits));

  console.log("\n-- supersession --");
  noteWrite(store, { title: "Budget service now binds concretely", body: "The closure was replaced with a direct binding.", repo: "fuel" }, rootsFor);
  const s = noteSupersede(store, { old_id: "budget-service-resolves-through-a-closure", new_id: "budget-service-now-binds-concretely" });
  check("both sides updated", s.updated.length === 2, JSON.stringify(s));
  const old = noteGet(store, { id: "budget-service-resolves-through-a-closure" }, rootsFor);
  check("old note demoted, not deleted", old.found && old.status === "superseded", JSON.stringify(old.status));
  check("back-link recorded", old.supersededBy.includes("budget-service-now-binds-concretely"), JSON.stringify(old.supersededBy));

  console.log("\n-- retracted notes are hidden by default but retrievable --");
  noteWrite(store, { title: "Wrong turn about caching", body: "Believed the cache was per-request. It is not.", status: "retracted", repo: "fuel" }, rootsFor);
  check("hidden by default", noteSearch(store, { query: "caching wrong turn" }, rootsFor).results.length === 0);
  check("surfaced when asked", noteSearch(store, { query: "caching wrong turn", include_retracted: true }, rootsFor).results.length === 1);

  console.log("\n-- validation --");
  let threw = false;
  try { noteWrite(store, { title: "x", body: "y", status: "bogus" }, rootsFor); } catch { threw = true; }
  check("invalid status rejected", threw);
  threw = false;
  try { noteSupersede(store, { old_id: "nope", new_id: "also-nope" }); } catch { threw = true; }
  check("supersede on missing ids rejected", threw);
  t = throws(() => noteSearch(store, { query: "x", limit: "ten" }, rootsFor), /'limit' must be a number of at least 1, got "ten"/);
  check("a non-numeric search limit is an error, not a silent default", t.ok, t.detail);
  t = throws(() => noteSupersede(store, { old_id: "budget-service-now-binds-concretely", new_id: "never-written" }), /no such note\(s\): never-written; nothing was changed/);
  check("supersede with one missing id is an error", t.ok, t.detail);
  check("…and writes nothing to the note that exists", store.get("budget-service-now-binds-concretely").supersededBy.length === 0 && store.get("budget-service-now-binds-concretely").status === "current");
  t = throws(() => noteWrite(store, { title: "x", body: "y", supersedes: ["never-written"] }, rootsFor), /'supersedes' names note\(s\) that don't exist: never-written; nothing was written/);
  check("note_write superseding an id that doesn't exist is an error", t.ok, t.detail);
  check("…and writes nothing", !existsSync(join(dir, "notes", "x.md")));
  for (const bad of ["../escape", "a/b", "a\\b", ".."]) {
    t = throws(() => noteWrite(store, { id: bad, title: "x", body: "y" }, rootsFor), /is not allowed: an id can't contain/);
    check(`note id ${JSON.stringify(bad)} is rejected, not rewritten`, t.ok, t.detail);
  }
  t = throws(() => noteGet(store, { id: "../escape" }, rootsFor), /is not allowed/);
  check("note_get refuses an id that leaves the notes directory", t.ok, t.detail);
  for (const [label, files, pattern] of [
    ["a string instead of a list", "service.php", /'files' must be a list of non-empty strings, got "service\.php"/],
    ["a number in the list", ["service.php", 7], /files\[1\] = 7/],
    ["an empty path", [""], /files\[0\] = ""/],
    ["an object in the list", [{ path: "a.php" }], /files\[0\] = \{"path":"a\.php"\}/],
  ]) {
    t = throws(() => noteWrite(store, { title: "bad files", body: "y", files, repo: "fuel" }, rootsFor), pattern);
    check(`note_write rejects 'files' with ${label}`, t.ok, t.detail);
  }
  check("…and writes nothing", !existsSync(join(dir, "notes", "bad-files.md")));

  console.log("\n-- arguments of the wrong type are errors, never coerced --");
  const obj = { a: 1 };
  const wrongType = [
    ["note_write tags", () => noteWrite(store, { title: "typed args", body: "y", tags: ["ok", obj] }, rootsFor), /every entry in 'tags' must be a non-empty string; tags\[1\] = \{"a":1\}/],
    ["note_write tags as a string", () => noteWrite(store, { title: "typed args", body: "y", tags: "ok" }, rootsFor), /'tags' must be a list of non-empty strings, got "ok"/],
    ["note_write supersedes", () => noteWrite(store, { title: "typed args", body: "y", supersedes: [obj] }, rootsFor), /supersedes\[0\] = \{"a":1\}/],
    ["note_write repo", () => noteWrite(store, { title: "typed args", body: "y", repo: obj }, rootsFor), /'repo' must be a non-empty string, got \{"a":1\}/],
    ["note_write id", () => noteWrite(store, { title: "typed args", body: "y", id: obj }, rootsFor), /'id' must be a non-empty string, got \{"a":1\}/],
    ["note_write blank id", () => noteWrite(store, { title: "typed args", body: "y", id: " " }, rootsFor), /'id' must be a non-empty string, got " "/],
    ["note_write status", () => noteWrite(store, { title: "typed args", body: "y", status: obj }, rootsFor), /'status' must be a non-empty string, got \{"a":1\}/],
    ["note_write title", () => noteWrite(store, { title: obj, body: "y" }, rootsFor), /'title' must be a non-empty string, got \{"a":1\}/],
    ["note_write schema", () => noteWrite(store, { title: "typed args", body: "y", schema: obj, data: {} }, rootsFor), /'schema' must be a non-empty string, got \{"a":1\}/],
    ["note_write verified_on", () => noteWrite(store, { title: "typed args", body: "y", verified_on: obj }, rootsFor), /'verified_on' must be an ISO 8601 date or date-time, got \{"a":1\}/],
    ["note_search query", () => noteSearch(store, { query: obj }, rootsFor), /'query' must be a string, got \{"a":1\}/],
    ["note_search include_retracted", () => noteSearch(store, { query: "x", include_retracted: "false" }, rootsFor), /'include_retracted' must be true or false, got "false"/],
    ["note_search repo", () => noteSearch(store, { query: "x", repo: obj }, rootsFor), /'repo' must be a non-empty string, got \{"a":1\}/],
    ["note_query include_retracted", () => noteQuery(store, { schema: "offset_table", include_retracted: 1 }, rootsFor), /'include_retracted' must be true or false, got 1/],
    ["note_query repo", () => noteQuery(store, { schema: "offset_table", repo: obj }, rootsFor), /'repo' must be a non-empty string, got \{"a":1\}/],
    ["note_query schema", () => noteQuery(store, { schema: obj }, rootsFor), /'schema' must be a non-empty string, got \{"a":1\}/],
  ];
  for (const [label, fn, pattern] of wrongType) {
    t = throws(fn, pattern);
    check(`${label}: an object or wrong type is an error showing the value as JSON`, t.ok && !t.detail.includes("[object Object]"), t.detail);
  }
  check("…and none of them wrote a note", !existsSync(join(dir, "notes", "typed-args.md")));
  t = throws(() => noteWrite(store, { title: "x", body: "y", status: "bogus" }, rootsFor), /'status' must be current\|superseded\|retracted, got "bogus"/);
  check("an unknown status string is named as JSON", t.ok, t.detail);
  check("an empty query is still allowed and lists notes", noteSearch(store, { query: "" }, rootsFor).total > 0);
  for (const bad of ["yesterday", "2026-13-45", 20260914]) {
    t = throws(() => noteWrite(store, { title: "dated", body: "y", verified_on: bad }, rootsFor), /'verified_on' must be an ISO 8601 date or date-time/);
    check(`verified_on ${JSON.stringify(bad)} is an error`, t.ok, t.detail);
  }
  n = noteWrite(store, { title: "dated", body: "y", verified_on: "2026-09-14" }, rootsFor);
  check("an ISO date verified_on is stored as given", store.get(n.written).verifiedOn === "2026-09-14");

  console.log("\n-- note file format --");
  n = noteWrite(store, { title: 'He said "hi", then \\left', body: "Commas, quotes, and backslashes.", tags: ["a,b", 'c"d', "line\nbreak"] }, rootsFor);
  stored = store.get(n.written);
  check("a title with quotes, commas, and backslashes round-trips exactly", stored.title === 'He said "hi", then \\left', JSON.stringify(stored.title));
  check("tags with commas, quotes, and newlines round-trip exactly", JSON.stringify(stored.tags) === JSON.stringify(["a,b", 'c"d', "line\nbreak"]), JSON.stringify(stored.tags));
  check("new notes are written in format 2", readFileSync(join(dir, "notes", `${n.written}.md`), "utf8").startsWith("---\nformat: 2\n"));
  noteWrite(store, { id: "legacy", title: "Written before roots existed", body: "Old note, rewritten." }, rootsFor);
  check("an older-format note is migrated to format 2 when it is next written", readFileSync(join(dir, "notes", "legacy.md"), "utf8").startsWith("---\nformat: 2\n"));
  check("…keeping its stamps and repo", store.get("legacy").files[0]?.path === "Contract.php" && store.get("legacy").repo === "fuel", JSON.stringify(store.get("legacy")));

  const notesDir = join(dir, "notes");
  writeFileSync(join(notesDir, "no-frontmatter.md"), "just text\n");
  writeFileSync(join(notesDir, "bad-status.md"), `---\nformat: 2\nid: "bad-status"\ntitle: "t"\nstatus: "maybe"\ncreated: "2026-01-01"\nverified_on: null\nrepo: null\ntags: []\nsupersedes: []\nsuperseded_by: []\nfiles:\n---\n\nbody\n`);
  const legacyNote = (fields) => {
    const lines = { id: '"old"', title: '"Old note"', status: "current", created: '"2026-01-01T00:00:00Z"', verified_on: "null", repo: "null", tags: "[]", supersedes: "[]", superseded_by: "[]", ...fields };
    const files = lines.files ?? "";
    delete lines.files;
    return `---\n${Object.entries(lines).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join("\n")}\nfiles:\n${files}---\n\nbody\n`;
  };
  writeFileSync(join(notesDir, "legacy-bad-status.md"), legacyNote({ status: "maybe" }));
  const legacyRejects = {
    "legacy-no-status.md": [{ status: undefined }, /frontmatter has no "status"/],
    "legacy-no-title.md": [{ title: undefined }, /frontmatter has no "title"/],
    "legacy-no-created.md": [{ created: undefined }, /frontmatter has no "created"/],
    "legacy-no-id.md": [{ id: undefined }, /frontmatter has no "id"/],
    "legacy-unquoted-title.md": [{ title: "Old note" }, /"title": expected a double-quoted string/],
    "legacy-bad-list.md": [{ tags: '"a", "b"' }, /"tags" must be a \[\.\.\] list/],
    "legacy-list-no-comma.md": [{ tags: '["a" "b"]' }, /"tags" needs a comma between items/],
    "legacy-stamp-no-sha.md": [{ files: '  - path: "a.php"\n    at: "2026-01-01T00:00:00Z"\n' }, /files\[0\] has no "sha256"/],
    "legacy-unknown-key.md": [{ owner: '"me"' }, /unknown frontmatter key "owner"/],
  };
  for (const [name, [fields]] of Object.entries(legacyRejects)) writeFileSync(join(notesDir, name), legacyNote(fields));
  writeFileSync(join(notesDir, "legacy-quoted.md"), legacyNote({ id: '"legacy-quoted"', title: '"He said \\"hi\\", twice"', tags: '["a,b", "c\\"d", ""]', files: '  - path: "x, y.php"\n    root: "~/pkg"\n    sha256: "missing"\n    at: "2026-01-01T00:00:00Z"\n' }));
  writeFileSync(join(notesDir, "garbage-line.md"), `---\nformat: 2\nid: "garbage-line"\ntitle: "t"\nstatus: "current"\ncreated: "2026-01-01"\nverified_on: null\nrepo: null\ntags: []\nsupersedes: []\nsuperseded_by: []\nthis is not a key\nfiles:\n---\n\nbody\n`);
  writeFileSync(join(notesDir, "twice.md"), `---\nformat: 2\nid: "twice"\ntitle: "t"\ntitle: "u"\nstatus: "current"\ncreated: "2026-01-01"\nverified_on: null\nrepo: null\ntags: []\nsupersedes: []\nsuperseded_by: []\nfiles:\n---\n\nbody\n`);
  writeFileSync(join(notesDir, "half-typed.md"), `---\nformat: 2\nid: "half-typed"\ntitle: "t"\nstatus: "current"\ncreated: "2026-01-01"\nverified_on: null\nrepo: null\ntags: []\nsupersedes: []\nsuperseded_by: []\nschema: "offset_table"\nfiles:\n---\n\nbody\n`);
  writeFileSync(join(notesDir, "bad-json.md"), `---\nformat: 2\nid: bad-json\ntitle: "t"\nstatus: "current"\ncreated: "2026-01-01"\nverified_on: null\nrepo: null\ntags: []\nsupersedes: []\nsuperseded_by: []\nfiles:\n---\n\nbody\n`);
  writeFileSync(join(notesDir, "orphan.json"), "{}\n");
  writeFileSync(join(notesDir, "dated.json"), "{}\n");
  rescan(store);
  const malformed = noteSearch(store, { query: "anything" }, rootsFor).malformedFiles;
  const reason = (file) => malformed.find((m) => m.file === file)?.error ?? "";
  check("a note with no frontmatter is reported, not skipped", /no frontmatter block/.test(reason("no-frontmatter.md")), JSON.stringify(malformed));
  check("an unknown status is reported", /unknown status "maybe"/.test(reason("bad-status.md")), JSON.stringify(malformed));
  check("…in the older format too", /unknown status "maybe"/.test(reason("legacy-bad-status.md")), JSON.stringify(malformed));
  for (const [name, [, pattern]] of Object.entries(legacyRejects)) {
    check(`an older-format note is reported, never defaulted: ${name}`, pattern.test(reason(name)), reason(name) || JSON.stringify(malformed));
  }
  const quoted = store.get("legacy-quoted");
  check("an older-format note reads quoted commas, escaped quotes, and empty items exactly",
    quoted.title === 'He said "hi", twice' && JSON.stringify(quoted.tags) === JSON.stringify(["a,b", 'c"d', ""]) && quoted.files[0].path === "x, y.php" && quoted.files[0].root === "~/pkg",
    JSON.stringify(quoted));
  check("a frontmatter line that isn't a key is reported", /unrecognized frontmatter line: this is not a key/.test(reason("garbage-line.md")), JSON.stringify(malformed));
  check("a frontmatter key given twice is reported", /frontmatter has "title" twice/.test(reason("twice.md")), JSON.stringify(malformed));
  check("a note with only some of the typed keys is reported", /needs schema, schema_version, and data_sha256 together; it has only schema/.test(reason("half-typed.md")), JSON.stringify(malformed));
  check("a frontmatter value that isn't JSON is reported, naming the key", /"id" is not valid JSON/.test(reason("bad-json.md")), JSON.stringify(malformed));
  check("a data file with no note is reported", /a data file with no note orphan\.md/.test(reason("orphan.json")), JSON.stringify(malformed));
  check("a data file beside an untyped note is reported", /beside an untyped note dated\.md/.test(reason("dated.json")), JSON.stringify(malformed));
  t = throws(() => noteGet(store, { id: "bad-status" }, rootsFor), /unknown status "maybe"/);
  check("note_get on a malformed note is an error, not 'not found'", t.ok, t.detail);
  for (const f of ["no-frontmatter.md", "bad-status.md", "legacy-bad-status.md", "bad-json.md", "orphan.json", "dated.json", ...Object.keys(legacyRejects), "legacy-quoted.md", "garbage-line.md", "twice.md", "half-typed.md"]) rmSync(join(notesDir, f));
  rescan(store);
  check("removing them clears the report", noteSearch(store, { query: "anything" }, rootsFor).malformedFiles.length === 0, JSON.stringify(store.malformed()));
  store.close();

  await typedNotes();
} finally {
  for (const d of [dir, repo, pkg, other]) rmSync(d, { recursive: true, force: true });
}
console.log(failed === 0 ? "\nall note checks passed" : `\n${failed} note check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
