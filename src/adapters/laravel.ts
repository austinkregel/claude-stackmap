import { readFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { IndexConfig } from "../config.js";
import { readPsr4, symbolToFiles, type Psr4Map } from "../php/psr4.js";
import { extractBindings, type Binding, type ContextualBinding, type SkippedCall } from "../php/bindings.js";
import { extractDeclarations, type Declaration } from "../php/declarations.js";
import { walkFiles } from "./walk.js";
import type {
  AdapterFactory, AdapterStats, Detection, EdgeKind, FileRef, IndexedAdapter, IndexRoot, ResolutionEdge, RootStats, StackAdapter, SymbolHit,
} from "./types.js";

const DEFAULT_INCLUDE = ["app", "bootstrap", "config", "routes"];
const DEFAULT_EXCLUDE = ["vendor", "storage", "bootstrap/cache", "node_modules", "public"];
/** Cheap pre-filter so we only parse files that could hold a binding. */
const BINDING_HINT = /\b(bind|bindIf|singleton|singletonIf|scoped|scopedIf|instance|when)\s*\(/;
/** Every PHP file can declare a type, so declarations only skip files with no declaration at all. */
const DECL_HINT = /^[ \t]*(?:(?:final|abstract|readonly)[ \t]+)*(?:class|interface|trait|enum)[ \t]/m;
const BINDING_KINDS: EdgeKind[] = ["container", "contextual"];

/** A composer.json dependency on the framework or any of its components means Laravel. */
const isLaravelPackage = (name: string) => name === "laravel/framework" || name.startsWith("illuminate/");

/** One root as this adapter scans it. A root whose composer.json can't be read is kept with its error and not scanned. */
interface RootState {
  root: IndexRoot;
  include: string[];
  exclude: string[];
  psr4: Psr4Map;
  warnings: string[];
  error: string | null;
}

interface RootCounts {
  filesScanned: number;
  filesWithBindings: number;
  filesWithDeclarations: number;
}

interface Built {
  edges: ResolutionEdge[];
  declarationEdges: ResolutionEdge[];
  declarations: Declaration[];
  skipped: SkippedCall[];
  /** Edges whose abstract is runtime-computed, and the distinct call sites they came from. */
  computedEdges: ResolutionEdge[];
  computedSites: string[];
  counts: Map<string, RootCounts>;
  /** Per-root walk and read problems, added to that root's warnings. */
  walkWarnings: Map<string, string[]>;
}

const inside = (abs: string, dir: string) => abs === dir || abs.startsWith(dir + sep);
const toPosix = (p: string) => p.split(sep).join("/");

class LaravelAdapter implements StackAdapter {
  readonly id = "laravel" as const;
  private cache: Built | null = null;
  /**
   * Group order: aliases first, then the main root that owns the index. Among aliases a child always
   * comes before the alias it sits in (deepest first), and siblings are in path order.
   */
  private readonly ordered: RootState[];

  constructor(private readonly states: RootState[]) {
    const aliases = states.filter((s) => s.root.kind === "alias").sort((a, b) => (a.root.path < b.root.path ? -1 : a.root.path > b.root.path ? 1 : 0));
    const parentOf = (s: RootState) =>
      aliases.filter((p) => p !== s && inside(s.root.path, p.root.path)).sort((a, b) => b.root.path.length - a.root.path.length)[0] ?? null;
    const ordered: RootState[] = [];
    const place = (node: RootState) => {
      for (const child of aliases.filter((c) => parentOf(c) === node)) place(child);
      ordered.push(node);
    };
    for (const top of aliases.filter((a) => parentOf(a) === null)) place(top);
    this.ordered = [...ordered, ...states.filter((s) => s.root.kind === "root")];
  }

  /** The innermost root containing an absolute path; the file is grouped under it and governed by its rules. */
  private ownerOf(abs: string): RootState | null {
    let best: RootState | null = null;
    for (const s of this.states) {
      if (inside(abs, s.root.path) && (!best || s.root.path.length > best.root.path.length)) best = s;
    }
    return best;
  }

  private fileRefs(fqcn: string): FileRef[] {
    const out: FileRef[] = [];
    const seen = new Set<string>();
    for (const s of this.ordered) {
      if (s.error) continue;
      for (const candidate of symbolToFiles(s.psr4, fqcn)) {
        const abs = join(s.root.path, candidate);
        if (seen.has(abs)) continue;
        seen.add(abs);
        const owner = this.ownerOf(abs) ?? s;
        out.push({ root: owner.root.path, path: toPosix(relative(owner.root.path, abs)), exists: existsSync(abs) });
      }
    }
    return out;
  }

  private build(): Built {
    if (this.cache) return this.cache;
    const edges: ResolutionEdge[] = [];
    const declarationEdges: ResolutionEdge[] = [];
    const declarations: Declaration[] = [];
    const skipped: SkippedCall[] = [];
    const counts = new Map<string, RootCounts>();
    const walkWarnings = new Map<string, string[]>();

    for (const s of this.ordered) {
      const tally: RootCounts = { filesScanned: 0, filesWithBindings: 0, filesWithDeclarations: 0 };
      counts.set(s.root.path, tally);
      const warnings: string[] = [];
      walkWarnings.set(s.root.path, warnings);
      if (s.error) continue;

      const walk = walkFiles(s.root.path, s.include, s.exclude, ".php");
      if (walk.missingDirs.length) warnings.push(`include director${walk.missingDirs.length === 1 ? "y" : "ies"} not found: ${walk.missingDirs.join(", ")}`);
      // A root's own include/exclude contradiction is a config error; this is what the global or adapter default excludes rule out.
      if (walk.excludedDirs.length) warnings.push(`include director${walk.excludedDirs.length === 1 ? "y" : "ies"} matched by a global or default exclude, so not scanned: ${walk.excludedDirs.join(", ")}`);
      if (walk.unreadableDirs.length) warnings.push(`director${walk.unreadableDirs.length === 1 ? "y" : "ies"} could not be read: ${walk.unreadableDirs.join(", ")}`);
      const unreadable: string[] = [];

      for (const rel of walk.files) {
        const abs = join(s.root.path, rel);
        // A file inside a nested root belongs to that root: only its own walk, under its own rules, indexes it.
        if (this.ownerOf(abs) !== s) continue;
        tally.filesScanned++;
        let src: string;
        try {
          src = readFileSync(abs, "utf8");
        } catch {
          unreadable.push(rel);
          continue;
        }
        if (BINDING_HINT.test(src)) {
          tally.filesWithBindings++;
          const result = extractBindings(src, rel);
          for (const b of result.bindings) edges.push(this.toEdge(b, s));
          for (const c of result.contextual) edges.push(this.toContextualEdge(c, s));
          skipped.push(...result.skipped);
        }
        if (DECL_HINT.test(src)) {
          tally.filesWithDeclarations++;
          for (const d of extractDeclarations(src, rel)) {
            declarations.push(d);
            declarationEdges.push(...this.toDeclarationEdges(d, s));
          }
        }
      }
      if (unreadable.length) warnings.push(`${unreadable.length} PHP file(s) could not be read: ${unreadable.slice(0, 5).join(", ")}${unreadable.length > 5 ? ", …" : ""}`);
    }

    const computedEdges = edges.filter((e) => e.computedAbstract === true);
    this.cache = {
      edges,
      declarationEdges,
      declarations,
      skipped,
      computedEdges,
      computedSites: [...new Set(computedEdges.map((e) => `${join(e.root, e.declaredIn)}:${e.declaredLine}`))],
      counts,
      walkWarnings,
    };
    return this.cache;
  }

  private toEdge(b: Binding, s: RootState): ResolutionEdge {
    const notes: string[] = [];
    if (b.abstractKind === "computed") {
      notes.push(
        b.inferredFrom
          ? `abstract is computed at runtime; concrete recovered by expanding ${b.inferredFrom} iterated at this site`
          : "abstract is computed at runtime — this site may bind any number of abstracts; read the provider",
      );
    }
    if (b.concreteKind === "closure") notes.push("bound to a closure — concrete type is decided at runtime; read the provider");
    else if (b.concreteKind === "self") notes.push("self-bound (no separate implementation)");
    else if (b.concreteKind === "unknown" && b.concrete === null) notes.push("concrete side not statically determinable");
    return {
      kind: "container",
      abstract: b.abstract,
      concrete: b.concrete,
      via: `container:${b.method}`,
      concreteFiles: b.concrete ? this.fileRefs(b.concrete) : [],
      root: s.root.path,
      declaredIn: b.file,
      declaredLine: b.line,
      ...(b.abstractKind === "computed" ? { computedAbstract: true } : {}),
      ...(b.inferredFrom ? { inferredFrom: b.inferredFrom } : {}),
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  }

  private toContextualEdge(c: ContextualBinding, s: RootState): ResolutionEdge {
    const notes: string[] = [`applies only while resolving ${c.context}`];
    if (c.needsKind === "variable") notes.push(`overrides the constructor parameter ${c.needs}, not a type`);
    if (c.givesKind === "closure") notes.push("given by a closure — value decided at runtime; read the provider");
    else if (c.givesKind === "tagged") notes.push("given every service in a container tag");
    else if (c.givesKind === "config") notes.push("given a config value");
    else if (c.gives === null) notes.push("given side not statically determinable");
    return {
      kind: "contextual",
      abstract: c.needs,
      concrete: c.givesKind === "class" ? c.gives : null,
      via: `container:when-needs-${c.method}`,
      concreteFiles: c.givesKind === "class" && c.gives ? this.fileRefs(c.gives) : [],
      root: s.root.path,
      declaredIn: c.file,
      declaredLine: c.line,
      context: c.context,
      ...(c.needsKind === "computed" ? { computedAbstract: true } : {}),
      note: notes.join("; "),
    };
  }

  /** One edge per declared parent/interface, so both directions are queryable. */
  private toDeclarationEdges(d: Declaration, s: RootState): ResolutionEdge[] {
    const out: ResolutionEdge[] = [];
    const push = (abstract: string, via: string) => {
      out.push({
        kind: "declaration",
        abstract,
        concrete: d.symbol,
        via,
        concreteFiles: [{ root: s.root.path, path: d.file, exists: true }],
        root: s.root.path,
        declaredIn: d.file,
        declaredLine: d.line,
        ...(d.isAbstract ? { note: `${d.symbol} is abstract — not instantiable itself` } : {}),
      });
    };
    for (const parent of d.extends) push(parent, `php:${d.kind === "interface" ? "interface-extends" : "extends"}`);
    for (const iface of d.implements) push(iface, "php:implements");
    return out;
  }

  resolveSymbol(name: string): SymbolHit {
    const fqcn = name.replace(/^\\+/, "");
    const built = this.build();
    const files = this.fileRefs(fqcn);
    const eq = (a: string | null) => a !== null && a.toLowerCase() === fqcn.toLowerCase();

    const container = built.edges.filter((e) => e.kind === "container");
    const contextual = built.edges.filter((e) => e.kind === "contextual");
    const implementedBy = container.filter((e) => eq(e.abstract));
    const implementsEdges = container.filter((e) => eq(e.concrete));
    const subtypes = built.declarationEdges.filter((e) => eq(e.abstract));
    const supertypes = built.declarationEdges.filter((e) => eq(e.concrete));
    const injections = contextual.filter((e) => eq(e.context ?? null));
    const injectedInto = contextual.filter((e) => eq(e.abstract) || eq(e.concrete));

    return {
      symbol: fqcn,
      files,
      exists: files.some((f) => f.exists),
      implementedBy,
      implements: implementsEdges,
      subtypes,
      supertypes,
      injections,
      injectedInto,
      caveats: this.caveatsFor(built, implementedBy.length === 0),
    };
  }

  /** Caveats that keep an empty result from being read as a negative answer. */
  private caveatsFor(built: Built, abstractSideEmpty: boolean): string[] {
    const out: string[] = [];
    if (built.computedSites.length > 0) {
      const sample = built.computedSites.slice(0, 3);
      out.push(
        `${built.computedSites.length} binding site(s) in this index compute their abstract at runtime ` +
          `(${built.computedEdges.length} edge(s)), so ` +
          `${abstractSideEmpty ? "an empty `implementedBy` is not proof that nothing binds this symbol" : "the abstract side may be incomplete"}. ` +
          `Sites: ${sample.join(", ")}${built.computedSites.length > sample.length ? ", …" : ""} — call stackmap_bindings and look for computedAbstract to list them all.`,
      );
    }
    if (built.skipped.length > 0) {
      out.push(
        `${built.skipped.length} call(s) named like a binding were skipped because their receiver is not the container ` +
          `(e.g. ${[...new Set(built.skipped.map((s) => s.receiver))].slice(0, 3).join(", ")}).`,
      );
    }
    for (const s of this.ordered) {
      const label = s.root.kind === "root" ? `root ${s.root.path}` : `alias ${s.root.configured} (${s.root.path})`;
      if (s.error) {
        out.push(`${label} was not scanned: ${s.error}`);
        continue;
      }
      out.push(`In ${label}, only these directories were scanned: ${s.include.join(", ")}. Anything declared elsewhere is invisible here.`);
      for (const w of [...s.warnings, ...(built.walkWarnings.get(s.root.path) ?? [])]) out.push(`WARNING ${label}: ${w}`);
    }
    return out;
  }

  resolutionTable(kinds: EdgeKind[] = BINDING_KINDS): ResolutionEdge[] {
    const built = this.build();
    const wanted = new Set(kinds);
    const out: ResolutionEdge[] = [];
    if (wanted.has("container") || wanted.has("contextual")) {
      out.push(...built.edges.filter((e) => wanted.has(e.kind)));
    }
    if (wanted.has("declaration")) out.push(...built.declarationEdges);
    return out;
  }

  stats(): AdapterStats {
    const b = this.build();
    const container = b.edges.filter((e) => e.kind === "container");
    const contextual = b.edges.filter((e) => e.kind === "contextual");
    const roots: RootStats[] = this.ordered.map((s) => {
      const c = b.counts.get(s.root.path)!;
      return {
        kind: s.root.kind,
        configured: s.root.configured,
        path: s.root.path,
        include: s.include.join(", "),
        psr4Prefixes: s.psr4.prefixes.length,
        filesScanned: c.filesScanned,
        filesWithBindings: c.filesWithBindings,
        filesWithDeclarations: c.filesWithDeclarations,
        warnings: [...s.warnings, ...(b.walkWarnings.get(s.root.path) ?? [])],
        ...(s.error ? { error: s.error } : {}),
      };
    });
    return {
      adapter: this.id,
      roots,
      phpFilesScanned: roots.reduce((n, r) => n + r.filesScanned, 0),
      containerBindings: container.length,
      contextualBindings: contextual.length,
      distinctAbstracts: new Set(container.filter((e) => !e.computedAbstract).map((e) => e.abstract)).size,
      computedAbstractSites: b.computedSites.length,
      computedAbstractEdges: b.computedEdges.length,
      closureBindings: container.filter((e) => e.concrete === null).length,
      declarations: b.declarations.length,
      interfaces: b.declarations.filter((d) => d.kind === "interface").length,
      declarationEdges: b.declarationEdges.length,
      skippedNonContainerCalls: b.skipped.length,
    };
  }
}

export const laravelFactory: AdapterFactory = {
  id: "laravel",

  detect(root: string): Detection {
    const composer = join(root, "composer.json");
    if (!existsSync(composer)) return { matched: false, notes: [] };
    let json: any;
    try {
      json = JSON.parse(readFileSync(composer, "utf8"));
    } catch (err) {
      return { matched: false, notes: [`${composer} can't be read as JSON (${(err as Error).message}), so it was treated as no manifest`] };
    }
    const deps = [...Object.keys(json?.require ?? {}), ...Object.keys(json?.["require-dev"] ?? {})];
    return { matched: deps.some(isLaravelPackage), notes: [] };
  },

  create(cfg: IndexConfig, roots: IndexRoot[], globalExclude: string[]): IndexedAdapter {
    const opts = cfg.options as { bindingPaths?: string[] };
    const projectInclude = cfg.include ?? opts.bindingPaths ?? DEFAULT_INCLUDE;
    const states: RootState[] = roots.map((root) => {
      const include = root.include ?? projectInclude;
      const exclude = [...new Set([...globalExclude, ...DEFAULT_EXCLUDE, ...(root.exclude ?? cfg.exclude ?? [])])];
      let read;
      try {
        read = readPsr4(root.path);
      } catch (err) {
        // A composer.json that exists but can't be read is an error for that root.
        if (root.kind === "root") throw new Error(`stackmap: index "${cfg.name}": ${(err as Error).message}`);
        return { root, include, exclude, psr4: { prefixes: [] }, warnings: [], error: (err as Error).message };
      }
      if (read.found) return { root, include, exclude, psr4: read.map, warnings: [], error: null };
      if (root.kind === "root") {
        throw new Error(`stackmap: index "${cfg.name}" uses the laravel adapter, but its root has no composer.json (${read.path}).`);
      }
      return {
        root, include, exclude, psr4: { prefixes: [] }, error: null,
        warnings: [`no composer.json (${read.path}): its files are indexed, but symbols can't be mapped to files through PSR-4 from this root`],
      };
    });
    const adapter = new LaravelAdapter(states);
    // Laravel answers symbol resolution only; the compiled-program capabilities are the Ghidra
    // adapter's, and a tool that needs one fails naming this adapter rather than returning nothing.
    return { id: adapter.id, stats: () => adapter.stats(), resolve: adapter, functions: null, types: null, xref: null };
  },
};
