import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs, buildPredicate, project, report } from "./args.mjs";

/** Resolve a dotted path like `message.content.0.text` against a row. */
function dig(row, path) {
  return path.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), row);
}

export async function jsonl(argv) {
  const { flags, positionals } = parseArgs(argv);
  if (positionals.length === 0) throw new Error("usage: sm jsonl <file...> [--where k=v] [--pick a,b] [--count]");
  const pred = buildPredicate(flags.where);
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  const asJson = Boolean(flags.json);
  const stats = { files: 0, read: 0, matched: 0, parseErrors: 0, emitted: 0 };
  const out = [];

  for (const file of positionals) {
    stats.files++;
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      stats.read++;
      let row;
      try { row = JSON.parse(line); } catch { stats.parseErrors++; continue; }
      const target = flags["jq-ish"] ? dig(row, String(flags["jq-ish"])) : row;
      if (!pred(target && typeof target === "object" ? target : row)) continue;
      stats.matched++;
      if (flags.count) continue;
      if (stats.emitted >= limit) continue;
      stats.emitted++;
      out.push(project(target, flags.pick));
    }
  }

  if (flags.count) {
    console.log(asJson ? JSON.stringify({ ...stats }) : String(stats.matched));
  } else if (asJson) {
    console.log(JSON.stringify({ rows: out, _stats: stats }));
  } else {
    for (const r of out) console.log(typeof r === "string" ? r : JSON.stringify(r));
  }
  // Parse errors are always reported, never swallowed.
  if (!asJson) report(stats, false);
  return stats.parseErrors > 0 ? 3 : 0;
}
