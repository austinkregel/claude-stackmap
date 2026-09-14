import { createReadStream, statSync, openSync, readSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs, numberFlag } from "./args.mjs";

/** `A-B` with A <= B, at least `min`. */
function range(flag, value, min) {
  const m = /^(\d+)-(\d+)$/.exec(String(value));
  if (!m || Number(m[1]) < min || Number(m[1]) > Number(m[2])) {
    throw new Error(`--${flag} expects A-B with ${min} <= A <= B, got "${value === true ? "" : value}"`);
  }
  return { from: Number(m[1]), to: Number(m[2]) };
}

/**
 * Slice a large file without loading it. Always reports total size/lines alongside what was
 * emitted. A `--lines` or `--bytes` range that reaches past the end of the file is a short read
 * (exit 3); `--head`/`--tail` on a shorter file return what exists.
 */
export async function slice(argv) {
  const { flags, positionals } = parseArgs(argv);
  const file = positionals[0];
  if (!file) throw new Error("usage: sm slice <file> --lines A-B | --bytes A-B | --head N | --tail N [--json]");
  const asJson = Boolean(flags.json);
  const size = statSync(file).size;

  if ("bytes" in flags) {
    const { from, to } = range("bytes", flags.bytes, 0);
    const end = Math.min(to, size);
    const len = Math.max(0, end - from);
    const fd = openSync(file, "r");
    let got;
    const buf = Buffer.alloc(len);
    try {
      got = readSync(fd, buf, 0, len, from);
    } finally {
      closeSync(fd);
    }
    const short = got < to - from;
    const stats = { file, sizeBytes: size, from, to, got, short };
    if (asJson) console.log(JSON.stringify({ bytes: buf.subarray(0, got).toString("base64"), _stats: stats }));
    else {
      process.stdout.write(buf.subarray(0, got));
      console.error(`-- bytes ${from}-${from + got} of ${size}${short ? ` (SHORT READ: wanted ${to - from}, got ${got})` : ""}`);
    }
    return short ? 3 : 0;
  }

  let want = null;
  let mode = null;
  if ("lines" in flags) {
    want = range("lines", flags.lines, 1);
    mode = "lines";
  } else if ("head" in flags) {
    want = { from: 1, to: numberFlag(flags, "head", { min: 1, integer: true }) };
    mode = "head";
  }
  const tailN = "tail" in flags ? numberFlag(flags, "tail", { min: 1, integer: true }) : null;
  if (tailN) mode = "tail";

  const ring = [];
  const lines = [];
  let total = 0;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    total++;
    if (tailN) {
      ring.push(line);
      if (ring.length > tailN) ring.shift();
    } else if (want && total >= want.from && total <= want.to) {
      lines.push(line);
    }
  }
  const emitted = tailN ? ring : lines;

  if (!mode) {
    if (asJson) console.log(JSON.stringify({ _stats: { file, sizeBytes: size, totalLines: total } }));
    else console.error(`-- ${file}: ${total} lines, ${size} bytes. Pass --lines/--head/--tail to emit a slice.`);
    return 0;
  }
  const short = mode === "lines" && want.to > total;
  const stats = { file, sizeBytes: size, totalLines: total, mode, ...(want ? want : { last: tailN }), emitted: emitted.length, short };
  if (asJson) console.log(JSON.stringify({ lines: emitted, _stats: stats }));
  else {
    for (const l of emitted) console.log(l);
    console.error(`-- emitted ${emitted.length} of ${total} lines (${size} bytes total)${short ? ` (SHORT: the file ends at line ${total})` : ""}`);
  }
  return short ? 3 : 0;
}
