import { randomUUID } from "node:crypto";
import { checkId, NoteStore, type Note, type RootsLookup, type TypedRecord } from "./store.js";
import { scoreNotes, type RootsFor } from "./search.js";
import { checkRecord, NOTE_SCHEMAS, noteSchema, schemaJson, validateForWrite } from "./schemas.js";
import { matches, parseFilter } from "./query.js";
import { countArg } from "../args.js";

function slug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return base || `note-${randomUUID().slice(0, 8)}`;
}

const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function driftCaveat(changed: number): string | null {
  return changed ? `This conclusion predates ${changed} change(s) to the file(s) it describes, or they can't be checked. Re-verify before relying on it.` : null;
}

export function noteWrite(store: NoteStore, args: any, stampRoots: RootsLookup) {
  if (typeof args.title !== "string" || !args.title.trim()) throw new Error("note_write requires 'title'.");
  if (typeof args.body !== "string" || !args.body.trim()) throw new Error("note_write requires 'body'.");
  const status = args.status ?? "current";
  if (!["current", "superseded", "retracted"].includes(status)) {
    throw new Error(`note_write: status must be current|superseded|retracted, got "${status}".`);
  }
  if (args.verified_on !== undefined && (typeof args.verified_on !== "string" || !ISO.test(args.verified_on) || Number.isNaN(Date.parse(args.verified_on)))) {
    throw new Error(`note_write: 'verified_on' must be an ISO 8601 date or date-time, got ${JSON.stringify(args.verified_on)}.`);
  }
  if ((args.schema === undefined) !== (args.data === undefined)) {
    throw new Error("note_write: 'schema' and 'data' go together — pass both for a typed note, or neither.");
  }
  const id = checkId(typeof args.id === "string" && args.id.trim() ? args.id.trim() : slug(args.title));
  const existing = store.get(id);

  let record: TypedRecord | null = existing?.record ?? null;
  if (args.schema !== undefined) {
    if (typeof args.schema !== "string") throw new Error("note_write: 'schema' must be a schema name.");
    const schema = validateForWrite(args.schema, args.data);
    if (existing?.record && existing.record.schema !== schema.name) {
      throw new Error(`note_write: note "${id}" is a ${existing.record.schema} record; changing it to ${schema.name} is not allowed. Write a new note and supersede this one.`);
    }
    record = { schema: schema.name, version: schema.version, data: args.data };
  }

  const supersedes: string[] = Array.isArray(args.supersedes) ? args.supersedes.map(String) : (existing?.supersedes ?? []);
  const unknown = supersedes.filter((old) => old !== id && !store.exists(checkId(old)));
  if (unknown.length) throw new Error(`note_write: 'supersedes' names note(s) that don't exist: ${unknown.join(", ")}; nothing was written.`);

  const files = Array.isArray(args.files) ? args.files.filter((f: unknown) => typeof f === "string") : [];
  const note: Note = {
    id,
    title: args.title.trim(),
    status,
    created: existing?.created ?? new Date().toISOString(),
    verifiedOn: args.verified_on ?? new Date().toISOString(),
    tags: Array.isArray(args.tags) ? args.tags.map(String) : (existing?.tags ?? []),
    repo: args.repo ?? existing?.repo ?? null,
    supersedes,
    supersededBy: existing?.supersededBy ?? [],
    files: files.length ? store.stamp(files, stampRoots) : (existing?.files ?? []),
    body: args.body.trim(),
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
  const limit = countArg("note_search", "limit", args.limit, 10, 1);
  const scored = scoreNotes(store, String(args.query ?? ""), rootsFor, {
    includeRetracted: Boolean(args.include_retracted),
    repo: args.repo ?? null,
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
  if (typeof args.schema !== "string") throw new Error("note_query requires 'schema'.");
  const schema = noteSchema(args.schema);
  const filter = parseFilter(args.filter, schemaJson(schema));
  const limit = countArg("note_query", "limit", args.limit, 100, 1);
  const offset = countArg("note_query", "offset", args.offset, 0, 0);
  const includeRetracted = Boolean(args.include_retracted);

  const invalid: Array<{ id: string; schema: string; version: number; reason: string; message: string; issues: Array<{ path: string; message: string }> }> = [];
  const hits: Note[] = [];
  let excludedRetracted = 0;
  for (const note of store.list()) {
    if (!note.record) continue;
    if (args.repo && note.repo && note.repo !== args.repo) continue;
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
