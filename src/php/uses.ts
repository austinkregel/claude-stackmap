/** Namespace + import table for a single PHP file, used to expand short class names. */
export interface UseTable {
  namespace: string | null;
  /** alias (short name) -> fully-qualified class name */
  imports: Map<string, string>;
}

const NAMESPACE_RE = /^\s*namespace\s+([A-Za-z0-9_\\]+)\s*;/m;
// `use A\B\C;` / `use A\B\C as D;` — skips `use function` and `use const`.
const USE_RE = /^\s*use\s+(?!function\s|const\s)([A-Za-z0-9_\\]+)(?:\s+as\s+([A-Za-z0-9_]+))?\s*;/gm;
// Grouped: `use A\B\{C, D as E};`
const GROUP_USE_RE = /^\s*use\s+(?!function\s|const\s)([A-Za-z0-9_\\]+)\\\{([^}]+)\}\s*;/gm;

export function parseUses(source: string): UseTable {
  const imports = new Map<string, string>();
  const ns = NAMESPACE_RE.exec(source)?.[1] ?? null;

  for (const m of source.matchAll(GROUP_USE_RE)) {
    const base = m[1]!;
    for (const part of m[2]!.split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const [path, alias] = piece.split(/\s+as\s+/i);
      const fq = `${base}\\${path!.trim()}`;
      imports.set(alias?.trim() ?? fq.split("\\").pop()!, fq);
    }
  }
  for (const m of source.matchAll(USE_RE)) {
    const fq = m[1]!;
    if (fq.includes("{")) continue; // handled by GROUP_USE_RE
    imports.set(m[2] ?? fq.split("\\").pop()!, fq);
  }
  return { namespace: ns, imports };
}

/**
 * Expand a class reference as written in source into a fully-qualified name.
 * Resolution order matches PHP: leading `\` is absolute, then imports, then current namespace.
 */
export function expandClass(table: UseTable, written: string): string {
  const name = written.trim();
  if (name.startsWith("\\")) return name.slice(1);
  const head = name.split("\\")[0]!;
  const hit = table.imports.get(head);
  if (hit) {
    const tail = name.slice(head.length);
    return tail ? hit + tail : hit;
  }
  if (name.includes("\\")) return name; // already qualified relative to root
  return table.namespace ? `${table.namespace}\\${name}` : name;
}
