import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { join, isAbsolute, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { expandPath } from "../config.js";
import type { IndexRoot } from "../adapters/types.js";

export type NoteStatus = "current" | "superseded" | "retracted";

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
}

/** Drift between what a note was written about and what those files contain now. */
export interface Drift {
  path: string;
  root?: string;
  /** `unresolved`: the stamp's project or alias can't be located now, so the file couldn't be checked. */
  state: "unchanged" | "changed" | "missing" | "unresolved";
  reason?: string;
}

const ESC = (s: string) => s.replace(/"/g, '\\"');

function serialize(n: Note): string {
  const fm = [
    "---",
    `id: "${ESC(n.id)}"`,
    `title: "${ESC(n.title)}"`,
    `status: ${n.status}`,
    `created: "${n.created}"`,
    `verified_on: ${n.verifiedOn ? `"${n.verifiedOn}"` : "null"}`,
    `repo: ${n.repo ? `"${ESC(n.repo)}"` : "null"}`,
    `tags: [${n.tags.map((t) => `"${ESC(t)}"`).join(", ")}]`,
    `supersedes: [${n.supersedes.map((t) => `"${ESC(t)}"`).join(", ")}]`,
    `superseded_by: [${n.supersededBy.map((t) => `"${ESC(t)}"`).join(", ")}]`,
    "files:",
    ...n.files.map((f) => `  - path: "${ESC(f.path)}"\n${f.root ? `    root: "${ESC(f.root)}"\n` : ""}    sha256: "${f.sha256}"\n    at: "${f.at}"`),
    "---",
  ].join("\n");
  return `${fm}\n\n${n.body.trim()}\n`;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t === "null" || t === "") return "";
  return t.replace(/^"(.*)"$/s, "$1").replace(/\\"/g, '"');
}
function parseList(v: string): string[] {
  const t = v.trim();
  if (!t.startsWith("[")) return [];
  return t.slice(1, -1).split(",").map((s) => unquote(s)).filter(Boolean);
}

function deserialize(raw: string, fallbackId: string): Note | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const [, fmText, body] = m;
  const scalars: Record<string, string> = {};
  const files: FileStamp[] = [];
  let cur: Partial<FileStamp> | null = null;
  let inFiles = false;

  for (const line of fmText!.split("\n")) {
    if (/^files:\s*$/.test(line)) { inFiles = true; continue; }
    if (inFiles) {
      const item = /^\s*-\s*path:\s*(.+)$/.exec(line);
      if (item) { if (cur?.path && cur.sha256) files.push(cur as FileStamp); cur = { path: unquote(item[1]!) }; continue; }
      const kv = /^\s+(root|sha256|at):\s*(.+)$/.exec(line);
      if (kv && cur) { (cur as any)[kv[1]!] = unquote(kv[2]!); continue; }
      if (/^\S/.test(line)) inFiles = false; else continue;
    }
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) scalars[kv[1]!] = kv[2]!;
  }
  if (cur?.path && cur.sha256) files.push(cur as FileStamp);

  const status = (unquote(scalars.status ?? "") || "current") as NoteStatus;
  return {
    id: unquote(scalars.id ?? "") || fallbackId,
    title: unquote(scalars.title ?? "") || fallbackId,
    status: ["current", "superseded", "retracted"].includes(status) ? status : "current",
    created: unquote(scalars.created ?? "") || new Date(0).toISOString(),
    verifiedOn: unquote(scalars.verified_on ?? "") || null,
    tags: parseList(scalars.tags ?? ""),
    repo: unquote(scalars.repo ?? "") || null,
    supersedes: parseList(scalars.supersedes ?? ""),
    supersededBy: parseList(scalars.superseded_by ?? ""),
    files,
    body: (body ?? "").trim(),
  };
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

export class NoteStore {
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  static fromConfig(notesDir?: string): NoteStore {
    return new NoteStore(expandPath(notesDir ?? "~/.config/stackmap/notes"));
  }

  private pathFor(id: string) { return join(this.dir, `${id}.md`); }

  /** Parsed-note cache keyed by filename, invalidated per-file by mtime:size. */
  private cache = new Map<string, { key: string; note: Note }>();

  /**
   * Directory listing cache, marked dirty by a watcher. `fs.watch` can miss events, so a
   * wall-clock backstop forces a rescan regardless: the watcher is never the correctness boundary.
   */
  private listCache: Note[] | null = null;
  private dirty = true;
  private lastScan = 0;
  private watcher: FSWatcher | null = null;
  private static readonly BACKSTOP_MS = 2000;

  private ensureWatcher() {
    if (this.watcher) return;
    try {
      // persistent:false so a watcher never keeps the process alive.
      this.watcher = watch(this.dir, { persistent: false }, () => { this.dirty = true; });
    } catch { this.watcher = null; } // unwatchable dir just means we always rescan
  }

  list(): Note[] {
    this.ensureWatcher();
    const fresh = !this.dirty && this.listCache !== null && Date.now() - this.lastScan < NoteStore.BACKSTOP_MS;
    if (fresh) return this.listCache!;
    const scanned = this.scan();
    this.listCache = scanned;
    this.dirty = false;
    this.lastScan = Date.now();
    return scanned;
  }

  private scan(): Note[] {
    const out: Note[] = [];
    let names: string[] = [];
    try { names = readdirSync(this.dir).filter((f) => f.endsWith(".md")); } catch { return out; }
    const live = new Set(names);
    for (const stale of [...this.cache.keys()]) if (!live.has(stale)) this.cache.delete(stale);

    for (const name of names) {
      const full = join(this.dir, name);
      let key: string;
      try {
        const st = statSync(full);
        key = `${st.mtimeMs}:${st.size}`;
      } catch { continue; }
      const hit = this.cache.get(name);
      if (hit && hit.key === key) { out.push(hit.note); continue; }
      try {
        const n = deserialize(readFileSync(full, "utf8"), name.replace(/\.md$/, ""));
        if (n) { this.cache.set(name, { key, note: n }); out.push(n); }
      } catch { /* a malformed note must not break retrieval of the rest */ }
    }
    return out;
  }

  get(id: string): Note | null {
    const p = this.pathFor(id);
    if (!existsSync(p)) return null;
    return deserialize(readFileSync(p, "utf8"), id);
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

  write(note: Note): Note {
    writeFileSync(this.pathFor(note.id), serialize(note), "utf8");
    this.dirty = true; // do not wait for the watcher to catch up with our own write
    return note;
  }

  /** Mark `oldId` superseded by `newId`, updating both sides of the link. */
  supersede(oldId: string, newId: string): { updated: string[]; missing: string[] } {
    const updated: string[] = [], missing: string[] = [];
    const older = this.get(oldId), newer = this.get(newId);
    if (older) {
      older.status = "superseded";
      if (!older.supersededBy.includes(newId)) older.supersededBy.push(newId);
      this.write(older); updated.push(oldId);
    } else missing.push(oldId);
    if (newer) {
      if (!newer.supersedes.includes(oldId)) newer.supersedes.push(oldId);
      this.write(newer); updated.push(newId);
    } else missing.push(newId);
    return { updated, missing };
  }

  get directory() { return this.dir; }
  exists(id: string) { return existsSync(this.pathFor(id)); }
  mtime(id: string): number { try { return statSync(this.pathFor(id)).mtimeMs; } catch { return 0; } }
}
