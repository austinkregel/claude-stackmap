import type { Note, NoteStore, Drift } from "./store.js";

/**
 * Standing authority per status. A retracted note keeps a non-zero weight on purpose:
 * a recorded wrong turn is still evidence, and surfacing it stops the same wrong turn twice.
 */
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

interface Doc {
  note: Note;
  tf: Map<string, number>;
  /** Distinct tokens, for cheap prefix matching without rescanning the full term list. */
  terms: string[];
  len: number;
}

/**
 * Tokenized docs are memoized against the Note object itself. The store replaces a Note object
 * only when its file changes, so identity is exactly the right invalidation key — and the entry
 * becomes collectable as soon as the old note is dropped.
 */
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
  let len = 0;
  for (const v of tf.values()) len += v;
  return { note, tf, terms: [...tf.keys()], len };
}

/**
 * Inverted index over the current note set: token -> [docIndex, weightedTf][].
 *
 * Without it, prefix matching costs O(notes x queryTerms x tokensPerNote) per search, which is
 * what dominated at 5k notes. With it, a query touches the vocabulary once and then only the
 * documents that actually contain a matching token.
 *
 * Rebuilt only when the document set changes. Docs are memoized by note identity, so an
 * element-wise identity comparison is a sound and cheap staleness check.
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
  repoRoot: string | null,
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
  const terms = [...new Set(tokenize(query))];

  // Accumulate BM25 per document, touching only documents that match something.
  const acc = new Map<number, number>();
  for (const t of terms) {
    // Exact postings plus prefix-expanded ones, discounted. One vocabulary pass per term
    // rather than one pass over every document's token list.
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
    const drift = store.drift(note, repoRoot);
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
