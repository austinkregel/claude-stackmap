import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./args.mjs";

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/**
 * Find duplicate .jsonl files under a directory, two ways: byte-identical content, and an
 * identical signature for files that differ only in incidental bytes. The signature is
 * `first timestamp | last timestamp | count of top-level user records`, which catches a file
 * written twice under different names.
 *
 * Takes an explicit directory — no default — so it never reaches into a location you did not name.
 */
export async function dupes(argv) {
  const { flags, positionals } = parseArgs(argv);
  const root = positionals[0];
  if (!root) throw new Error("usage: sm dupes <dir>  (directory to scan for duplicate .jsonl files)");
  const files = walk(root);
  const byHash = new Map(), bySig = new Map();

  for (const f of files) {
    const buf = readFileSync(f);
    const h = createHash("sha256").update(buf).digest("hex");
    (byHash.get(h) ?? byHash.set(h, []).get(h)).push(f);

    let first = null, last = null, turns = 0;
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.timestamp) { first ??= d.timestamp; last = d.timestamp; }
      if (d.type === "user" && !d.isSidechain && typeof (d.message?.content) === "string" && d.message.content.trim()) turns++;
    }
    if (first && turns) {
      const sig = `${first}|${last}|${turns}`;
      (bySig.get(sig) ?? bySig.set(sig, []).get(sig)).push(f);
    }
  }

  const identical = [...byHash.values()].filter((v) => v.length > 1);
  const sameSig = [...bySig.values()].filter((v) => v.length > 1);
  const result = {
    root, scanned: files.length,
    byteIdenticalGroups: identical.length,
    signatureIdenticalGroups: sameSig.length,
    groups: [...identical, ...sameSig].slice(0, 20),
  };
  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return identical.length || sameSig.length ? 3 : 0; }
  console.log(`scanned ${files.length} .jsonl file(s) under ${root}`);
  console.log(`byte-identical groups:      ${identical.length}`);
  console.log(`signature-identical groups: ${sameSig.length}`);
  for (const g of result.groups) { console.log(""); for (const p of g) console.log(`  ${p}`); }
  if (!identical.length && !sameSig.length) console.log("\nno duplicates found");
  return identical.length || sameSig.length ? 3 : 0;
}
