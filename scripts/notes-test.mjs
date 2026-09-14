#!/usr/bin/env node
/** Note-store suite: supersession, retraction weighting, and provenance drift. */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { NoteStore } = await import(join(root, "dist/notes/store.js"));
const { noteWrite, noteSearch, noteGet, noteSupersede } = await import(join(root, "dist/notes/tools.js"));

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};

const dir = mkdtempSync(join(tmpdir(), "stackmap-notes-"));
const repo = mkdtempSync(join(tmpdir(), "stackmap-repo-"));
try {
  const store = new NoteStore(join(dir, "notes"));
  writeFileSync(join(repo, "service.php"), "<?php class A { function go() { return 1; } }\n");

  console.log("-- write + stamp --");
  const w = noteWrite(store, {
    title: "Budget service resolves through a closure",
    body: "AdWordsServiceProvider binds BudgetServiceContract to a closure, so the concrete type is runtime-decided.",
    files: ["service.php"], tags: ["laravel", "di"], repo: "fuel",
  }, repo);
  check("note written", w.written === "budget-service-resolves-through-a-closure", w.written);
  check("file was content-stamped", w.stampedFiles === 1, JSON.stringify(w));

  console.log("\n-- search finds it, drift clean --");
  let r = noteSearch(store, { query: "budget closure" }, repo);
  check("found by query", r.results.length === 1, JSON.stringify(r.results.map(x => x.id)));
  check("no drift while file is untouched", r.results[0].drift[0].state === "unchanged", JSON.stringify(r.results[0].drift));
  check("no caveat while ground is intact", r.results[0].caveat === null, String(r.results[0].caveat));
  const cleanScore = r.results[0].score;

  console.log("\n-- drift: change the file underneath the note --");
  appendFileSync(join(repo, "service.php"), "// edited after the conclusion was written\n");
  r = noteSearch(store, { query: "budget closure" }, repo);
  check("drift now reports 'changed'", r.results[0].drift[0].state === "changed", JSON.stringify(r.results[0].drift));
  check("caveat warns the conclusion predates the change", /predates 1 change/.test(r.results[0].caveat ?? ""), String(r.results[0].caveat));
  check("score demoted vs clean ground", r.results[0].score < cleanScore, `${r.results[0].score} vs ${cleanScore}`);

  console.log("\n-- missing file is reported, not silently ignored --");
  rmSync(join(repo, "service.php"));
  check("drift reports 'missing'", noteGet(store, { id: w.written }, repo).drift[0].state === "missing");

  console.log("\n-- supersession --");
  noteWrite(store, { title: "Budget service now binds concretely", body: "The closure was replaced with a direct binding.", repo: "fuel" }, repo);
  const s = noteSupersede(store, { old_id: "budget-service-resolves-through-a-closure", new_id: "budget-service-now-binds-concretely" });
  check("both sides updated", s.updated.length === 2, JSON.stringify(s));
  const old = noteGet(store, { id: "budget-service-resolves-through-a-closure" }, repo);
  check("old note demoted, not deleted", old.found && old.status === "superseded", JSON.stringify(old.status));
  check("back-link recorded", old.supersededBy.includes("budget-service-now-binds-concretely"), JSON.stringify(old.supersededBy));

  console.log("\n-- retracted notes are hidden by default but retrievable --");
  noteWrite(store, { title: "Wrong turn about caching", body: "Believed the cache was per-request. It is not.", status: "retracted", repo: "fuel" }, repo);
  check("hidden by default", noteSearch(store, { query: "caching wrong turn" }, repo).results.length === 0);
  check("surfaced when asked", noteSearch(store, { query: "caching wrong turn", include_retracted: true }, repo).results.length === 1);

  console.log("\n-- validation --");
  let threw = false;
  try { noteWrite(store, { title: "x", body: "y", status: "bogus" }, repo); } catch { threw = true; }
  check("invalid status rejected", threw);
  threw = false;
  try { noteSupersede(store, { old_id: "nope", new_id: "also-nope" }); } catch { threw = true; }
  check("supersede on missing ids rejected", threw);
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
console.log(failed === 0 ? "\nall note checks passed" : `\n${failed} note check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
