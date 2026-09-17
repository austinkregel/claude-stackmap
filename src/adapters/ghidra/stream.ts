import { createReadStream } from "node:fs";

/**
 * Read a Ghidra export without holding it in memory: the file is one JSON object whose values are
 * either small (a number, or an object of a few fields) or a long array. This hands over each small
 * value whole and each array element on its own, so peak memory is one element rather than the whole
 * export (201 MB for a 29k-function program).
 *
 * It is a scanner, not a validator: every piece goes through JSON.parse, so malformed JSON throws,
 * naming the key it belongs to. Anything unexpected in the structure is an error, never skipped.
 */
export interface ExportHandlers {
  /** A top-level key whose value is not an array. */
  value(key: string, value: unknown): void;
  /** One element of a top-level array, in file order. */
  element(key: string, index: number, value: unknown): void;
}

export async function readExport(path: string, handlers: ExportHandlers): Promise<void> {
  const scanner = new ExportScanner(handlers, path);
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });
  for await (const chunk of stream) scanner.push(chunk as string);
  scanner.end();
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
/** Returned when the buffer ends mid-piece: the caller waits for the next chunk. */
const MORE = -1;

type State = "start" | "key" | "colon" | "value" | "after-value" | "element" | "after-element" | "done";

class ExportScanner {
  private buf = "";
  private pos = 0;
  private state: State = "start";
  private key = "";
  private index = 0;
  private ended = false;

  constructor(private readonly handlers: ExportHandlers, private readonly path: string) {}

  push(chunk: string): void {
    this.buf = this.pos > 0 ? this.buf.slice(this.pos) + chunk : this.buf + chunk;
    this.pos = 0;
    this.run();
  }

  end(): void {
    this.ended = true;
    this.run();
    if (this.state !== "done") this.fail(`the file ends before the top-level object is closed (in state "${this.state}")`);
  }

  private fail(what: string): never {
    throw new Error(`${this.path}: ${what}${this.key ? ` (at key "${this.key}")` : ""}`);
  }

  private run(): void {
    for (;;) {
      while (this.pos < this.buf.length && isSpace(this.buf[this.pos]!)) this.pos++;
      if (this.pos >= this.buf.length) {
        if (this.ended && this.state !== "done") this.fail(`the file ends in state "${this.state}"`);
        return;
      }
      const c = this.buf[this.pos]!;
      switch (this.state) {
        case "start":
          if (c !== "{") this.fail(`expected "{" at the start, got ${JSON.stringify(c)}`);
          this.pos++;
          this.state = "key";
          break;
        case "key": {
          if (c === "}") {
            this.pos++;
            this.state = "done";
            break;
          }
          if (c !== '"') this.fail(`expected a key or "}", got ${JSON.stringify(c)}`);
          const end = this.endOfString(this.pos);
          if (end === MORE) return;
          this.key = JSON.parse(this.buf.slice(this.pos, end)) as string;
          this.pos = end;
          this.state = "colon";
          break;
        }
        case "colon":
          if (c !== ":") this.fail(`expected ":", got ${JSON.stringify(c)}`);
          this.pos++;
          this.state = "value";
          break;
        case "value":
          if (c === "[") {
            this.pos++;
            this.index = 0;
            this.state = "element";
            break;
          }
          if (!this.takePiece("value")) return;
          break;
        case "element":
          if (c === "]") {
            this.pos++;
            this.state = "after-value";
            break;
          }
          if (!this.takePiece("element")) return;
          break;
        case "after-element":
          if (c === ",") {
            this.pos++;
            this.state = "element";
          } else if (c === "]") {
            this.pos++;
            this.state = "after-value";
          } else this.fail(`expected "," or "]" in an array, got ${JSON.stringify(c)}`);
          break;
        case "after-value":
          if (c === ",") {
            this.pos++;
            this.state = "key";
          } else if (c === "}") {
            this.pos++;
            this.state = "done";
          } else this.fail(`expected "," or "}", got ${JSON.stringify(c)}`);
          break;
        case "done":
          this.fail(`unexpected ${JSON.stringify(c)} after the top-level object`);
      }
    }
  }

  /** Parse one complete value at `pos` and hand it over. False means the buffer ends mid-value. */
  private takePiece(kind: "value" | "element"): boolean {
    const end = this.endOfValue(this.pos);
    if (end === MORE) return false;
    const text = this.buf.slice(this.pos, end);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.fail(`a value that is not JSON: ${(err as Error).message}`);
    }
    if (kind === "element") this.handlers.element(this.key, this.index++, parsed);
    else this.handlers.value(this.key, parsed);
    this.pos = end;
    this.state = kind === "element" ? "after-element" : "after-value";
    return true;
  }

  /** Index just past the JSON string starting at `start`, or MORE. */
  private endOfString(start: number): number {
    for (let i = start + 1; i < this.buf.length; i++) {
      const c = this.buf[i]!;
      if (c === "\\") i++;
      else if (c === '"') return i + 1;
    }
    if (this.ended) this.fail("an unterminated string");
    return MORE;
  }

  /** Index just past the JSON value starting at `start`, or MORE. */
  private endOfValue(start: number): number {
    const first = this.buf[start]!;
    if (first === '"') return this.endOfString(start);
    if (first === "{" || first === "[") {
      let depth = 0;
      for (let i = start; i < this.buf.length; i++) {
        const c = this.buf[i]!;
        if (c === '"') {
          const end = this.endOfString(i);
          if (end === MORE) return MORE;
          i = end - 1;
          continue;
        }
        if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          depth--;
          if (depth === 0) return i + 1;
          if (depth < 0) this.fail(`a stray ${JSON.stringify(c)}`);
        }
      }
      if (this.ended) this.fail("a value that is never closed");
      return MORE;
    }
    // A number, true, false or null: it ends at the delimiter that follows, which the enclosing
    // object or array guarantees, so running out of buffer means the value is incomplete.
    for (let i = start; i < this.buf.length; i++) {
      const c = this.buf[i]!;
      if (c === "," || c === "}" || c === "]" || isSpace(c)) return i;
    }
    if (this.ended) this.fail("a value at the end of the file with nothing closing it");
    return MORE;
  }
}
