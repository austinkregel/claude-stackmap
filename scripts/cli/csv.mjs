import { readFileSync } from "node:fs";
import { parseArgs, buildPredicate, project, report } from "./args.mjs";

/** RFC4180-ish parser: handles quoted fields, embedded delimiters, escaped quotes, CRLF. */
export function parseCsv(text, delim = ",") {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delim) { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export async function csv(argv) {
  const { flags, positionals } = parseArgs(argv);
  if (positionals.length === 0) throw new Error("usage: sm csv <file...> [--where k=v] [--select a,b] [--count]");
  const delim = flags.delim && flags.delim !== true ? String(flags.delim) : ",";
  const pred = buildPredicate(flags.where);
  const limit = flags.limit ? Number(flags.limit) : Infinity;
  const asJson = Boolean(flags.json);
  const stats = { files: 0, dataRows: 0, matched: 0, ragged: 0, emitted: 0 };
  const out = [];

  for (const file of positionals) {
    stats.files++;
    const rows = parseCsv(readFileSync(file, "utf8"), delim);
    if (rows.length === 0) continue;
    const header = rows[0].map((h) => h.trim());
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i];
      if (cells.length === 1 && cells[0] === "") continue; // trailing newline
      stats.dataRows++;
      // A row whose width differs from the header is the exact shape of silent data loss:
      // counted, reported, and still evaluated rather than silently dropped.
      if (cells.length !== header.length) stats.ragged++;
      const row = {};
      header.forEach((h, j) => { row[h] = cells[j] ?? ""; });
      if (!pred(row)) continue;
      stats.matched++;
      if (flags.count) continue;
      if (stats.emitted >= limit) continue;
      stats.emitted++;
      out.push(project(row, flags.select));
    }
  }

  if (flags.count) console.log(asJson ? JSON.stringify(stats) : String(stats.matched));
  else if (asJson) console.log(JSON.stringify({ rows: out, _stats: stats }));
  else for (const r of out) console.log(JSON.stringify(r));
  if (!asJson) report(stats, false);
  if (stats.ragged > 0 && !asJson) {
    console.error(`-- WARNING: ${stats.ragged} row(s) had a different column count than the header.`);
  }
  return stats.ragged > 0 ? 3 : 0;
}
