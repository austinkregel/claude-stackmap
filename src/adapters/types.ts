import type { IndexConfig } from "../config.js";

export type AdapterId = "laravel" | "ghidra" | "phoenix" | "node";

/**
 * What a given edge is evidence of. These answer different questions and must not be
 * conflated: a container binding says what the container hands you, a declaration says what
 * the language guarantees, a contextual binding applies only while resolving one class.
 */
export type EdgeKind = "container" | "contextual" | "declaration";

/**
 * One root of a project: its main root, or an alias. `path` is the real path (symlinks resolved),
 * which is what "the same file" is judged by. Rules are the root's own include/exclude, or null to
 * inherit the project's.
 */
export interface IndexRoot {
  kind: "root" | "alias";
  /** As written in the config. */
  configured: string;
  path: string;
  include: string[] | null;
  exclude: string[] | null;
}

/** A file, relative to the project root it is grouped under (the innermost root containing it). */
export interface FileRef {
  root: string;
  path: string;
  exists: boolean;
}

/** One abstraction -> implementation edge, however the stack declares it. */
export interface ResolutionEdge {
  kind: EdgeKind;
  abstract: string;
  concrete: string | null;
  /** How the edge was declared, e.g. "container:bind", "container:when-needs-give", "php:implements". */
  via: string;
  /** Where the concrete side's source may live; empty when it is a closure/factory rather than a named type. */
  concreteFiles: FileRef[];
  /** The root the declaring file is grouped under; `declaredIn` is relative to it. */
  root: string;
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
  /** Every place the symbol's source may live, across the project's roots. */
  files: FileRef[];
  /** True when at least one of `files` exists. */
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

/** Per-root counts and anything about that root the caller must be told. */
export interface RootStats {
  kind: IndexRoot["kind"];
  configured: string;
  path: string;
  filesScanned: number;
  warnings: string[];
  [k: string]: string | number | string[];
}

export interface AdapterStats {
  adapter: AdapterId;
  roots: RootStats[];
  [k: string]: string | number | RootStats[];
}

export interface StackAdapter {
  readonly id: AdapterId;
  /** Resolve a symbol (class/module name) to its files plus its resolution edges. */
  resolveSymbol(name: string): SymbolHit;
  /**
   * The abstraction -> implementation table for this project. Defaults to the binding table
   * (container + contextual); pass kinds explicitly to include declaration edges.
   */
  resolutionTable(kinds?: EdgeKind[]): ResolutionEdge[];
  /** Cheap counts for `stackmap_indexes`. */
  stats(): AdapterStats;
}

/**
 * Capabilities for compiled programs, served from a Ghidra export. Their result fields are snake_case
 * because that is what the tools return (user decision); the older `resolve` capability keeps its
 * camelCase fields. They are async because an export is indexed on first use.
 */
export interface CompiledFunction {
  program: string;
  root: string;
  name: string;
  entry: string;
  size: number;
  signature: string | null;
  calling_convention: string | null;
  noreturn: boolean;
  thunk_of: string | null;
  source: string | null;
  decompile: string;
  decompile_error: string | null;
  pseudocode: string | null;
  computed_calls_unresolved: number;
  callers: Array<{ from: string; function: string | null; name: string | null }>;
  callees: Array<{ entry: string; name: string | null }>;
  data_refs: Array<{ from: string; type: string }>;
  disassembly: Array<{ address: string; text: string }>;
}

export interface TypeLayoutField {
  name: string | null;
  anonymous: boolean;
  offset: number;
  size: number;
  type: string | null;
  bit_offset?: number;
  bit_size?: number;
  comment: string | null;
  layout?: CompiledTypeLayout;
  caveat?: string;
}

export interface CompiledTypeLayout {
  program: string;
  root: string;
  name: string;
  path: string;
  kind: string;
  size: number;
  align: number | null;
  packing: number | null;
  source_archive: string | null;
  description: string | null;
  fields: TypeLayoutField[];
  caveats: string[];
}

export interface XrefHit {
  program: string;
  root: string;
  kind: "constant" | "string";
  /** What matched: the scalar, or the string's address. */
  matched: string;
  value: string | null;
  address: string;
  function: { entry: string; name: string } | null;
  /** How the reference reaches the target: an instruction operand, a reference, or a pointer word. */
  via: string;
  context: Array<{ address: string; text: string }>;
}

export interface FunctionLookup {
  getFunction(query: { name?: string; address?: string; limit: number; context: number }): Promise<{ matches: CompiledFunction[]; total: number; caveats: string[] }>;
}

export interface TypeLookup {
  getType(query: { name?: string; path?: string; limit: number; depth: number }): Promise<{ matches: CompiledTypeLayout[]; total: number; caveats: string[] }>;
}

export interface XrefSearch {
  findRefs(query: { constant?: string; string?: string; limit: number; context: number }): Promise<{ hits: XrefHit[]; total: number; caveats: string[] }>;
}

/**
 * What an index provides. Every capability is declared; null means the adapter doesn't have it, and
 * a tool that needs it fails naming the adapter and the capability.
 */
export interface IndexedAdapter {
  readonly id: AdapterId;
  /** Cheap counts for `stackmap_indexes`. */
  stats(): AdapterStats;
  readonly resolve: StackAdapter | null;
  readonly functions: FunctionLookup | null;
  readonly types: TypeLookup | null;
  readonly xref: XrefSearch | null;
}

export type Capability = Exclude<keyof IndexedAdapter, "id" | "stats">;

/** Whether a root looks like this stack, and anything about the check the caller must be told. */
export interface Detection {
  matched: boolean;
  notes: string[];
}

export interface AdapterFactory {
  id: AdapterId;
  /** Decide from the root's own files (e.g. its package manifest) whether it is this stack. */
  detect(root: string): Detection;
  create(cfg: IndexConfig, roots: IndexRoot[], globalExclude: string[]): IndexedAdapter;
}
