import type { Note, NoteStore, Drift, RootsLookup } from "./store.js";

/** A note's project roots, looked up from the note's own `repo`. */
export type RootsFor = (repo: string | null) => RootsLookup;

/** Standing authority per status. Retracted stays non-zero so a recorded wrong turn still surfaces. */
export const STATUS_WEIGHT: Record<Note["status"], number> = {
  current: 1.0,
  superseded: 0.35,
  retracted: 0.15,
};

// Okapi BM25 parameters. k1 controls term-frequency saturation, b document-length normalization.
const K1 = 1.2;
const B = 0.75;
// A hit in the title or tags is worth more than one in the body.
const FIELD_BOOST = { title: 3, body: 1 } as const;

export interface ScoredNote {
  note: Note;
  score: number;
  drift: Drift[];
  caveat: string | null;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
}

/**
 * Tokens for typed data and for the data side of a query, so values like `3.14`, `0x1A0`, or `2` stay
 * searchable:
 *   1. lowercase; split on whitespace and anything but letters, digits, `_`, `.`, `-`, `:`, `+`;
 *   2. trim `.`, `-`, `:`, `+` from both ends, keeping a `-` or `+` directly before a digit;
 *   3. keep tokens of any length;
 *   4. a token containing `.`, `-`, or `:` also yields its parts (`fields.offset` → `fields`, `offset`).
 */
export function dataTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_.:+-]+/u)) {
    let t = raw.replace(/[.:+-]+$/, "");
    const lead = /^[.:+-]+/.exec(t)?.[0] ?? "";
    if (lead) {
      const rest = t.slice(lead.length);
      const sign = lead[lead.length - 1]!;
      t = (sign === "-" || sign === "+") && /^\p{N}/u.test(rest) ? sign + rest : rest;
    }
    if (!t) continue;
    out.push(t);
    if (/[.:-]/.test(t)) for (const part of t.split(/[.:-]+/)) if (part && part !== t) out.push(part);
  }
  return out;
}

/** Every key and scalar value of a typed record's data, as data tokens. Numbers use their JSON text. */
export function tokenizeData(value: unknown): string[] {
  if (value === null || typeof value === "boolean" || typeof value === "number") return dataTokens(JSON.stringify(value));
  if (typeof value === "string") return dataTokens(value);
  if (Array.isArray(value)) return value.flatMap(tokenizeData);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [...dataTokens(k), ...tokenizeData(v)]);
  return [];
}

interface Doc {
  note: Note;
  tf: Map<string, number>;
  /** Distinct tokens, for cheap prefix matching without rescanning the full term list. */
  terms: string[];
  len: number;
}

/** Tokenized docs memoized by Note identity; sound only because the store replaces a Note when its file changes. */
const docCache = new WeakMap<Note, Doc>();

function docFor(note: Note): Doc {
  const hit = docCache.get(note);
  if (hit) return hit;
  const built = buildDoc(note);
  docCache.set(note, built);
  return built;
}

function buildDoc(note: Note): Doc {
  const tf = new Map<string, number>();
  const add = (tokens: string[], boost: number) => {
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + boost);
  };
  add(tokenize(`${note.title} ${note.tags.join(" ")}`), FIELD_BOOST.title);
  add(tokenize(note.body), FIELD_BOOST.body);
  if (note.record) add([...dataTokens(note.record.schema), ...tokenizeData(note.record.data)], FIELD_BOOST.body);
  let len = 0;
  for (const v of tf.values()) len += v;
  return { note, tf, terms: [...tf.keys()], len };
}

/**
 * Inverted index over the current note set: token -> [docIndex, weightedTf][].
 * Rebuilt only when the doc set changes, detected by element-wise identity comparison.
 */
interface Index {
  docs: Doc[];
  vocab: Map<string, Array<[number, number]>>;
  avgdl: number;
}
let cachedIndex: Index | null = null;

function sameDocs(a: Doc[], b: Doc[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function indexFor(docs: Doc[]): Index {
  if (cachedIndex && sameDocs(cachedIndex.docs, docs)) return cachedIndex;
  const vocab = new Map<string, Array<[number, number]>>();
  let total = 0;
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i]!;
    total += d.len;
    for (const [tok, tf] of d.tf) {
      let postings = vocab.get(tok);
      if (!postings) vocab.set(tok, (postings = []));
      postings.push([i, tf]);
    }
  }
  cachedIndex = { docs, vocab, avgdl: total / (docs.length || 1) || 1 };
  return cachedIndex;
}

export function scoreNotes(
  store: NoteStore,
  query: string,
  rootsFor: RootsFor,
  opts: { includeRetracted?: boolean; repo?: string | null } = {},
): ScoredNote[] {
  const notes = store.list().filter((n) => {
    if (n.status === "retracted" && !opts.includeRetracted) return false;
    if (opts.repo && n.repo && n.repo !== opts.repo) return false;
    return true;
  });
  if (notes.length === 0) return [];

  const docs = notes.map(docFor);
  const { vocab, avgdl } = indexFor(docs);
  const N = docs.length;
  // Both tokenizers, so a query can match prose words and data values like `3.14` or `2`.
  const terms = [...new Set([...tokenize(query), ...dataTokens(query)])];

  // Accumulate BM25 per document, touching only documents that match something.
  const acc = new Map<number, number>();
  for (const t of terms) {
    // Exact postings plus substring-matched ones, discounted.
    const groups: Array<{ postings: Array<[number, number]>; weight: number }> = [];
    const exact = vocab.get(t);
    if (exact) groups.push({ postings: exact, weight: 1 });
    for (const [tok, postings] of vocab) {
      if (tok !== t && tok.includes(t)) groups.push({ postings, weight: 0.25 });
    }
    if (groups.length === 0) continue;

    const matched = new Set<number>();
    for (const g of groups) for (const [i] of g.postings) matched.add(i);
    const idf = Math.log(1 + (N - matched.size + 0.5) / (matched.size + 0.5));

    const perDoc = new Map<number, number>();
    for (const g of groups) {
      for (const [i, tf] of g.postings) perDoc.set(i, (perDoc.get(i) ?? 0) + tf * g.weight);
    }
    for (const [i, f] of perDoc) {
      const d = docs[i]!;
      const contrib = idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgdl)));
      acc.set(i, (acc.get(i) ?? 0) + contrib);
    }
  }

  const candidates = terms.length === 0 ? docs.map((_, i) => i) : [...acc.keys()];
  const out: ScoredNote[] = [];
  for (const i of candidates) {
    const note = docs[i]!.note;
    const drift = store.drift(note, rootsFor(note.repo));
    const changed = drift.filter((x) => x.state !== "unchanged");
    const driftFactor = drift.length === 0 ? 1 : 1 - 0.5 * (changed.length / drift.length);
    const base = terms.length === 0 ? 1 : (acc.get(i) ?? 0);
    const score = base * STATUS_WEIGHT[note.status] * driftFactor;

    const caveat = changed.length
      ? `This conclusion predates ${changed.length} change(s) to the file(s) it describes (${changed.map((c) => `${c.path}:${c.state}`).join(", ")}). Re-verify before relying on it.`
      : note.status === "superseded"
        ? `Superseded by ${note.supersededBy.join(", ") || "a later note"}.`
        : note.status === "retracted"
          ? "Retracted — recorded as a wrong turn, kept so it is not repeated."
          : null;

    out.push({ note, score, drift, caveat });
  }
  return out.sort((a, b) => b.score - a.score);
}
