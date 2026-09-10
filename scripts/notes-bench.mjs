#!/usr/bin/env node
/** Measures note-store search at realistic store sizes. Reports latency and rank quality. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { NoteStore } = await import(join(root, "dist/notes/store.js"));
const { noteSearch } = await import(join(root, "dist/notes/tools.js"));

const WORDS = ("service provider binding contract repository closure runtime cache queue job listener " +
  "migration schema index dealer inventory incentive offer campaign budget keyword adgroup salesforce " +
  "kafka consumer webhook throttle retry backoff timeout serializer validator transformer").split(" ");
const rnd = (n) => Math.floor(Math.random() * n);
const sentence = (n) => Array.from({ length: n }, () => WORDS[rnd(WORDS.length)]).join(" ");

let failed = 0;
const check = (label, cond, detail = "") => { if (!cond) failed++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`); };

for (const N of [100, 1000, 5000]) {
  const dir = mkdtempSync(join(tmpdir(), `stackmap-bench-${N}-`));
  try {
    for (let i = 0; i < N; i++) {
      writeFileSync(join(dir, `note-${i}.md`),
        `---\nid: "note-${i}"\ntitle: "${sentence(6)}"\nstatus: current\ncreated: "2026-01-01T00:00:00Z"\n` +
        `verified_on: null\nrepo: null\ntags: [${JSON.stringify(WORDS[rnd(WORDS.length)])}]\n` +
        `supersedes: []\nsuperseded_by: []\nfiles:\n---\n\n${sentence(180)}\n`);
    }
    // A planted target with a distinctive term that appears nowhere else.
    writeFileSync(join(dir, "target.md"),
      `---\nid: "target"\ntitle: "Amortization rounding uses bankers rounding"\nstatus: current\n` +
      `created: "2026-01-01T00:00:00Z"\nverified_on: null\nrepo: null\ntags: ["amortization"]\n` +
      `supersedes: []\nsuperseded_by: []\nfiles:\n---\n\nThe amortization schedule rounds half-to-even, not half-up.\n`);

    const store = new NoteStore(dir);
    const t0 = process.hrtime.bigint();
    const cold = noteSearch(store, { query: "amortization rounding", limit: 5 }, null);
    const coldMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const t1 = process.hrtime.bigint();
    for (let i = 0; i < 10; i++) noteSearch(store, { query: "amortization rounding", limit: 5 }, null);
    const warmMs = Number(process.hrtime.bigint() - t1) / 1e6 / 10;

    console.log(`\nN=${N + 1} notes`);
    console.log(`  cold search (parse all):  ${coldMs.toFixed(1)} ms`);
    console.log(`  warm search (cached):     ${warmMs.toFixed(1)} ms`);
    check(`  target ranks #1 at N=${N + 1}`, cold.results[0]?.id === "target", cold.results[0]?.id);
    check(`  warm search under 50ms at N=${N + 1}`, warmMs < 50, `${warmMs.toFixed(1)}ms`);
    check(`  cold search under 2s at N=${N + 1}`, coldMs < 2000, `${coldMs.toFixed(1)}ms`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(failed === 0 ? "\nall benchmark checks passed" : `\n${failed} benchmark check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
