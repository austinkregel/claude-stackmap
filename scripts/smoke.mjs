#!/usr/bin/env node
/**
 * End-to-end suite: starts the built server over stdio against Laravel fixtures and a temporary
 * config, and calls every tool, checking what comes back, including the failure paths: a project
 * with an alias root, a query scoped to two projects, a duplicate project name, and adding a project.
 * A second server runs with no config at all. Needs `npm run build`; never reads the real config or
 * notes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "stackmap-smoke-")));
const repo = join(sandbox, "app-repo");
const pkg = join(sandbox, "pkg-repo");
const otherRepo = join(sandbox, "other-repo");
const home = join(sandbox, "home");

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};
const write = (base, rel, text) => {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

async function connect(env) {
  const base = { ...process.env, HOME: home };
  delete base.STACKMAP_CONFIG;
  delete base.XDG_CONFIG_HOME;
  const client = new Client({ name: "stackmap-smoke", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...base, ...env } }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // error results are plain text
    }
    return { isError: Boolean(r.isError), text, body, show: text.slice(0, 300) };
  };
  return { client, call };
}

const LARAVEL = (psr4) => JSON.stringify({ require: { "laravel/framework": "^13.0" }, autoload: { "psr-4": psr4 } });
// No artisan file: detection comes from composer.json's dependencies.
write(repo, "composer.json", LARAVEL({ "App\\": "app/" }));
write(repo, "app/Contracts/PaymentContract.php", "<?php\nnamespace App\\Contracts;\ninterface PaymentContract {}\n");
write(repo, "app/Services/StripePayment.php", "<?php\nnamespace App\\Services;\nuse App\\Contracts\\PaymentContract;\nclass StripePayment implements PaymentContract {}\n");
write(repo, "app/Services/Invoice.php", "<?php\nnamespace App\\Services;\nclass Invoice {}\n");
write(repo, "app/Providers/AppServiceProvider.php", `<?php
namespace App\\Providers;

use App\\Contracts\\PaymentContract;
use App\\Services\\StripePayment;
use App\\Services\\Invoice;

class AppServiceProvider
{
    public function register(): void
    {
        $this->app->bind(PaymentContract::class, StripePayment::class);
        $this->app->when(Invoice::class)->needs('$currency')->give(fn () => 'EUR');
        $this->app->singleton($this->key(), StripePayment::class);
        Route::bind('invoice', fn ($id) => $id);
    }
}
`);
// An alias root of the fixture project: a package with its own PSR-4 map.
write(pkg, "composer.json", JSON.stringify({ autoload: { "psr-4": { "Pkg\\": "src/" } } }));
write(pkg, "src/Ledger.php", "<?php\nnamespace Pkg;\ninterface Ledger {}\n");
write(pkg, "src/Providers/LedgerProvider.php", "<?php\nnamespace Pkg\\Providers;\nclass LedgerProvider { public function register(): void { $this->app->bind(\\Pkg\\Ledger::class, \\App\\Services\\Invoice::class); } }\n");
// A second project.
write(otherRepo, "composer.json", LARAVEL({ "Other\\": "app/" }));
write(otherRepo, "app/Providers/OtherProvider.php", "<?php\nnamespace Other\\Providers;\nclass OtherProvider { public function register(): void { $this->app->bind(\\Other\\A::class, \\Other\\B::class); } }\n");

const configPath = join(sandbox, "config.json");
const config = {
  guard: { enabled: true },
  indexes: [
    { name: "fixture", root: repo, aliases: [{ path: pkg, include: ["src"] }] },
    { name: "other", root: otherRepo },
    { name: "fixture", root: otherRepo },
  ],
  defaultIndex: "fixture",
  notesDir: join(sandbox, "notes"),
};
writeFileSync(configPath, JSON.stringify(config));

try {
  console.log("-- tools --");
  const { client, call } = await connect({ STACKMAP_CONFIG: configPath });
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort().join();
    check("lists all eight tools", names === "note_get,note_search,note_supersede,note_write,stackmap_add_index,stackmap_bindings,stackmap_indexes,stackmap_resolve", names);

    console.log("\n-- stackmap_indexes --");
    let r = await call("stackmap_indexes");
    const row = r.body?.indexes?.find((i) => i.name === "fixture");
    check("reports the config path and the fixture project", r.body?.configPath === configPath && row?.enabled === true && row?.adapter === "laravel", r.show);
    check("counts each edge kind separately, across both roots", row?.containerBindings === 3 && row?.contextualBindings === 1 && row?.declarationEdges === 1, JSON.stringify(row));
    check("counts computed sites and skipped calls", row?.computedAbstractSites === 1 && row?.skippedNonContainerCalls === 1, JSON.stringify(row));
    check("lists each root, the alias first, with its own counts", row?.roots?.map((x) => x.kind).join() === "alias,root" && row.roots[0].path === pkg && row.roots[0].filesScanned === 2, JSON.stringify(row?.roots));
    check("reports the duplicate entry that was not loaded", r.body?.notLoaded?.length === 1 && r.body.notLoaded[0].kind === "duplicate" && r.body.notLoaded[0].entry === 2, JSON.stringify(r.body?.notLoaded));

    console.log("\n-- stackmap_resolve --");
    r = await call("stackmap_resolve", { symbol: "App\\Contracts\\PaymentContract" });
    let hit = r.body?.results?.[0];
    check("results come per project, the default one when scope is omitted", r.body?.scope?.join() === "fixture" && hit?.index === "fixture", r.show);
    check("finds the contract's file, with its root", hit?.exists === true && hit.files?.[0]?.path === "app/Contracts/PaymentContract.php" && hit.files[0].root === repo, JSON.stringify(hit?.files));
    check("a container binding goes in implementedBy", hit?.implementedBy?.length === 1 && hit.implementedBy[0].concrete === "App\\Services\\StripePayment", JSON.stringify(hit?.implementedBy));
    check("the implements declaration goes in subtypes, not implementedBy", hit?.subtypes?.length === 1 && hit.subtypes[0].concrete === "App\\Services\\StripePayment", JSON.stringify(hit?.subtypes));
    check("every query carries the duplicate-name caveat", r.body?.caveats?.some((c) => /reuses the name "fixture"/.test(c)), JSON.stringify(r.body?.caveats));
    r = await call("stackmap_resolve", { symbol: "Pkg\\Ledger" });
    hit = r.body?.results?.[0];
    check("a symbol in the alias root resolves there, bound from the alias's own provider",
      hit?.files?.[0]?.root === pkg && hit.files[0].path === "src/Ledger.php" && hit.implementedBy?.[0]?.root === pkg && hit.implementedBy[0].declaredIn === "src/Providers/LedgerProvider.php", r.show);
    r = await call("stackmap_resolve", { symbol: "App\\Services\\Invoice" });
    check("a contextual override goes in injections", r.body?.results?.[0]?.injections?.length === 1 && r.body.results[0].injections[0].abstract === "$currency", r.show);
    r = await call("stackmap_resolve", { symbol: "App\\Nope\\Missing" });
    hit = r.body?.results?.[0];
    check("an unknown symbol says it isn't a negative claim", r.isError === false && hit?.exists === false && /not a claim that nothing implements it/.test(hit?.note ?? ""), r.show);
    check("…and carries caveats, naming each root", Array.isArray(hit?.caveats) && hit.caveats.some((c) => c.includes(`alias ${pkg}`)) && hit.caveats.some((c) => c.includes(`root ${repo}`)), JSON.stringify(hit?.caveats));

    console.log("\n-- stackmap_bindings --");
    r = await call("stackmap_bindings");
    check("defaults to container + contextual edges across the project's roots", r.body?.kind === "bindings" && r.body?.total === 4 && r.body?.matchedByKind?.container === 3 && r.body?.matchedByKind?.contextual === 1, r.show);
    check("reports computed abstracts", r.body?.computedAbstract === 1, r.show);
    check("each edge is tagged with its project and root", r.body?.edges?.every((e) => e.index === "fixture" && (e.root === repo || e.root === pkg)), r.show);
    check("the alias's edges come before the main root's", r.body?.edges?.[0]?.root === pkg, JSON.stringify(r.body?.edges?.map((e) => e.root)));
    r = await call("stackmap_bindings", { kind: "declaration" });
    check("kind=declaration returns declaration edges only", r.body?.total === 1 && r.body?.edges?.[0]?.kind === "declaration", r.show);
    r = await call("stackmap_bindings", { kind: "all", filter: "stripe" });
    check("filter matches case-insensitively across fields", r.body?.matched === 3 && r.body?.total === 5, r.show);
    r = await call("stackmap_bindings", { kind: "all", limit: 2, offset: 4 });
    check("limit and offset page through the table", r.body?.returned === 1 && r.body?.edges?.length === 1 && r.body?.offset === 4, r.show);

    r = await call("stackmap_bindings", { scope: ["fixture", "other"] });
    check("a scope of two projects reports totals per project", r.body?.scope?.join() === "fixture,other" && r.body?.totalByIndex?.fixture === 4 && r.body?.totalByIndex?.other === 1 && r.body?.total === 5, r.show);
    r = await call("stackmap_bindings", { scope: ["fixture", "other"], offset: 4, limit: 1 });
    check("paging crosses from one project into the next", r.body?.edges?.length === 1 && r.body.edges[0].index === "other" && r.body.edges[0].abstract === "Other\\A", r.show);
    r = await call("stackmap_resolve", { symbol: "Other\\A", scope: ["other", "fixture"] });
    check("resolve returns one result per project, in scope order", r.body?.results?.map((x) => x.index).join() === "other,fixture" && r.body.results[0].implementedBy?.length === 1 && r.body.results[1].implementedBy?.length === 0, r.show);

    console.log("\n-- rejected calls --");
    r = await call("stackmap_bindings", { kind: "nonsense" });
    check("unknown kind", r.isError && /unknown kind "nonsense"/.test(r.text), r.show);
    r = await call("stackmap_resolve", { symbol: "" });
    check("empty symbol", r.isError && /non-empty 'symbol'/.test(r.text), r.show);
    r = await call("stackmap_bindings", { index: "fixture" });
    check("the old 'index' argument says it was replaced by 'scope'", r.isError && /"index" was replaced by "scope"/.test(r.text), r.show);
    r = await call("stackmap_bindings", { scope: ["no-such-index"] });
    check("an unknown project in scope", r.isError && /no enabled index named "no-such-index"\. Known: fixture, other/.test(r.text), r.show);
    r = await call("stackmap_bindings", { scope: [] });
    check("an empty scope", r.isError && /non-empty list/.test(r.text), r.show);
    r = await call("stackmap_bindings", { limit: "ten" });
    check("a non-numeric limit is an error, not a silent default", r.isError && /'limit' must be a number of at least 1, got "ten"/.test(r.text), r.show);
    r = await call("stackmap_resolve", { symbol: "X", bogus: 1 });
    check("an undeclared argument is an error, not ignored", r.isError && /unknown argument "bogus"/.test(r.text), r.show);

    console.log("\n-- notes --");
    r = await call("note_write", {
      title: "Payments bind to Stripe",
      body: "AppServiceProvider binds PaymentContract to StripePayment.",
      files: ["app/Services/StripePayment.php", "src/Ledger.php"],
      tags: ["payments"],
      repo: "fixture",
    });
    check("note_write stamps files in whichever root holds them", r.body?.written === "payments-bind-to-stripe" && r.body?.stampedFiles === 2, r.show);
    r = await call("note_search", { query: "stripe payments", repo: "fixture" });
    check("note_search finds it with clean drift", r.body?.results?.[0]?.id === "payments-bind-to-stripe" && r.body.results[0].drift?.every((d) => d.state === "unchanged") && r.body.results[0].drift[1].root === pkg, r.show);
    appendFileSync(join(repo, "app/Services/StripePayment.php"), "// changed after the note\n");
    r = await call("note_get", { id: "payments-bind-to-stripe" });
    check("note_get reports the file changed underneath the note", r.body?.found === true && r.body?.drift?.[0]?.state === "changed" && r.body.drift[1].state === "unchanged", r.show);
    r = await call("note_get", { id: "payments-bind-to-stripe", repo: "fixture" });
    check("note_get rejects an argument it doesn't declare", r.isError && /unknown argument "repo"/.test(r.text), r.show);
    r = await call("note_write", { title: "nowhere", body: "x", files: ["app/x.php"], repo: "no-such-project" });
    check("note_write with relative files and no resolvable project is an error", r.isError && /can't stamp "app\/x\.php"/.test(r.text), r.show);
    await call("note_write", { title: "Payments bind to Adyen", body: "Replaced Stripe.", repo: "fixture" });
    r = await call("note_supersede", { old_id: "payments-bind-to-stripe", new_id: "payments-bind-to-adyen" });
    check("note_supersede updates both notes", r.body?.updated?.length === 2, r.show);
    r = await call("note_get", { id: "payments-bind-to-stripe" });
    check("the old note is demoted and back-linked, not deleted", r.body?.status === "superseded" && r.body?.supersededBy?.includes("payments-bind-to-adyen"), r.show);
    r = await call("note_write", { title: "x", body: "y", status: "bogus" });
    check("an invalid status is an error", r.isError, r.show);
    r = await call("note_supersede", { old_id: "nope", new_id: "also-nope" });
    check("superseding unknown ids is an error", r.isError, r.show);

    console.log("\n-- stackmap_add_index --");
    r = await call("stackmap_add_index", { name: "added", root: otherRepo });
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    check("adds a project to the config file", r.isError === false && r.body?.configPath === configPath && onDisk.indexes.at(-1).name === "added", r.show);
    check("…keeping the sections it doesn't model", JSON.stringify(onDisk.guard) === JSON.stringify(config.guard));
    r = await call("stackmap_indexes");
    check("the added project is served on the next call", r.body?.indexes?.some((i) => i.name === "added" && i.adapter === "laravel"), r.show);
    r = await call("stackmap_add_index", { name: "other", root: otherRepo });
    check("a name already used is refused", r.isError && /already has an index named "other"; not changed/.test(r.text), r.show);
    r = await call("stackmap_add_index", { name: "missing-root", root: join(sandbox, "nope") });
    check("a root that doesn't exist is refused", r.isError && /which does not exist/.test(r.text), r.show);
  } finally {
    await client.close();
  }

  console.log("\n-- no config --");
  const bare = await connect({});
  try {
    let r = await bare.call("stackmap_indexes");
    check("stackmap_indexes says nothing is configured and where it looked", r.body?.configPath === null && r.body?.indexes?.length === 0 && /No indexes configured/.test(r.body?.hint ?? "") && r.body?.searched?.[0]?.startsWith(home), r.show);
    r = await bare.call("stackmap_resolve", { symbol: "App\\X" });
    check("stackmap_resolve is an error naming the missing config", r.isError && /no enabled indexes configured/.test(r.text), r.show);
  } finally {
    await bare.client.close();
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall smoke checks passed" : `\n${failed} smoke check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
