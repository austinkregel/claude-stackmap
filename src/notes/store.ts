import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, realpathSync, renameSync, watch, type FSWatcher } from "node:fs";
import { join, isAbsolute, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import type { IndexRoot } from "../adapters/types.js";

export type NoteStatus = "current" | "superseded" | "retracted";
const STATUSES: NoteStatus[] = ["current", "superseded", "retracted"];

export interface FileStamp {
  /** Relative to the root named by `root` (the project's main root when absent), or absolute. */
  path: string;
  /** The alias, as written in the config, whose root `path` is relative to. Absent: the main root. */
  root?: string;
  sha256: string;
  /** ISO timestamp when the stamp was taken. */
  at: string;
}

/** A project's roots for resolving stamps, or why there are none. */
export type RootsLookup = { roots: IndexRoot[]; reason?: undefined } | { roots: null; reason: string };

/** A typed note's structured data, stored beside the note in `<id>.json`. */
export interface TypedRecord {
  schema: string;
  version: number;
  data: unknown;
}

export interface Note {
  id: string;
  title: string;
  status: NoteStatus;
  created: string;
  verifiedOn: string | null;
  tags: string[];
  repo: string | null;
  supersedes: string[];
  supersededBy: string[];
  /** Content hashes of the files this conclusion was about, taken when it was written. */
  files: FileStamp[];
  body: string;
  /** Present on typed notes. */
  record: TypedRecord | null;
}

/** Drift between what a note was written about and what those files contain now. */
export interface Drift {
  path: string;
  root?: string;
  /** `unresolved`: the stamp's project or alias can't be located now, so the file couldn't be checked. */
  state: "unchanged" | "changed" | "missing" | "unresolved";
  reason?: string;
}

/** A file in the notes directory that couldn't be read as a note, and why. Reported, never skipped. */
export interface MalformedFile {
  file: string;
  error: string;
}

/** Note files are named by id; an id that could leave the notes directory is refused. */
export function checkId(id: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0")) {
    throw new Error(`note id "${id}" is not allowed: an id can't contain "/", "\\", "..", or be empty.`);
  }
  return id;
}

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const q = (v: unknown) => JSON.stringify(v);

/**
 * Format 2 frontmatter: every value is JSON, so quotes, backslashes, commas, and newlines in a title or
 * tag round-trip exactly. Typed notes also name their schema and the sha256 of their data file.
 */
function serialize(n: Note, dataHash: string | null): string {
  const lines = [
    "---",
    "format: 2",
    `id: ${q(n.id)}`,
    `title: ${q(n.title)}`,
    `status: ${q(n.status)}`,
    `created: ${q(n.created)}`,
    `verified_on: ${q(n.verifiedOn)}`,
    `repo: ${q(n.repo)}`,
    `tags: ${q(n.tags)}`,
    `supersedes: ${q(n.supersedes)}`,
    `superseded_by: ${q(n.supersededBy)}`,
  ];
  if (n.record) lines.push(`schema: ${q(n.record.schema)}`, `schema_version: ${q(n.record.version)}`, `data_sha256: ${q(dataHash)}`);
  lines.push("files:");
  for (const f of n.files) {
    lines.push(`  - path: ${q(f.path)}`);
    if (f.root) lines.push(`    root: ${q(f.root)}`);
    lines.push(`    sha256: ${q(f.sha256)}`, `    at: ${q(f.at)}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n\n${n.body.trim()}\n`;
}

interface Parsed {
  note: Omit<Note, "record">;
  typed: { schema: string; version: number; dataSha256: string } | null;
}

/** Split frontmatter into scalar lines and file entries, without interpreting values. */
function frontmatter(raw: string, file: string): { scalars: Map<string, string>; files: Array<Map<string, string>>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${file}: no frontmatter block (a note starts with --- and a closing ---)`);
  const scalars = new Map<string, string>();
  const files: Array<Map<string, string>> = [];
  let inFiles = false;
  for (const line of m[1]!.split("\n")) {
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (inFiles) {
      const item = /^\s*-\s*path:\s*(.+)$/.exec(line);
      if (item) {
        files.push(new Map([["path", item[1]!]]));
        continue;
      }
      const kv = /^\s+(root|sha256|at):\s*(.+)$/.exec(line);
      if (kv) {
        if (!files.length) throw new Error(`${file}: a "${kv[1]}" line comes before any "- path:" under files`);
        files[files.length - 1]!.set(kv[1]!, kv[2]!);
        continue;
      }
      if (/^\S/.test(line)) inFiles = false;
      else if (line.trim() !== "") throw new Error(`${file}: unrecognized line under files: ${line.trim()}`);
      else continue;
    }
    const kv = /^([a-z_0-9]+):\s*(.*)$/.exec(line);
    if (kv) scalars.set(kv[1]!, kv[2]!);
  }
  return { scalars, files, body: (m[2] ?? "").trim() };
}

function parseFormat2(raw: string, file: string): Parsed {
  const { scalars, files, body } = frontmatter(raw, file);
  const value = (key: string, required = true): unknown => {
    const text = scalars.get(key);
    if (text === undefined) {
      if (required) throw new Error(`${file}: frontmatter has no "${key}"`);
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`${file}: frontmatter "${key}" is not valid JSON (${(err as Error).message})`);
    }
  };
  const str = (key: string) => {
    const v = value(key);
    if (typeof v !== "string") throw new Error(`${file}: frontmatter "${key}" must be a string`);
    return v;
  };
  const strOrNull = (key: string) => {
    const v = value(key);
    if (v !== null && typeof v !== "string") throw new Error(`${file}: frontmatter "${key}" must be a string or null`);
    return v as string | null;
  };
  const list = (key: string) => {
    const v = value(key);
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`${file}: frontmatter "${key}" must be a list of strings`);
    return v as string[];
  };
  const status = str("status");
  if (!STATUSES.includes(status as NoteStatus)) throw new Error(`${file}: unknown status "${status}" (expected ${STATUSES.join(", ")})`);
  const stamps: FileStamp[] = files.map((f, i) => {
    const get = (k: string) => {
      const text = f.get(k);
      if (text === undefined) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        throw new Error(`${file}: files[${i}].${k} is not valid JSON (${(err as Error).message})`);
      }
    };
    const path = get("path");
    const sha = get("sha256");
    const at = get("at");
    const root = get("root");
    if (typeof path !== "string" || typeof sha !== "string" || typeof at !== "string" || (root !== undefined && typeof root !== "string")) {
      throw new Error(`${file}: files[${i}] needs string path, sha256, and at (and root, when present)`);
    }
    return { path, ...(root !== undefined ? { root } : {}), sha256: sha, at };
  });
  let typed: Parsed["typed"] = null;
  if (scalars.has("schema")) {
    const version = value("schema_version");
    if (typeof version !== "number" || !Number.isInteger(version)) throw new Error(`${file}: frontmatter "schema_version" must be an integer`);
    typed = { schema: str("schema"), version, dataSha256: str("data_sha256") };
  }
  return {
    note: {
      id: str("id"),
      title: str("title"),
      status: status as NoteStatus,
      created: str("created"),
      verifiedOn: strOrNull("verified_on"),
      tags: list("tags"),
      repo: strOrNull("repo"),
      supersedes: list("supersedes"),
      supersededBy: list("superseded_by"),
      files: stamps,
      body,
    },
    typed,
  };
}

/** The format written before format 2: only `"` was escaped, lists were split on commas. Read so old notes still work; rewritten as format 2 on their next write. */
function parseLegacy(raw: string, file: string, fallbackId: string): Parsed {
  const { scalars, files, body } = frontmatter(raw, file);
  const unquote = (v: string | undefined) => {
    const t = (v ?? "").trim();
    if (t === "null" || t === "") return "";
    return t.replace(/^"(.*)"$/s, "$1").replace(/\\"/g, '"');
  };
  const list = (v: string | undefined) => {
    const t = (v ?? "").trim();
    if (!t.startsWith("[")) return [];
    return t.slice(1, -1).split(",").map((s) => unquote(s)).filter(Boolean);
  };
  const status = unquote(scalars.get("status")) || "current";
  if (!STATUSES.includes(status as NoteStatus)) throw new Error(`${file}: unknown status "${status}" (expected ${STATUSES.join(", ")})`);
  const stamps: FileStamp[] = [];
  for (const f of files) {
    if (!f.get("sha256")) continue;
    const root = f.get("root");
    stamps.push({ path: unquote(f.get("path")), ...(root !== undefined ? { root: unquote(root) } : {}), sha256: unquote(f.get("sha256")), at: unquote(f.get("at")) });
  }
  return {
    note: {
      id: unquote(scalars.get("id")) || fallbackId,
      title: unquote(scalars.get("title")) || fallbackId,
      status: status as NoteStatus,
      created: unquote(scalars.get("created")) || new Date(0).toISOString(),
      verifiedOn: unquote(scalars.get("verified_on")) || null,
      tags: list(scalars.get("tags")),
      repo: unquote(scalars.get("repo")) || null,
      supersedes: list(scalars.get("supersedes")),
      supersededBy: list(scalars.get("superseded_by")),
      files: stamps,
      body,
    },
    typed: null,
  };
}

function parseNote(raw: string, file: string, fallbackId: string): Parsed {
  return /^---\nformat: 2\n/.test(raw) ? parseFormat2(raw, file) : parseLegacy(raw, file, fallbackId);
}

const hashCache = new Map<string, { key: string; hash: string }>();

export function hashFile(abs: string): string | null {
  let key: string;
  try {
    const st = statSync(abs);
    key = `${st.mtimeMs}:${st.size}`;
  } catch { return null; }
  const hit = hashCache.get(abs);
  if (hit && hit.key === key) return hit.hash;
  try {
    const hash = createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 16);
    hashCache.set(abs, { key, hash });
    return hash;
  } catch { return null; }
}

const statKey = (path: string): string => {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "none";
  }
};

/** Write through a temporary file and a rename, so a reader never sees a half-written file. */
function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

export class NoteStore {
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private pathFor(id: string) { return join(this.dir, `${checkId(id)}.md`); }
  private dataPathFor(id: string) { return join(this.dir, `${checkId(id)}.json`); }

  /** Read one note (and its data file, when typed) from disk. Throws, naming the file, when it can't be read as a note. */
  private load(name: string): Note {
    const id = name.replace(/\.md$/, "");
    const mdPath = join(this.dir, name);
    const parsed = parseNote(readFileSync(mdPath, "utf8"), name, id);
    if (!parsed.typed) return { ...parsed.note, record: null };
    const dataName = `${id}.json`;
    const dataPath = join(this.dir, dataName);
    if (!existsSync(dataPath)) throw new Error(`${name}: a typed note (${parsed.typed.schema}) whose data file ${dataName} is missing`);
    const bytes = readFileSync(dataPath);
    if (sha256(bytes) !== parsed.typed.dataSha256) {
      throw new Error(`${name}: its data file ${dataName} doesn't match the hash the note recorded (edited separately, or a write was interrupted)`);
    }
    let stored: unknown;
    try {
      stored = JSON.parse(bytes.toString("utf8"));
    } catch (err) {
      throw new Error(`${dataName}: not valid JSON (${(err as Error).message})`);
    }
    const s = stored as Partial<TypedRecord> | null;
    if (!s || typeof s !== "object" || typeof s.schema !== "string" || typeof s.version !== "number" || !("data" in s)) {
      throw new Error(`${dataName}: expected {"schema", "version", "data"}`);
    }
    if (s.schema !== parsed.typed.schema || s.version !== parsed.typed.version) {
      throw new Error(`${dataName}: holds ${s.schema}@${s.version}, but ${name} says ${parsed.typed.schema}@${parsed.typed.version}`);
    }
    return { ...parsed.note, record: { schema: s.schema, version: s.version, data: s.data } };
  }

  /** Parsed-note cache keyed by filename, invalidated per-file by the note's and its data file's mtime:size. */
  private cache = new Map<string, { key: string; note: Note }>();

  /**
   * Directory listing cache, marked dirty by a watcher. `fs.watch` can miss events, so a
   * wall-clock backstop forces a rescan regardless: the watcher is never the correctness boundary.
   */
  private listCache: Note[] | null = null;
  private malformedCache: MalformedFile[] = [];
  private dirty = true;
  private lastScan = 0;
  private watcher: FSWatcher | null = null;
  private static readonly BACKSTOP_MS = 2000;

  private ensureWatcher() {
    if (this.watcher) return;
    try {
      // persistent:false so a watcher never keeps the process alive.
      this.watcher = watch(this.dir, { persistent: false }, () => { this.dirty = true; });
    } catch { this.watcher = null; } // an unwatchable dir only means every list() rescans, because dirty stays true
  }

  /** Stop watching the directory; a store that is replaced must close its watcher. */
  close() {
    this.watcher?.close();
    this.watcher = null;
  }

  list(): Note[] {
    this.ensureWatcher();
    const fresh = !this.dirty && this.listCache !== null && this.watcher !== null && Date.now() - this.lastScan < NoteStore.BACKSTOP_MS;
    if (fresh) return this.listCache!;
    const scanned = this.scan();
    this.listCache = scanned.notes;
    this.malformedCache = scanned.malformed;
    this.dirty = false;
    this.lastScan = Date.now();
    return scanned.notes;
  }

  /** Files in the notes directory that could not be read as notes, as of the last list(). */
  malformed(): MalformedFile[] {
    this.list();
    return this.malformedCache;
  }

  private scan(): { notes: Note[]; malformed: MalformedFile[] } {
    const notes: Note[] = [];
    const malformed: MalformedFile[] = [];
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (err) {
      return { notes, malformed: [{ file: this.dir, error: `the notes directory can't be read: ${(err as Error).message}` }] };
    }
    const md = names.filter((f) => f.endsWith(".md"));
    const live = new Set(md);
    for (const stale of [...this.cache.keys()]) if (!live.has(stale)) this.cache.delete(stale);

    for (const name of md) {
      const key = `${statKey(join(this.dir, name))}|${statKey(join(this.dir, name.replace(/\.md$/, ".json")))}`;
      const hit = this.cache.get(name);
      if (hit && hit.key === key) {
        notes.push(hit.note);
        continue;
      }
      try {
        const note = this.load(name);
        this.cache.set(name, { key, note });
        notes.push(note);
      } catch (err) {
        this.cache.delete(name);
        malformed.push({ file: name, error: (err as Error).message });
      }
    }
    for (const name of names.filter((f) => f.endsWith(".json"))) {
      const noteName = name.replace(/\.json$/, ".md");
      if (!live.has(noteName)) malformed.push({ file: name, error: `a data file with no note ${noteName}` });
      else if (!malformed.some((m) => m.file === noteName) && notes.find((n) => `${n.id}.md` === noteName)?.record === null) {
        malformed.push({ file: name, error: `a data file beside an untyped note ${noteName}` });
      }
    }
    return { notes, malformed };
  }

  /** One note by id, or null when there is none. A note that exists but can't be read is an error, not null. */
  get(id: string): Note | null {
    if (!existsSync(this.pathFor(id))) return null;
    return this.load(`${id}.md`);
  }

  /**
   * Stamp each referenced file with its current content hash, against the project's roots.
   *   - A relative path is stamped in the one root that has it; in several roots it is ambiguous (an
   *     error); in none it is stamped against the main root as missing.
   *   - An absolute path inside a root is stored relative to the innermost such root; outside every
   *     root it stays absolute.
   * A relative path with no project to resolve it against is an error.
   */
  stamp(paths: string[], lookup: RootsLookup): FileStamp[] {
    const at = new Date().toISOString();
    const out: FileStamp[] = [];
    const rootField = (r: IndexRoot) => (r.kind === "alias" ? { root: r.configured } : {});
    for (const p of paths) {
      if (isAbsolute(p)) {
        const real = existsSync(p) ? realpathSync(p) : p;
        const owner = (lookup.roots ?? [])
          .filter((r) => real === r.path || real.startsWith(r.path + sep))
          .sort((a, b) => b.path.length - a.path.length)[0];
        const sha = hashFile(p) ?? "missing";
        out.push(owner ? { path: relative(owner.path, real).split(sep).join("/"), ...rootField(owner), sha256: sha, at } : { path: p, sha256: sha, at });
        continue;
      }
      if (!lookup.roots) throw new Error(`note_write: can't stamp "${p}" — ${lookup.reason}. Pass an absolute path, or a "repo" naming a configured project.`);
      const holders = lookup.roots.filter((r) => existsSync(join(r.path, p)));
      if (holders.length > 1) {
        throw new Error(`note_write: "${p}" exists in more than one root of this project (${holders.map((r) => r.path).join(", ")}); pass an absolute path to say which.`);
      }
      const holder = holders[0];
      if (holder) out.push({ path: p, ...rootField(holder), sha256: hashFile(join(holder.path, p)) ?? "missing", at });
      else out.push({ path: p, sha256: "missing", at });
    }
    return out;
  }

  /** Compare a note's stamps against the files as they are now, resolved against its own project's roots. */
  drift(note: Note, lookup: RootsLookup): Drift[] {
    return note.files.map((f) => {
      const label = { path: f.path, ...(f.root ? { root: f.root } : {}) };
      let abs: string;
      if (isAbsolute(f.path)) {
        abs = f.path;
      } else if (!lookup.roots) {
        return { ...label, state: "unresolved" as const, reason: lookup.reason };
      } else {
        const root = f.root === undefined ? lookup.roots.find((r) => r.kind === "root") : lookup.roots.find((r) => r.kind === "alias" && r.configured === f.root);
        if (!root) return { ...label, state: "unresolved" as const, reason: `alias "${f.root}" is no longer configured for project "${note.repo ?? "(default)"}"` };
        abs = join(root.path, f.path);
      }
      if (!existsSync(abs)) return { ...label, state: "missing" as const };
      const now = hashFile(abs);
      return { ...label, state: now === f.sha256 ? ("unchanged" as const) : ("changed" as const) };
    });
  }

  /**
   * Write a note. A typed note's data file is written first and the note second, each through a rename;
   * the note records the data file's sha256, so an interrupted pair is detected on read.
   */
  write(note: Note): Note {
    let dataHash: string | null = null;
    if (note.record) {
      const text = `${JSON.stringify({ schema: note.record.schema, version: note.record.version, data: note.record.data }, null, 2)}\n`;
      dataHash = sha256(text);
      writeAtomic(this.dataPathFor(note.id), text);
    }
    writeAtomic(this.pathFor(note.id), serialize(note, dataHash));
    this.dirty = true; // do not wait for the watcher to catch up with our own write
    return note;
  }

  /** Mark `oldId` superseded by `newId`, updating both sides of the link. Nothing is written unless both notes exist. */
  supersede(oldId: string, newId: string): { updated: string[]; missing: string[] } {
    const older = this.get(oldId);
    const newer = this.get(newId);
    const missing = [...(older ? [] : [oldId]), ...(newer ? [] : [newId])];
    if (missing.length) return { updated: [], missing };
    older!.status = "superseded";
    if (!older!.supersededBy.includes(newId)) older!.supersededBy.push(newId);
    if (!newer!.supersedes.includes(oldId)) newer!.supersedes.push(oldId);
    this.write(older!);
    this.write(newer!);
    return { updated: [oldId, newId], missing: [] };
  }

  get directory() { return this.dir; }
  exists(id: string) { return existsSync(this.pathFor(id)); }
}
