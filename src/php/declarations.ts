import { parseUses, expandClass } from "./uses.js";

export type DeclarationKind = "class" | "interface" | "trait" | "enum";

export interface Declaration {
  /** Fully-qualified name of the declared type. */
  symbol: string;
  kind: DeclarationKind;
  isAbstract: boolean;
  /** Fully-qualified parents. A class has at most one; an interface may extend several. */
  extends: string[];
  /** Fully-qualified interfaces this type declares. */
  implements: string[];
  file: string;
  line: number;
}

/**
 * Anchored at the start of a line so `Foo::class`, `$this->class`, and docblock prose can't
 * match. PHP allows the modifiers in any order, hence the repeated alternation.
 */
const DECL_RE =
  /^[ \t]*(?:(?:final|abstract|readonly)[ \t]+)*(class|interface|trait|enum)[ \t]+([A-Za-z_][A-Za-z0-9_]*)([^{;]*)/gm;
const EXTENDS_RE = /\bextends\s+([A-Za-z0-9_\\, \t\r\n]+?)(?=\s*(?:implements\b|$))/i;
const IMPLEMENTS_RE = /\bimplements\s+([A-Za-z0-9_\\, \t\r\n]+)$/i;

function names(list: string | undefined, table: ReturnType<typeof parseUses>): string[] {
  if (!list) return [];
  return list
    .split(",")
    .map((n) => n.trim())
    .filter((n) => /^[A-Za-z_\\][A-Za-z0-9_\\]*$/.test(n))
    .map((n) => expandClass(table, n));
}

/** Extract every type declared in one PHP file, with its parents and interfaces resolved. */
export function extractDeclarations(source: string, relFile: string): Declaration[] {
  const table = parseUses(source);
  const out: Declaration[] = [];

  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (off: number) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= off) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  DECL_RE.lastIndex = 0;
  for (const m of source.matchAll(DECL_RE)) {
    const kind = m[1]! as DeclarationKind;
    const short = m[2]!;
    // `enum Suit: string implements HasColor` — the backing type is not a parent.
    const tail = (m[3] ?? "").replace(/^\s*:\s*[A-Za-z_][A-Za-z0-9_]*/, "").trim();
    const isAbstract = /\babstract\b/.test(m[0]!.slice(0, m[0]!.indexOf(kind)));
    out.push({
      symbol: table.namespace ? `${table.namespace}\\${short}` : short,
      kind,
      isAbstract,
      extends: names(EXTENDS_RE.exec(tail)?.[1], table),
      implements: names(IMPLEMENTS_RE.exec(tail)?.[1], table),
      file: relFile,
      line: lineAt(m.index!),
    });
  }
  return out;
}
