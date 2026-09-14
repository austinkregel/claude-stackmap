import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./args.mjs";

const TEXT_GROUP_LIMIT = 20;

/** Every .jsonl file under `dir`. The root must be readable; an unreadable subdirectory is recorded. */
function walk(dir, out, unreadable, isRoot = false) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isRoot) throw new Error(`cannot read directory ${dir} (${err.code ?? err.message})`);
    unreadable.push(dir);
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, unreadable);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

/**
 * Find duplicate .jsonl files under a directory, two ways: byte-identical content, and an
 * identical signature for files that differ only in incidental bytes. The signature is
 * `first timestamp | last timestamp | count of top-level user records`, which catches a file
 * written twice under different names. A signature group made only of byte-identical copies is
 * already a byte-identical group and is not repeated.
 *
 * Takes an explicit directory — no default — so it never reaches into a location you did not name.
 */
export async function dupes(argv) {
  const { flags, positionals } = parseArgs(argv);
  const root = positionals[0];
  if (!root) throw new Error("usage: sm dupes <dir> [--json]  (directory to scan for duplicate .jsonl files)");
  const files = [];
  const unreadable = [];
  walk(root, files, unreadable, true);
  const byHash = new Map(), bySig = new Map(), hashOf = new Map();
  let parseErrors = 0;

  for (const f of files) {
    let buf;
    try {
      buf = readFileSync(f);
    } catch {
      unreadable.push(f);
      continue;
    }
    const h = createHash("sha256").update(buf).digest("hex");
    hashOf.set(f, h);
    (byHash.get(h) ?? byHash.set(h, []).get(h)).push(f);

    let first = null, last = null, turns = 0;
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { parseErrors++; continue; }
      if (d.timestamp) { first ??= d.timestamp; last = d.timestamp; }
      if (d.type === "user" && !d.isSidechain && typeof (d.message?.content) === "string" && d.message.content.trim()) turns++;
    }
    if (first && turns) {
      const sig = `${first}|${last}|${turns}`;
      (bySig.get(sig) ?? bySig.set(sig, []).get(sig)).push(f);
    }
  }

  const identical = [...byHash.values()].filter((v) => v.length > 1);
  const sameSig = [...bySig.values()].filter((v) => v.length > 1 && new Set(v.map((f) => hashOf.get(f))).size > 1);
  const groups = [...identical, ...sameSig];
  const result = {
    root,
    scanned: files.length,
    unreadable,
    parseErrors,
    byteIdenticalGroups: identical.length,
    signatureIdenticalGroups: sameSig.length,
    groups,
  };
  const code = unreadable.length ? 1 : groups.length ? 3 : 0;
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return code;
  }
  console.log(`scanned ${files.length} .jsonl file(s) under ${root}`);
  console.log(`byte-identical groups:      ${identical.length}`);
  console.log(`signature-identical groups: ${sameSig.length}`);
  console.log(`unparseable lines:          ${parseErrors}`);
  if (unreadable.length) console.log(`unreadable:                 ${unreadable.length}\n${unreadable.map((p) => `  ${p}`).join("\n")}`);
  for (const g of groups.slice(0, TEXT_GROUP_LIMIT)) { console.log(""); for (const p of g) console.log(`  ${p}`); }
  if (groups.length > TEXT_GROUP_LIMIT) console.log(`\nshowing ${TEXT_GROUP_LIMIT} of ${groups.length} groups; pass --json for all of them`);
  if (!groups.length) console.log("\nno duplicates found");
  return code;
}
