import { parseUses, expandClass, type UseTable } from "./uses.js";

export type ConcreteKind = "class" | "closure" | "self" | "unknown";
export type AbstractKind = "class" | "string" | "computed";

export interface Binding {
  /** Container method: bind, singleton, scoped, ... */
  method: string;
  /**
   * Fully-qualified abstract, the literal string key when bound by name, or — when
   * `abstractKind` is "computed" — the expression as written in source.
   */
  abstract: string;
  abstractKind: AbstractKind;
  /** Fully-qualified concrete when statically determinable. */
  concrete: string | null;
  concreteKind: ConcreteKind;
  /**
   * Set when the concrete was recovered by expanding a class-const array iterated at this
   * site, e.g. "static::FILTERS". The edge is derived, not written literally at the call.
   */
  inferredFrom?: string;
  /** Repo-relative file the binding was declared in. */
  file: string;
  line: number;
}

export interface ContextualBinding {
  /** The class being resolved when this override applies (`when(...)`). */
  context: string;
  contextKind: "class" | "computed";
  /** The dependency being overridden: an FQCN, or a `$variable` for a primitive. */
  needs: string;
  needsKind: "class" | "variable" | "string" | "computed";
  /** The concrete given, when statically determinable. */
  gives: string | null;
  givesKind: ConcreteKind | "tagged" | "config";
  /** give, giveTagged, or giveConfig. */
  method: string;
  file: string;
  line: number;
}

/**
 * A call whose method name looks like a binding but whose receiver is not the container.
 * Reported rather than dropped: `Route::bind()` produced three false container bindings
 * before the receiver check existed, and a silent skip is how that stayed invisible.
 */
export interface SkippedCall {
  receiver: string;
  method: string;
  file: string;
  line: number;
}

export interface ExtractResult {
  bindings: Binding[];
  contextual: ContextualBinding[];
  skipped: SkippedCall[];
}

const BIND_RE = /(?<![A-Za-z0-9_$])(bind|bindIf|singleton|singletonIf|scoped|scopedIf|instance)\s*\(/g;
const WHEN_RE = /(?<![A-Za-z0-9_$])when\s*\(/g;

/**
 * Receiver forms that are the service container. A whitelist, not a blacklist: `Route::bind()`,
 * `$router->bind()`, and a `public function bind()` declaration all reach the same method names,
 * and only the container's bindings belong in the resolution table.
 */
const CONTAINER_RECEIVER_RE =
  /(?:^|[^A-Za-z0-9_$\\])((?:\$this->app|\$this->container|\$app|\$container|app\(\)|App|Container::getInstance\(\))\s*(?:->|::)\s*)$/;
/** Any receiver at all, used to tell "not the container" from "not a method call". */
const ANY_RECEIVER_RE = /([A-Za-z0-9_$\\]+(?:\s*\([^()]*\))?|\)|\])\s*(?:->|::)\s*$/;

/** Capture the argument text of a call whose `(` sits at `openIdx`. Returns null if unbalanced. */
function captureArgs(src: string, openIdx: number): { args: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return { args: src.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

/** Split on commas that sit at nesting depth 0 and outside quotes. */
function splitTopLevel(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) { out.push(args.slice(start, i)); start = i + 1; }
  }
  out.push(args.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

const CLASS_CONST_RE = /^([A-Za-z0-9_\\]+)::class$/;
const STRING_RE = /^(['"])(.*)\1$/s;
const VARIABLE_RE = /^\$[A-Za-z_][A-Za-z0-9_]*$/;

/** Collapse an expression to one readable line for reporting. */
function expr(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function classify(arg: string, table: UseTable): { value: string | null; kind: ConcreteKind | "string" } {
  const cls = CLASS_CONST_RE.exec(arg);
  if (cls) return { value: expandClass(table, cls[1]!), kind: "class" };
  const str = STRING_RE.exec(arg);
  if (str) {
    const inner = str[2]!;
    // A quoted FQCN is still a class reference in practice.
    if (/^\\?[A-Za-z_][A-Za-z0-9_]*(\\[A-Za-z_][A-Za-z0-9_]*)+$/.test(inner)) {
      return { value: inner.replace(/^\\/, ""), kind: "class" };
    }
    return { value: inner, kind: "string" };
  }
  if (/^(static\s+)?function\s*\(|^fn\s*\(|^\[/.test(arg)) return { value: null, kind: "closure" };
  return { value: null, kind: "unknown" };
}

/** Line-number lookup over precomputed line starts. */
function lineIndex(source: string) {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return (off: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= off) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Classify the receiver sitting immediately before `idx`. */
function receiverAt(source: string, idx: number): { container: boolean; text: string } {
  const before = source.slice(Math.max(0, idx - 96), idx);
  const container = CONTAINER_RECEIVER_RE.exec(before);
  if (container) return { container: true, text: expr(container[1]!, 40) };
  const any = ANY_RECEIVER_RE.exec(before);
  return { container: false, text: any ? expr(any[0]!, 40) : "" };
}

/** Skip whitespace and a `->name(` link in a fluent chain. Returns the captured args. */
function chainCall(source: string, from: number, names: string[]): { name: string; args: string; end: number } | null {
  const re = new RegExp(`^\\s*->\\s*(${names.join("|")})\\s*\\(`);
  const m = re.exec(source.slice(from, from + 200));
  if (!m) return null;
  const openIdx = from + m[0]!.length - 1;
  const captured = captureArgs(source, openIdx);
  if (!captured) return null;
  return { name: m[1]!, args: captured.args, end: captured.end };
}

const CONST_ARRAY_RE = (name: string) =>
  new RegExp(`(?:^|[^A-Za-z0-9_])const\\s+${name}\\s*=\\s*\\[`, "m");

/**
 * Resolve a class-const array declared in the same file to its `key => value` element pairs.
 * Static evaluation of a literal const only — no interpretation of anything runtime-decided.
 */
function constArrayPairs(source: string, ref: string): Array<{ key: string | null; value: string }> | null {
  const name = /^(?:static|self|static::|self::)?::?([A-Z][A-Za-z0-9_]*)$/.exec(ref.trim())?.[1]
    ?? /^([A-Z][A-Za-z0-9_]*)$/.exec(ref.trim())?.[1];
  if (!name) return null;
  const decl = CONST_ARRAY_RE(name).exec(source);
  if (!decl) return null;
  const openIdx = decl.index + decl[0]!.length - 1;
  const captured = captureArgs(source, openIdx);
  if (!captured) return null;
  return splitTopLevel(captured.args).map((element) => {
    const arrow = splitArrow(element);
    return arrow ? { key: arrow[0], value: arrow[1] } : { key: null, value: element };
  });
}

/** Split `key => value` at the top-level `=>`, if there is one. */
function splitArrow(element: string): [string, string] | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < element.length - 1; i++) {
    const ch = element[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === "=" && element[i + 1] === ">") {
      return [element.slice(0, i).trim(), element.slice(i + 2).trim()];
    }
  }
  return null;
}

interface Loop {
  /** The iterated expression as written, e.g. "static::FILTERS". */
  subject: string;
  keyVar: string | null;
  valueVar: string;
}

const FOREACH_RE = /foreach\s*\(\s*([^)]*?)\s+as\s+(\$[A-Za-z_][A-Za-z0-9_]*)\s*(?:=>\s*(\$[A-Za-z_][A-Za-z0-9_]*)\s*)?\)/g;

/** The innermost `foreach` header preceding `idx`, if any. */
function enclosingLoop(source: string, idx: number): Loop | null {
  let best: Loop | null = null;
  FOREACH_RE.lastIndex = 0;
  for (const m of source.matchAll(FOREACH_RE)) {
    if (m.index! >= idx) break;
    best = m[3]
      ? { subject: m[1]!.trim(), keyVar: m[2]!, valueVar: m[3]! }
      : { subject: m[1]!.trim(), keyVar: null, valueVar: m[2]! };
  }
  return best;
}

/** Extract container bindings, contextual bindings, and skipped lookalikes from one PHP file. */
export function extractBindings(source: string, relFile: string): ExtractResult {
  const table = parseUses(source);
  const lineAt = lineIndex(source);
  const bindings: Binding[] = [];
  const contextual: ContextualBinding[] = [];
  const skipped: SkippedCall[] = [];

  BIND_RE.lastIndex = 0;
  for (const m of source.matchAll(BIND_RE)) {
    const method = m[1]!;
    const line = lineAt(m.index!);
    const receiver = receiverAt(source, m.index!);
    if (!receiver.container) {
      // A real method call on something else (Route::bind, $router->bind) is worth reporting.
      // No receiver at all means a declaration or a plain function — not a binding either way.
      if (receiver.text) skipped.push({ receiver: receiver.text, method, file: relFile, line });
      continue;
    }
    const openIdx = m.index! + m[0]!.length - 1;
    const captured = captureArgs(source, openIdx);
    if (!captured) continue;
    const parts = splitTopLevel(captured.args);
    if (parts.length === 0) continue;

    const abs = classify(parts[0]!, table);
    const con = parts.length > 1 ? classify(parts[1]!, table) : null;

    if (abs.value !== null) {
      if (!con) {
        bindings.push({
          method, abstract: abs.value, abstractKind: abs.kind === "string" ? "string" : "class",
          concrete: abs.kind === "class" ? abs.value : null,
          concreteKind: abs.kind === "class" ? "self" : "unknown",
          file: relFile, line,
        });
      } else {
        bindings.push({
          method, abstract: abs.value, abstractKind: abs.kind === "string" ? "string" : "class",
          concrete: con.kind === "class" ? con.value : null,
          concreteKind: con.kind === "string" ? "unknown" : (con.kind as ConcreteKind),
          file: relFile, line,
        });
      }
      continue;
    }

    // The abstract is computed. Emitting nothing here is the worst available outcome: an empty
    // `implementedBy` then reads as "nothing binds this" when the site may bind many abstracts.
    const expanded = expandLoopSite(source, table, parts, m.index!, method, relFile, line);
    if (expanded.length > 0) { bindings.push(...expanded); continue; }
    bindings.push({
      method, abstract: expr(parts[0]!), abstractKind: "computed",
      concrete: con && con.kind === "class" ? con.value : null,
      concreteKind: con ? (con.kind === "string" ? "unknown" : (con.kind as ConcreteKind)) : "unknown",
      file: relFile, line,
    });
  }

  WHEN_RE.lastIndex = 0;
  for (const m of source.matchAll(WHEN_RE)) {
    const line = lineAt(m.index!);
    if (!receiverAt(source, m.index!).container) continue;
    const openIdx = m.index! + m[0]!.length - 1;
    const whenArgs = captureArgs(source, openIdx);
    if (!whenArgs) continue;
    const needs = chainCall(source, whenArgs.end + 1, ["needs"]);
    if (!needs) continue;
    const give = chainCall(source, needs.end + 1, ["give", "giveTagged", "giveConfig"]);

    // `when([A::class, B::class])` applies the same override to several classes.
    const raw = whenArgs.args.trim();
    const contexts = raw.startsWith("[")
      ? splitTopLevel(raw.slice(1, -1))
      : splitTopLevel(raw);
    const needsArg = needs.args.trim();
    const needsClass = classify(needsArg, table);
    const needsInner = STRING_RE.exec(needsArg)?.[2] ?? needsArg;
    const needsKind: ContextualBinding["needsKind"] =
      VARIABLE_RE.test(needsInner) ? "variable"
        : needsClass.kind === "class" ? "class"
          : needsClass.kind === "string" ? "string" : "computed";

    for (const ctx of contexts) {
      const ctxClass = classify(ctx, table);
      const gives = give ? classify(give.args.trim(), table) : null;
      const givesKind: ContextualBinding["givesKind"] = !give
        ? "unknown"
        : give.name === "giveTagged" ? "tagged"
          : give.name === "giveConfig" ? "config"
            : gives!.kind === "string" ? "unknown" : (gives!.kind as ConcreteKind);
      contextual.push({
        context: ctxClass.kind === "class" && ctxClass.value ? ctxClass.value : expr(ctx),
        contextKind: ctxClass.kind === "class" ? "class" : "computed",
        needs: needsKind === "variable" ? needsInner : (needsClass.value ?? expr(needsArg)),
        needsKind,
        gives: give && gives!.kind === "class" ? gives!.value : give ? STRING_RE.exec(give.args.trim())?.[2] ?? null : null,
        givesKind,
        method: give?.name ?? "give",
        file: relFile, line,
      });
    }
  }

  return { bindings, contextual, skipped };
}

/**
 * Recover the concretes bound by a `foreach` over a class-const array, e.g.
 * `foreach (static::FILTERS as $key => $class) { $this->app->singleton(f($key), $class); }`.
 *
 * The const is a literal declared in the same file, so this is static evaluation, not
 * interpretation — but the edges are derived rather than written, so each carries
 * `inferredFrom` and the loop key is substituted into the abstract expression.
 */
function expandLoopSite(
  source: string,
  table: UseTable,
  parts: string[],
  idx: number,
  method: string,
  relFile: string,
  line: number,
): Binding[] {
  const concreteArg = parts[1]?.trim();
  if (!concreteArg || !VARIABLE_RE.test(concreteArg)) return [];
  const loop = enclosingLoop(source, idx);
  if (!loop || loop.valueVar !== concreteArg) return [];
  const pairs = constArrayPairs(source, loop.subject);
  if (!pairs || pairs.length === 0) return [];

  const out: Binding[] = [];
  for (const pair of pairs) {
    const concrete = classify(pair.value, table);
    if (concrete.kind !== "class" || !concrete.value) continue;
    const abstractExpr = loop.keyVar && pair.key
      ? parts[0]!.split(loop.keyVar).join(pair.key)
      : parts[0]!;
    out.push({
      method,
      abstract: expr(abstractExpr),
      abstractKind: "computed",
      concrete: concrete.value,
      concreteKind: "class",
      inferredFrom: loop.subject,
      file: relFile, line,
    });
  }
  return out;
}
