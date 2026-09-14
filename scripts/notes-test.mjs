#!/usr/bin/env node
/** Note-store suite: supersession, retraction weighting, provenance drift, and stamps across a project's roots. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
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
const throws = (fn, pattern) => {
  try {
    fn();
    return { ok: false, detail: "did not throw" };
  } catch (err) {
    return { ok: pattern.test(err.message), detail: err.message };
  }
};

const dir = mkdtempSync(join(tmpdir(), "stackmap-notes-"));
const repo = realpathSync(mkdtempSync(join(tmpdir(), "stackmap-repo-")));
const pkg = realpathSync(mkdtempSync(join(tmpdir(), "stackmap-pkg-")));
const other = realpathSync(mkdtempSync(join(tmpdir(), "stackmap-other-")));
const mainRoot = (path) => ({ kind: "root", configured: path, path, include: null, exclude: null });
const aliasRoot = (configured, path) => ({ kind: "alias", configured, path, include: null, exclude: null });
/** Projects the way the server resolves them: by the note's own repo name. */
let projects = { fuel: [mainRoot(repo), aliasRoot("~/pkg", pkg)], other: [mainRoot(other)] };
const rootsFor = (name) => (projects[name] ? { roots: projects[name] } : { roots: null, reason: `no enabled index named "${name}"` });
const stampFor = (name) => rootsFor(name);

try {
  const store = new NoteStore(join(dir, "notes"));
  writeFileSync(join(repo, "service.php"), "<?php class A { function go() { return 1; } }\n");

  console.log("-- write + stamp --");
  const w = noteWrite(store, {
    title: "Budget service resolves through a closure",
    body: "AdWordsServiceProvider binds BudgetServiceContract to a closure, so the concrete type is runtime-decided.",
    files: ["service.php"], tags: ["laravel", "di"], repo: "fuel",
  }, stampFor("fuel"));
  check("note written", w.written === "budget-service-resolves-through-a-closure", w.written);
  check("file was content-stamped", w.stampedFiles === 1, JSON.stringify(w));

  console.log("\n-- search finds it, drift clean --");
  let r = noteSearch(store, { query: "budget closure" }, rootsFor);
  check("found by query", r.results.length === 1, JSON.stringify(r.results.map(x => x.id)));
  check("no drift while file is untouched", r.results[0].drift[0].state === "unchanged", JSON.stringify(r.results[0].drift));
  check("no caveat while ground is intact", r.results[0].caveat === null, String(r.results[0].caveat));
  const cleanScore = r.results[0].score;

  console.log("\n-- drift: change the file underneath the note --");
  appendFileSync(join(repo, "service.php"), "// edited after the conclusion was written\n");
  r = noteSearch(store, { query: "budget closure" }, rootsFor);
  check("drift now reports 'changed'", r.results[0].drift[0].state === "changed", JSON.stringify(r.results[0].drift));
  check("caveat warns the conclusion predates the change", /predates 1 change/.test(r.results[0].caveat ?? ""), String(r.results[0].caveat));
  check("score demoted vs clean ground", r.results[0].score < cleanScore, `${r.results[0].score} vs ${cleanScore}`);

  console.log("\n-- missing file is reported, not silently ignored --");
  rmSync(join(repo, "service.php"));
  check("drift reports 'missing'", noteGet(store, { id: w.written }, rootsFor).drift[0].state === "missing");

  console.log("\n-- stamps across a project's roots --");
  writeFileSync(join(pkg, "Contract.php"), "<?php interface Contract {}\n");
  let n = noteWrite(store, { title: "Contract lives in the package", body: "It is declared in the alias root.", files: ["Contract.php"], repo: "fuel" }, stampFor("fuel"));
  let stored = store.get(n.written);
  check("a relative path found only in an alias records that alias", stored.files[0].root === "~/pkg" && stored.files[0].path === "Contract.php" && stored.files[0].sha256 !== "missing", JSON.stringify(stored.files));
  check("…and survives a round trip through the note file", /root: "~\/pkg"/.test(readFileSync(join(dir, "notes", `${n.written}.md`), "utf8")));
  check("…and resolves back to the alias for drift", noteGet(store, { id: n.written }, rootsFor).drift[0].state === "unchanged", JSON.stringify(noteGet(store, { id: n.written }, rootsFor).drift));
  writeFileSync(join(repo, "Contract.php"), "<?php interface Contract {}\n");
  let t = throws(() => noteWrite(store, { title: "ambiguous", body: "x", files: ["Contract.php"], repo: "fuel" }, stampFor("fuel")), /exists in more than one root .*pass an absolute path/);
  check("a relative path present in two roots is an error", t.ok, t.detail);
  n = noteWrite(store, { title: "absolute in alias", body: "x", files: [join(pkg, "Contract.php")], repo: "fuel" }, stampFor("fuel"));
  stored = store.get(n.written);
  check("an absolute path inside an alias is stored relative to it", stored.files[0].root === "~/pkg" && stored.files[0].path === "Contract.php", JSON.stringify(stored.files));
  n = noteWrite(store, { title: "not there yet", body: "x", files: ["later.php"], repo: "fuel" }, stampFor("fuel"));
  stored = store.get(n.written);
  check("a relative path in no root is stamped missing against the main root", stored.files[0].sha256 === "missing" && stored.files[0].root === undefined, JSON.stringify(stored.files));
  t = throws(() => noteWrite(store, { title: "no project", body: "x", files: ["service.php"], repo: "nowhere" }, stampFor("nowhere")), /can't stamp "service\.php" — no enabled index named "nowhere"/);
  check("a relative path with no resolvable project is an error", t.ok, t.detail);
  n = noteWrite(store, { title: "absolute without a project", body: "x", files: [join(pkg, "Contract.php")], repo: "nowhere" }, stampFor("nowhere"));
  check("an absolute path needs no project", store.get(n.written).files[0].path === join(pkg, "Contract.php"), JSON.stringify(store.get(n.written).files));
  check("a note without files needs no project", noteWrite(store, { title: "prose only", body: "x", repo: "nowhere" }, stampFor("nowhere")).stampedFiles === 0);

  writeFileSync(join(dir, "notes", "legacy.md"),
    `---\nid: "legacy"\ntitle: "Written before roots existed"\nstatus: current\ncreated: "2026-01-01T00:00:00Z"\nverified_on: null\nrepo: "fuel"\ntags: []\nsupersedes: []\nsuperseded_by: []\nfiles:\n  - path: "Contract.php"\n    sha256: "0000000000000000"\n    at: "2026-01-01T00:00:00Z"\n---\n\nOld note.\n`);
  const legacy = noteGet(store, { id: "legacy" }, rootsFor);
  check("an older stamp with no root resolves against the main root", legacy.drift[0].state === "changed" && legacy.drift[0].root === undefined, JSON.stringify(legacy.drift));

  const aliasNote = store.list().find((x) => x.title === "Contract lives in the package");
  projects = { fuel: [mainRoot(repo)], other: [mainRoot(other)] };
  const gone = noteGet(store, { id: aliasNote.id }, rootsFor);
  check("a stamp whose alias is no longer configured is 'unresolved', with the reason", gone.drift[0].state === "unresolved" && /alias "~\/pkg" is no longer configured/.test(gone.drift[0].reason), JSON.stringify(gone.drift));
  check("…and counts as not-unchanged in the caveat", /predates 1 change/.test(gone.caveat ?? ""), String(gone.caveat));
  const noProject = noteGet(store, { id: aliasNote.id }, () => ({ roots: null, reason: "no enabled indexes configured" }));
  check("a note whose project can't be found is 'unresolved', with the reason", noProject.drift[0].state === "unresolved" && /no enabled indexes configured/.test(noProject.drift[0].reason), JSON.stringify(noProject.drift));

  writeFileSync(join(other, "same.php"), "one\n");
  writeFileSync(join(repo, "same.php"), "two\n");
  const otherNote = noteWrite(store, { title: "about the other project", body: "x", files: ["same.php"], repo: "other" }, stampFor("other"));
  writeFileSync(join(repo, "same.php"), "changed in fuel only\n");
  const hits = noteSearch(store, { query: "other project" }, rootsFor).results.filter((x) => x.id === otherNote.written);
  check("drift resolves against the note's own project, not the query's", hits[0]?.drift[0]?.state === "unchanged", JSON.stringify(hits));

  console.log("\n-- supersession --");
  noteWrite(store, { title: "Budget service now binds concretely", body: "The closure was replaced with a direct binding.", repo: "fuel" }, stampFor("fuel"));
  const s = noteSupersede(store, { old_id: "budget-service-resolves-through-a-closure", new_id: "budget-service-now-binds-concretely" });
  check("both sides updated", s.updated.length === 2, JSON.stringify(s));
  const old = noteGet(store, { id: "budget-service-resolves-through-a-closure" }, rootsFor);
  check("old note demoted, not deleted", old.found && old.status === "superseded", JSON.stringify(old.status));
  check("back-link recorded", old.supersededBy.includes("budget-service-now-binds-concretely"), JSON.stringify(old.supersededBy));

  console.log("\n-- retracted notes are hidden by default but retrievable --");
  noteWrite(store, { title: "Wrong turn about caching", body: "Believed the cache was per-request. It is not.", status: "retracted", repo: "fuel" }, stampFor("fuel"));
  check("hidden by default", noteSearch(store, { query: "caching wrong turn" }, rootsFor).results.length === 0);
  check("surfaced when asked", noteSearch(store, { query: "caching wrong turn", include_retracted: true }, rootsFor).results.length === 1);

  console.log("\n-- validation --");
  let threw = false;
  try { noteWrite(store, { title: "x", body: "y", status: "bogus" }, stampFor("fuel")); } catch { threw = true; }
  check("invalid status rejected", threw);
  threw = false;
  try { noteSupersede(store, { old_id: "nope", new_id: "also-nope" }); } catch { threw = true; }
  check("supersede on missing ids rejected", threw);
  t = throws(() => noteSearch(store, { query: "x", limit: "ten" }, rootsFor), /'limit' must be a number of at least 1, got "ten"/);
  check("a non-numeric search limit is an error, not a silent default", t.ok, t.detail);
} finally {
  for (const d of [dir, repo, pkg, other]) rmSync(d, { recursive: true, force: true });
}
console.log(failed === 0 ? "\nall note checks passed" : `\n${failed} note check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
