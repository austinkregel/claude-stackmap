/**
 * String and number literals in PHP source, with where each one is written.
 *
 * This is what `stackmap_xref` searches in a source project, the counterpart of an instruction's
 * operands in a compiled one. It is a scanner, not a parser: it walks the file once, tracking whether
 * it is in code, a comment, or a string, so a literal inside a comment is not reported as a use.
 *
 * What it deliberately does not read is counted, never skipped silently:
 *   - heredoc and nowdoc bodies (`<<<ID` … `ID`), whose content is usually a template, not a literal;
 *   - backtick shell-exec strings.
 * A double-quoted string that interpolates (`"$name"`, `"{$a->b}"`) is reported with
 * `interpolated: true`: its text at run time is not what is written.
 */
export type LiteralKind = "string" | "number";

export interface PhpLiteral {
  kind: LiteralKind;
  /** A string's value with escapes decoded; a number's digits as written. */
  value: string;
  /** Exactly as it appears in the file, quotes and all. */
  raw: string;
  line: number;
  column: number;
  interpolated?: boolean;
}

export interface LiteralScan {
  literals: PhpLiteral[];
  /** Counts of what the scanner stepped over rather than reading. */
  heredocs: number;
  shellExec: number;
}

const DIGITS = /[0-9]/;
const NUMBER_START = /[0-9.]/;
const IDENT = /[A-Za-z0-9_\u0080-\uffff]/;

/** Decode the escapes PHP applies inside a double-quoted string; single quotes keep all but \\ and \'. */
function decodeDouble(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      out += raw[i];
      continue;
    }
    const next = raw[++i];
    if (next === undefined) return `${out}\\`;
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", v: "\v", e: "\x1b", f: "\f", "\\": "\\", $: "$", '"': '"' };
    if (next in simple) {
      out += simple[next];
      continue;
    }
    if (next === "x" && /[0-9A-Fa-f]/.test(raw[i + 1] ?? "")) {
      let hex = "";
      while (hex.length < 2 && /[0-9A-Fa-f]/.test(raw[i + 1] ?? "")) hex += raw[++i];
      out += String.fromCharCode(parseInt(hex, 16));
      continue;
    }
    if (next === "u" && raw[i + 1] === "{") {
      const end = raw.indexOf("}", i + 2);
      if (end > 0) {
        out += String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16));
        i = end;
        continue;
      }
    }
    if (/[0-7]/.test(next)) {
      let oct = next;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] ?? "")) oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
      continue;
    }
    out += `\\${next}`; // PHP keeps an unknown escape as written
  }
  return out;
}

const decodeSingle = (raw: string) => raw.replace(/\\(['\\])/g, "$1");

export function scanLiterals(source: string): LiteralScan {
  const literals: PhpLiteral[] = [];
  let heredocs = 0;
  let shellExec = 0;
  let line = 1;
  let lineStart = 0;
  const at = (i: number) => ({ line, column: i - lineStart + 1 });

  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\n") {
      line++;
      lineStart = i + 1;
      continue;
    }
    // Comments
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      i--;
      continue;
    }
    if (c === "#") {
      // #[Attribute] is code, not a comment.
      if (source[i + 1] === "[") continue;
      while (i < source.length && source[i] !== "\n") i++;
      i--;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let j = i; j < stop; j++) {
        if (source[j] === "\n") {
          line++;
          lineStart = j + 1;
        }
      }
      i = stop - 1;
      continue;
    }
    // Heredoc / nowdoc: step over the body and count it.
    if (c === "<" && source.startsWith("<<<", i)) {
      const header = /^<<<[ \t]*(['"]?)([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)\1\r?\n/.exec(source.slice(i));
      if (header) {
        heredocs++;
        const label = header[2]!;
        const bodyStart = i + header[0].length;
        const end = new RegExp(`^[ \\t]*${label}\\b`, "m").exec(source.slice(bodyStart));
        const stop = end ? bodyStart + end.index + end[0].length : source.length;
        for (let j = i; j < stop; j++) {
          if (source[j] === "\n") {
            line++;
            lineStart = j + 1;
          }
        }
        i = stop - 1;
        continue;
      }
    }
    // Strings
    if (c === "'" || c === '"' || c === "`") {
      const start = i;
      const where = at(i);
      let body = "";
      let closed = false;
      for (i++; i < source.length; i++) {
        const ch = source[i]!;
        if (ch === "\\" && c !== "`") {
          body += ch + (source[i + 1] ?? "");
          i++;
          continue;
        }
        if (ch === c) {
          closed = true;
          break;
        }
        if (ch === "\n") {
          line++;
          lineStart = i + 1;
        }
        body += ch;
      }
      if (!closed) i = source.length; // an unterminated string ends the file
      if (c === "`") {
        shellExec++;
        continue;
      }
      const raw = source.slice(start, Math.min(i + 1, source.length));
      const literal: PhpLiteral = {
        kind: "string",
        value: c === "'" ? decodeSingle(body) : decodeDouble(body),
        raw,
        line: where.line,
        column: where.column,
      };
      if (c === '"' && /\$[A-Za-z_{]|\{\$/.test(body)) literal.interpolated = true;
      literals.push(literal);
      continue;
    }
    // Numbers, only where one can start: not inside an identifier like `base64_x2`.
    if (NUMBER_START.test(c)) {
      const prev = source[i - 1] ?? "";
      if (IDENT.test(prev) || prev === "$") continue;
      const m = /^(?:0[xX][0-9A-Fa-f_]+|0[bB][01_]+|0[oO][0-7_]+|(?:[0-9][0-9_]*)?\.?[0-9][0-9_]*(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(i));
      if (!m) continue;
      const raw = m[0];
      literals.push({ kind: "number", value: raw.replace(/_/g, ""), raw, ...at(i) });
      i += raw.length - 1;
      continue;
    }
  }
  return { literals, heredocs, shellExec };
}

/** A PHP number literal as an integer, or null when it isn't one (a float, or too odd to read). */
export function literalValue(text: string): bigint | null {
  const clean = text.replace(/_/g, "");
  try {
    if (/^0[xX][0-9A-Fa-f]+$/.test(clean)) return BigInt(clean);
    if (/^0[bB][01]+$/.test(clean)) return BigInt(clean);
    if (/^0[oO][0-7]+$/.test(clean)) return BigInt(`0o${clean.slice(2)}`);
    if (/^0[0-7]+$/.test(clean)) return BigInt(`0o${clean.slice(1)}`); // PHP's legacy octal
    if (/^[0-9]+$/.test(clean)) return BigInt(clean);
  } catch {
    return null;
  }
  return null;
}
