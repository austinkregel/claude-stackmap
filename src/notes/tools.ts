import { randomUUID } from "node:crypto";
import { checkId, NoteStore, type Note, type NoteStatus, type TypedRecord } from "./store.js";
import { scoreNotes, type RootsFor } from "./search.js";
import { checkRecord, NOTE_SCHEMAS, noteSchema, schemaJson, validateForWrite } from "./schemas.js";
import { matches, parseFilter } from "./query.js";
import { booleanArg, countArg, show, stringArg, stringListArg } from "../args.js";

const STATUSES: NoteStatus[] = ["current", "superseded", "retracted"];

function slug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return base || `note-${randomUUID().slice(0, 8)}`;
}

const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function driftCaveat(changed: number): string | null {
  return changed ? `This conclusion predates ${changed} change(s) to the file(s) it describes, or they can't be checked. Re-verify before relying on it.` : null;
}

/** Stamps a note's files against the roots of the project its (validated) `repo` names. */
export function noteWrite(store: NoteStore, args: any, rootsFor: RootsFor) {
  const T = "note_write";
  const title = stringArg(T, "title", args.title);
  const body = stringArg(T, "body", args.body);
  if (title === undefined) throw new Error("note_write requires 'title'.");
  if (body === undefined) throw new Error("note_write requires 'body'.");
  const status = stringArg(T, "status", args.status) ?? "current";
  if (!STATUSES.includes(status as NoteStatus)) {
    throw new Error(`note_write: 'status' must be ${STATUSES.join("|")}, got ${show(status)}.`);
  }
  const verifiedOn: string | undefined = args.verified_on;
  if (verifiedOn !== undefined && (typeof verifiedOn !== "string" || !ISO.test(verifiedOn) || Number.isNaN(Date.parse(verifiedOn)))) {
    throw new Error(`note_write: 'verified_on' must be an ISO 8601 date or date-time, got ${show(verifiedOn)}.`);
  }
  const files = stringListArg(T, "files", args.files);
  const tags = stringListArg(T, "tags", args.tags);
  const supersedesArg = stringListArg(T, "supersedes", args.supersedes);
  const repoArg = stringArg(T, "repo", args.repo);
  const idArg = stringArg(T, "id", args.id);
  const schemaArg = stringArg(T, "schema", args.schema);
  if ((schemaArg === undefined) !== (args.data === undefined)) {
    throw new Error("note_write: 'schema' and 'data' go together — pass both for a typed note, or neither.");
  }
  const id = checkId(idArg !== undefined ? idArg.trim() : slug(title));
  const existing = store.get(id);

  let record: TypedRecord | null = existing?.record ?? null;
  if (schemaArg !== undefined) {
    const schema = validateForWrite(schemaArg, args.data);
    if (existing?.record && existing.record.schema !== schema.name) {
      throw new Error(`note_write: note "${id}" is a ${existing.record.schema} record; changing it to ${schema.name} is not allowed. Write a new note and supersede this one.`);
    }
    record = { schema: schema.name, version: schema.version, data: args.data };
  }

  const supersedes = supersedesArg ?? existing?.supersedes ?? [];
  const unknown = supersedes.filter((old) => old !== id && !store.exists(checkId(old)));
  if (unknown.length) throw new Error(`note_write: 'supersedes' names note(s) that don't exist: ${unknown.join(", ")}; nothing was written.`);

  const repo = repoArg ?? existing?.repo ?? null;
  const note: Note = {
    id,
    title: title.trim(),
    status: status as NoteStatus,
    created: existing?.created ?? new Date().toISOString(),
    verifiedOn: verifiedOn ?? new Date().toISOString(),
    tags: tags ?? existing?.tags ?? [],
    repo,
    supersedes,
    supersededBy: existing?.supersededBy ?? [],
    files: files?.length ? store.stamp(files, rootsFor(repo)) : (existing?.files ?? []),
    body: body.trim(),
    record,
  };
  store.write(note);

  const linked: string[] = [];
  for (const old of note.supersedes) {
    if (old === id) continue;
    const r = store.supersede(old, id);
    linked.push(...r.updated.filter((u) => u !== id));
  }
  return {
    written: id,
    path: `${store.directory}/${id}.md`,
    ...(record ? { dataPath: `${store.directory}/${id}.json`, schema: record.schema, schemaVersion: record.version } : {}),
    replaced: Boolean(existing),
    stampedFiles: note.files.length,
    supersededNotes: linked,
    note: "Stamped files record the content hash at write time, so a later search can report whether this conclusion predates changes to the code it describes.",
  };
}

export function noteSearch(store: NoteStore, args: any, rootsFor: RootsFor) {
  const T = "note_search";
  const limit = countArg(T, "limit", args.limit, 10, 1);
  const scored = scoreNotes(store, stringArg(T, "query", args.query, { allowBlank: true }) ?? "", rootsFor, {
    includeRetracted: booleanArg(T, "include_retracted", args.include_retracted, false),
    repo: stringArg(T, "repo", args.repo) ?? null,
  });
  const malformed = store.malformed();
  return {
    notesDir: store.directory,
    total: scored.length,
    returned: Math.min(limit, scored.length),
    results: scored.slice(0, limit).map((s) => ({
      id: s.note.id,
      title: s.note.title,
      status: s.note.status,
      score: Number(s.score.toFixed(3)),
      tags: s.note.tags,
      repo: s.note.repo,
      schema: s.note.record?.schema ?? null,
      verifiedOn: s.note.verifiedOn,
      caveat: s.caveat,
      drift: s.drift,
      excerpt: s.note.body.slice(0, 400),
    })),
    malformedFiles: malformed,
  };
}

export function noteGet(store: NoteStore, args: any, rootsFor: RootsFor) {
  if (typeof args.id !== "string" || !args.id.trim()) throw new Error("note_get requires 'id'.");
  const note = store.get(args.id.trim());
  if (!note) return { found: false, id: args.id, notesDir: store.directory };
  const drift = store.drift(note, rootsFor(note.repo));
  return {
    found: true,
    ...note,
    ...(note.record ? { validation: checkRecord(note.record.schema, note.record.version, note.record.data) } : {}),
    drift,
    caveat: driftCaveat(drift.filter((d) => d.state !== "unchanged").length),
  };
}

export function noteSupersede(store: NoteStore, args: any) {
  if (typeof args.old_id !== "string" || typeof args.new_id !== "string") {
    throw new Error("note_supersede requires 'old_id' and 'new_id'.");
  }
  const r = store.supersede(args.old_id.trim(), args.new_id.trim());
  if (r.missing.length) throw new Error(`note_supersede: no such note(s): ${r.missing.join(", ")}; nothing was changed.`);
  return { ...r, note: "The superseded note is kept at reduced standing rather than deleted — the earlier conclusion is still evidence of what was believed and why." };
}

/**
 * Typed records of one schema that match a filter, returned exactly as stored, sorted by id and paged.
 * Statuses follow note_search: current and superseded, retracted only when asked. Records that no
 * longer validate, and files that can't be read as notes, are listed separately, never dropped.
 */
export function noteQuery(store: NoteStore, args: any, rootsFor: RootsFor) {
  const T = "note_query";
  const schemaName = stringArg(T, "schema", args.schema);
  if (schemaName === undefined) throw new Error("note_query requires 'schema'.");
  const schema = noteSchema(schemaName);
  const filter = parseFilter(args.filter, schemaJson(schema));
  const limit = countArg(T, "limit", args.limit, 100, 1);
  const offset = countArg(T, "offset", args.offset, 0, 0);
  const includeRetracted = booleanArg(T, "include_retracted", args.include_retracted, false);
  const repo = stringArg(T, "repo", args.repo);

  const invalid: Array<{ id: string; schema: string; version: number; reason: string; message: string; issues: Array<{ path: string; message: string }> }> = [];
  const hits: Note[] = [];
  let excludedRetracted = 0;
  for (const note of store.list()) {
    if (!note.record) continue;
    if (repo && note.repo && note.repo !== repo) continue;
    const check = checkRecord(note.record.schema, note.record.version, note.record.data);
    if (note.record.schema !== schema.name) {
      if (!check.valid && check.reason === "unknown-schema") invalid.push({ id: note.id, schema: note.record.schema, version: note.record.version, reason: check.reason, message: check.message, issues: check.issues });
      continue;
    }
    if (!check.valid) {
      invalid.push({ id: note.id, schema: note.record.schema, version: note.record.version, reason: check.reason, message: check.message, issues: check.issues });
      continue;
    }
    if (!matches(note.record.data, filter)) continue;
    if (note.status === "retracted" && !includeRetracted) {
      excludedRetracted++;
      continue;
    }
    hits.push(note);
  }
  hits.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const page = hits.slice(offset, offset + limit);
  return {
    notesDir: store.directory,
    schema: schema.name,
    schemaVersion: schema.version,
    matched: hits.length,
    excludedRetracted,
    offset,
    limit,
    returned: page.length,
    records: page.map((note) => {
      const drift = store.drift(note, rootsFor(note.repo));
      return {
        id: note.id,
        title: note.title,
        status: note.status,
        repo: note.repo,
        verifiedOn: note.verifiedOn,
        supersededBy: note.supersededBy,
        drift,
        caveat: driftCaveat(drift.filter((d) => d.state !== "unchanged").length),
        data: note.record!.data,
      };
    }),
    invalid,
    malformedFiles: store.malformed(),
  };
}

/** The schemas a typed note can use, with the JSON Schema each record must satisfy. */
export function noteSchemas() {
  return {
    schemas: NOTE_SCHEMAS.map((s) => ({ name: s.name, version: s.version, description: s.description, jsonSchema: schemaJson(s) })),
  };
}
