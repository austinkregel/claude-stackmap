import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { IndexConfig } from "../config.js";
import { readPsr4, symbolToFiles, type Psr4Map } from "../php/psr4.js";
import { extractBindings, type Binding, type ContextualBinding, type SkippedCall } from "../php/bindings.js";
import { extractDeclarations, type Declaration } from "../php/declarations.js";
import { walkFiles } from "./walk.js";
import type { AdapterFactory, AdapterStats, EdgeKind, ResolutionEdge, StackAdapter, SymbolHit } from "./types.js";

const DEFAULT_INCLUDE = ["app"];
const DEFAULT_EXCLUDE = ["vendor", "storage", "bootstrap/cache", "node_modules", "public"];
/** Cheap pre-filter so we only parse files that could hold a binding. */
const BINDING_HINT = /\b(bind|bindIf|singleton|singletonIf|scoped|scopedIf|instance|when)\s*\(/;
/** Every PHP file can declare a type, so declarations only skip files with no declaration at all. */
const DECL_HINT = /^[ \t]*(?:(?:final|abstract|readonly)[ \t]+)*(?:class|interface|trait|enum)[ \t]/m;
const BINDING_KINDS: EdgeKind[] = ["container", "contextual"];

interface Built {
  edges: ResolutionEdge[];
  declarationEdges: ResolutionEdge[];
  declarations: Declaration[];
  skipped: SkippedCall[];
  /** Edges whose abstract is runtime-computed, and the distinct call sites they came from. */
  computedEdges: ResolutionEdge[];
  computedSites: string[];
  filesScanned: number;
  filesWithBindings: number;
  filesWithDeclarations: number;
}

class LaravelAdapter implements StackAdapter {
  readonly id = "laravel" as const;
  private psr4: Psr4Map;
  private cache: Built | null = null;

  constructor(
    private readonly root: string,
    private readonly include: string[],
    private readonly exclude: string[],
  ) {
    this.psr4 = readPsr4(root);
  }

  private fileForSymbol(fqcn: string): { file: string | null; exists: boolean } {
    const candidates = symbolToFiles(this.psr4, fqcn);
    for (const c of candidates) {
      if (existsSync(join(this.root, c))) return { file: c, exists: true };
    }
    return { file: candidates[0] ?? null, exists: false };
  }

  private build(): Built {
    if (this.cache) return this.cache;
    const files = walkFiles(this.root, this.include, this.exclude, ".php");
    const edges: ResolutionEdge[] = [];
    const declarationEdges: ResolutionEdge[] = [];
    const declarations: Declaration[] = [];
    const skipped: SkippedCall[] = [];
    let filesWithBindings = 0;
    let filesWithDeclarations = 0;

    for (const rel of files) {
      let src: string;
      try {
        src = readFileSync(join(this.root, rel), "utf8");
      } catch {
        continue;
      }
      if (BINDING_HINT.test(src)) {
        filesWithBindings++;
        const result = extractBindings(src, rel);
        for (const b of result.bindings) edges.push(this.toEdge(b));
        for (const c of result.contextual) edges.push(this.toContextualEdge(c));
        skipped.push(...result.skipped);
      }
      if (DECL_HINT.test(src)) {
        filesWithDeclarations++;
        for (const d of extractDeclarations(src, rel)) {
          declarations.push(d);
          declarationEdges.push(...this.toDeclarationEdges(d));
        }
      }
    }

    const computedEdges = edges.filter((e) => e.computedAbstract === true);
    this.cache = {
      edges,
      declarationEdges,
      declarations,
      skipped,
      computedEdges,
      computedSites: [...new Set(computedEdges.map((e) => `${e.declaredIn}:${e.declaredLine}`))],
      filesScanned: files.length,
      filesWithBindings,
      filesWithDeclarations,
    };
    return this.cache;
  }

  private toEdge(b: Binding): ResolutionEdge {
    const concreteFile = b.concrete ? this.fileForSymbol(b.concrete).file : null;
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
      concreteFile,
      declaredIn: b.file,
      declaredLine: b.line,
      ...(b.abstractKind === "computed" ? { computedAbstract: true } : {}),
      ...(b.inferredFrom ? { inferredFrom: b.inferredFrom } : {}),
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  }

  private toContextualEdge(c: ContextualBinding): ResolutionEdge {
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
      concreteFile: c.givesKind === "class" && c.gives ? this.fileForSymbol(c.gives).file : null,
      declaredIn: c.file,
      declaredLine: c.line,
      context: c.context,
      ...(c.needsKind === "computed" ? { computedAbstract: true } : {}),
      note: notes.join("; "),
    };
  }

  /** One edge per declared parent/interface, so both directions are queryable. */
  private toDeclarationEdges(d: Declaration): ResolutionEdge[] {
    const out: ResolutionEdge[] = [];
    const push = (abstract: string, via: string) => {
      out.push({
        kind: "declaration",
        abstract,
        concrete: d.symbol,
        via,
        concreteFile: d.file,
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
    const { file, exists } = this.fileForSymbol(fqcn);
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
      file,
      exists,
      implementedBy,
      implements: implementsEdges,
      subtypes,
      supertypes,
      injections,
      injectedInto,
      caveats: this.caveatsFor(built, implementedBy.length === 0),
    };
  }

  /**
   * The caveats exist so an empty result can never be read as a negative answer. The failure
   * they prevent: a `foreach` over a class const bound 14 filter singletons through a computed
   * key, the site was dropped silently, and `implementedBy: []` looked like "nothing binds this".
   */
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
    out.push(`Only these directories were scanned: ${this.include.join(", ")}. Anything declared elsewhere is invisible here.`);
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
    return {
      adapter: this.id,
      root: this.root,
      psr4Prefixes: this.psr4.prefixes.length,
      phpFilesScanned: b.filesScanned,
      filesWithBindings: b.filesWithBindings,
      filesWithDeclarations: b.filesWithDeclarations,
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
  markers: ["artisan", "composer.json"],
  create(cfg: IndexConfig, root: string, globalExclude: string[]): StackAdapter {
    const opts = cfg.options as { bindingPaths?: string[] };
    const include = cfg.include ?? opts.bindingPaths ?? DEFAULT_INCLUDE;
    const exclude = [...new Set([...globalExclude, ...DEFAULT_EXCLUDE, ...(cfg.exclude ?? [])])];
    return new LaravelAdapter(root, include, exclude);
  },
};
