import type { IndexConfig } from "../config.js";

export type AdapterId = "laravel" | "phoenix" | "node";

/**
 * What a given edge is evidence of. These answer different questions and must not be
 * conflated: a container binding says what the container hands you, a declaration says what
 * the language guarantees, a contextual binding applies only while resolving one class.
 */
export type EdgeKind = "container" | "contextual" | "declaration";

/** One abstraction -> implementation edge, however the stack declares it. */
export interface ResolutionEdge {
  kind: EdgeKind;
  abstract: string;
  concrete: string | null;
  /** How the edge was declared, e.g. "container:bind", "container:when-needs-give", "php:implements". */
  via: string;
  /** null when the concrete side is a closure/factory rather than a named type. */
  concreteFile: string | null;
  declaredIn: string;
  declaredLine: number;
  note?: string;
  /**
   * Contextual bindings only: the class being resolved when this override applies.
   * `abstract` is then the dependency being overridden, which may be a `$variable`.
   */
  context?: string;
  /** True when `abstract` is an expression evaluated at runtime rather than a resolvable name. */
  computedAbstract?: boolean;
  /** Set when the edge was derived (e.g. by expanding an iterated const) rather than written. */
  inferredFrom?: string;
}

export interface SymbolHit {
  symbol: string;
  /** Repo-relative path, or null when the symbol resolves to no file on disk. */
  file: string | null;
  exists: boolean;
  /** Container edges where this symbol is the abstract. */
  implementedBy: ResolutionEdge[];
  /** Container edges where this symbol is the concrete. */
  implements: ResolutionEdge[];
  /** Declaration edges: types that extend or implement this symbol. */
  subtypes: ResolutionEdge[];
  /** Declaration edges: what this symbol itself extends or implements. */
  supertypes: ResolutionEdge[];
  /** Contextual edges where this symbol is the class being resolved — what gets injected into it. */
  injections: ResolutionEdge[];
  /** Contextual edges where this symbol is the injected dependency or the given concrete. */
  injectedInto: ResolutionEdge[];
  /**
   * Anything that could make an empty result above misleading — runtime-computed binding
   * sites, skipped lookalike calls, uncovered directories. An empty edge list plus an empty
   * caveat list is a real negative; an empty edge list with caveats is not.
   */
  caveats: string[];
}

export interface AdapterStats {
  adapter: AdapterId;
  root: string;
  [k: string]: string | number;
}

export interface StackAdapter {
  readonly id: AdapterId;
  /** Resolve a symbol (class/module name) to a file plus its resolution edges. */
  resolveSymbol(name: string): SymbolHit;
  /**
   * The abstraction -> implementation table for this repo. Defaults to the binding table
   * (container + contextual); pass kinds explicitly to include declaration edges.
   */
  resolutionTable(kinds?: EdgeKind[]): ResolutionEdge[];
  /** Cheap counts for `stackmap_indexes`. */
  stats(): AdapterStats;
}

export interface AdapterFactory {
  id: AdapterId;
  /** Repo-root marker files that identify this stack, checked in order. */
  markers: string[];
  create(cfg: IndexConfig, root: string, globalExclude: string[]): StackAdapter;
}
