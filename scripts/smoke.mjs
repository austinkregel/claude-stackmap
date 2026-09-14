#!/usr/bin/env node
/**
 * End-to-end suite: starts the built server over stdio against a Laravel fixture and a temporary
 * config, and calls every tool, checking what comes back, including the failure paths. A second
 * server runs with no config at all. Needs `npm run build`; never reads the real config or notes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const sandbox = mkdtempSync(join(tmpdir(), "stackmap-smoke-"));
const repo = join(sandbox, "app-repo");
const home = join(sandbox, "home");

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};
const write = (rel, text) => {
  const p = join(repo, rel);
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

write("artisan", "#!/usr/bin/env php\n");
write("composer.json", JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } }));
write("app/Contracts/PaymentContract.php", "<?php\nnamespace App\\Contracts;\ninterface PaymentContract {}\n");
write("app/Services/StripePayment.php", "<?php\nnamespace App\\Services;\nuse App\\Contracts\\PaymentContract;\nclass StripePayment implements PaymentContract {}\n");
write("app/Services/Invoice.php", "<?php\nnamespace App\\Services;\nclass Invoice {}\n");
write("app/Providers/AppServiceProvider.php", `<?php
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
const configPath = join(sandbox, "config.json");
writeFileSync(configPath, JSON.stringify({ indexes: [{ name: "fixture", root: repo }], notesDir: join(sandbox, "notes") }));

try {
  console.log("-- tools --");
  const { client, call } = await connect({ STACKMAP_CONFIG: configPath });
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort().join();
    check("lists all seven tools", names === "note_get,note_search,note_supersede,note_write,stackmap_bindings,stackmap_indexes,stackmap_resolve", names);

    console.log("\n-- stackmap_indexes --");
    let r = await call("stackmap_indexes");
    const row = r.body?.indexes?.[0];
    check("reports the config path and the fixture index", r.body?.configPath === configPath && row?.name === "fixture" && row?.enabled === true, r.show);
    check("counts each edge kind separately", row?.containerBindings === 2 && row?.contextualBindings === 1 && row?.declarationEdges === 1, JSON.stringify(row));
    check("counts computed sites and skipped calls", row?.computedAbstractSites === 1 && row?.skippedNonContainerCalls === 1, JSON.stringify(row));

    console.log("\n-- stackmap_resolve --");
    r = await call("stackmap_resolve", { symbol: "App\\Contracts\\PaymentContract" });
    check("finds the contract's file", r.body?.exists === true && r.body?.file === "app/Contracts/PaymentContract.php", r.show);
    check("a container binding goes in implementedBy", r.body?.implementedBy?.length === 1 && r.body.implementedBy[0].concrete === "App\\Services\\StripePayment", JSON.stringify(r.body?.implementedBy));
    check("the implements declaration goes in subtypes, not implementedBy", r.body?.subtypes?.length === 1 && r.body.subtypes[0].concrete === "App\\Services\\StripePayment", JSON.stringify(r.body?.subtypes));
    r = await call("stackmap_resolve", { symbol: "App\\Services\\Invoice" });
    check("a contextual override goes in injections", r.body?.injections?.length === 1 && r.body.injections[0].abstract === "$currency", JSON.stringify(r.body?.injections));
    r = await call("stackmap_resolve", { symbol: "App\\Nope\\Missing" });
    check("an unknown symbol says it isn't a negative claim", r.isError === false && r.body?.exists === false && /not a claim that nothing implements it/.test(r.body?.note ?? ""), r.show);
    check("…and carries caveats", Array.isArray(r.body?.caveats) && r.body.caveats.length > 0, r.show);

    console.log("\n-- stackmap_bindings --");
    r = await call("stackmap_bindings");
    check("defaults to container + contextual edges", r.body?.kind === "bindings" && r.body?.total === 3 && r.body?.matchedByKind?.container === 2 && r.body?.matchedByKind?.contextual === 1, r.show);
    check("reports computed abstracts", r.body?.computedAbstract === 1, r.show);
    r = await call("stackmap_bindings", { kind: "declaration" });
    check("kind=declaration returns declaration edges only", r.body?.total === 1 && r.body?.edges?.[0]?.kind === "declaration", r.show);
    r = await call("stackmap_bindings", { kind: "all", filter: "stripe" });
    check("filter matches case-insensitively across fields", r.body?.matched === 3 && r.body?.total === 4, r.show);
    r = await call("stackmap_bindings", { kind: "all", filter: "paymentcontract" });
    check("filter matches the abstract case-insensitively", r.body?.matched === 2, r.show);
    r = await call("stackmap_bindings", { kind: "all", limit: 2, offset: 3 });
    check("limit and offset page through the table", r.body?.returned === 1 && r.body?.edges?.length === 1 && r.body?.offset === 3, r.show);

    console.log("\n-- rejected calls --");
    r = await call("stackmap_bindings", { kind: "nonsense" });
    check("unknown kind", r.isError && /unknown kind "nonsense"/.test(r.text), r.show);
    r = await call("stackmap_resolve", { symbol: "" });
    check("empty symbol", r.isError && /non-empty 'symbol'/.test(r.text), r.show);
    r = await call("stackmap_bindings", { index: "no-such-index" });
    check("unknown index", r.isError && /no enabled index named "no-such-index"\. Known: fixture/.test(r.text), r.show);

    console.log("\n-- notes --");
    r = await call("note_write", {
      title: "Payments bind to Stripe",
      body: "AppServiceProvider binds PaymentContract to StripePayment.",
      files: ["app/Services/StripePayment.php"],
      tags: ["payments"],
      repo: "fixture",
    });
    check("note_write stamps the file relative to the index root", r.body?.written === "payments-bind-to-stripe" && r.body?.stampedFiles === 1, r.show);
    r = await call("note_search", { query: "stripe payments", repo: "fixture" });
    check("note_search finds it with clean drift", r.body?.results?.[0]?.id === "payments-bind-to-stripe" && r.body.results[0].drift?.[0]?.state === "unchanged", r.show);
    appendFileSync(join(repo, "app/Services/StripePayment.php"), "// changed after the note\n");
    r = await call("note_get", { id: "payments-bind-to-stripe", repo: "fixture" });
    check("note_get reports the file changed underneath the note", r.body?.found === true && r.body?.drift?.[0]?.state === "changed", r.show);
    await call("note_write", { title: "Payments bind to Adyen", body: "Replaced Stripe.", repo: "fixture" });
    r = await call("note_supersede", { old_id: "payments-bind-to-stripe", new_id: "payments-bind-to-adyen" });
    check("note_supersede updates both notes", r.body?.updated?.length === 2, r.show);
    r = await call("note_get", { id: "payments-bind-to-stripe" });
    check("the old note is demoted and back-linked, not deleted", r.body?.status === "superseded" && r.body?.supersededBy?.includes("payments-bind-to-adyen"), r.show);
    r = await call("note_write", { title: "x", body: "y", status: "bogus" });
    check("an invalid status is an error", r.isError, r.show);
    r = await call("note_supersede", { old_id: "nope", new_id: "also-nope" });
    check("superseding unknown ids is an error", r.isError, r.show);
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
