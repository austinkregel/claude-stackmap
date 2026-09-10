import { randomUUID } from "node:crypto";
import { NoteStore, type Note } from "./store.js";
import { scoreNotes } from "./search.js";

function slug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return base || `note-${randomUUID().slice(0, 8)}`;
}

export function noteWrite(store: NoteStore, args: any, repoRoot: string | null) {
  if (typeof args.title !== "string" || !args.title.trim()) throw new Error("note_write requires 'title'.");
  if (typeof args.body !== "string" || !args.body.trim()) throw new Error("note_write requires 'body'.");
  const status = args.status ?? "current";
  if (!["current", "superseded", "retracted"].includes(status)) {
    throw new Error(`note_write: status must be current|superseded|retracted, got "${status}".`);
  }
  const id = (typeof args.id === "string" && args.id.trim()) ? args.id.trim() : slug(args.title);
  const existing = store.get(id);
  const files = Array.isArray(args.files) ? args.files.filter((f: unknown) => typeof f === "string") : [];

  const note: Note = {
    id,
    title: args.title.trim(),
    status,
    created: existing?.created ?? new Date().toISOString(),
    verifiedOn: args.verified_on ?? new Date().toISOString(),
    tags: Array.isArray(args.tags) ? args.tags.map(String) : (existing?.tags ?? []),
    repo: args.repo ?? existing?.repo ?? null,
    supersedes: Array.isArray(args.supersedes) ? args.supersedes.map(String) : (existing?.supersedes ?? []),
    supersededBy: existing?.supersededBy ?? [],
    files: files.length ? store.stamp(files, repoRoot) : (existing?.files ?? []),
    body: args.body.trim(),
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
    replaced: Boolean(existing),
    stampedFiles: note.files.length,
    supersededNotes: linked,
    note: "Stamped files record the content hash at write time, so a later search can report whether this conclusion predates changes to the code it describes.",
  };
}

export function noteSearch(store: NoteStore, args: any, repoRoot: string | null) {
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.trunc(args.limit)) : 10;
  const scored = scoreNotes(store, String(args.query ?? ""), repoRoot, {
    includeRetracted: Boolean(args.include_retracted),
    repo: args.repo ?? null,
  });
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
      verifiedOn: s.note.verifiedOn,
      caveat: s.caveat,
      drift: s.drift,
      excerpt: s.note.body.slice(0, 400),
    })),
  };
}

export function noteGet(store: NoteStore, args: any, repoRoot: string | null) {
  if (typeof args.id !== "string" || !args.id.trim()) throw new Error("note_get requires 'id'.");
  const note = store.get(args.id.trim());
  if (!note) return { found: false, id: args.id, notesDir: store.directory };
  const drift = store.drift(note, repoRoot);
  const changed = drift.filter((d) => d.state !== "unchanged");
  return {
    found: true, ...note, drift,
    caveat: changed.length
      ? `This conclusion predates ${changed.length} change(s) to the file(s) it describes. Re-verify before relying on it.`
      : null,
  };
}

export function noteSupersede(store: NoteStore, args: any) {
  if (typeof args.old_id !== "string" || typeof args.new_id !== "string") {
    throw new Error("note_supersede requires 'old_id' and 'new_id'.");
  }
  const r = store.supersede(args.old_id.trim(), args.new_id.trim());
  if (r.missing.length) throw new Error(`note_supersede: no such note(s): ${r.missing.join(", ")}`);
  return { ...r, note: "The superseded note is kept at reduced standing rather than deleted — the earlier conclusion is still evidence of what was believed and why." };
}
