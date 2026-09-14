import { createReadStream, statSync, openSync, readSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "./args.mjs";

/**
 * Slice a large file without loading it. Always reports total size/lines alongside what was
 * emitted, so a truncated read is visible instead of silent.
 */
export async function slice(argv) {
  const { flags, positionals } = parseArgs(argv);
  const file = positionals[0];
  if (!file) throw new Error("usage: sm slice <file> --lines A-B | --bytes A-B | --head N | --tail N");
  const size = statSync(file).size;

  if (flags.bytes && flags.bytes !== true) {
    const m = /^(\d+)-(\d+)$/.exec(String(flags.bytes));
    if (!m) throw new Error("--bytes expects A-B");
    const [start, end] = [Number(m[1]), Math.min(Number(m[2]), size)];
    const len = Math.max(0, end - start);
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(len);
      const got = readSync(fd, buf, 0, len, start);
      process.stdout.write(buf.subarray(0, got));
      console.error(`-- bytes ${start}-${start + got} of ${size}${got < len ? ` (SHORT READ: wanted ${len}, got ${got})` : ""}`);
      return got < len ? 3 : 0;
    } finally { closeSync(fd); }
  }

  let want = null;
  if (flags.lines && flags.lines !== true) {
    const m = /^(\d+)-(\d+)$/.exec(String(flags.lines));
    if (!m) throw new Error("--lines expects A-B (1-indexed, inclusive)");
    want = { from: Number(m[1]), to: Number(m[2]) };
  } else if (flags.head) want = { from: 1, to: Number(flags.head) };

  const tailN = flags.tail ? Number(flags.tail) : null;
  const ring = [];
  let total = 0, emitted = 0;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    total++;
    if (tailN) { ring.push(line); if (ring.length > tailN) ring.shift(); continue; }
    if (!want) continue;
    if (total >= want.from && total <= want.to) { console.log(line); emitted++; }
  }
  if (tailN) { for (const l of ring) console.log(l); emitted = ring.length; }

  if (!want && !tailN) {
    console.error(`-- ${file}: ${total} lines, ${size} bytes. Pass --lines/--head/--tail to emit a slice.`);
    return 0;
  }
  const requested = tailN ?? (want.to - want.from + 1);
  const short = emitted < requested && (tailN ? total > emitted : want.to <= total);
  console.error(`-- emitted ${emitted} of ${total} lines (${size} bytes total)${short ? " (SHORT: fewer lines than requested)" : ""}`);
  return short ? 3 : 0;
}
