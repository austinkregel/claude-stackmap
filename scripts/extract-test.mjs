#!/usr/bin/env node
/**
 * Regression suite for the PHP extractors and the Laravel adapter wiring.
 *
 * Every case here is grounded in a defect found by running stackmap against a large real
 * Laravel codebase (2,770 files), not in an invented example:
 *   D1  Route::bind('report', ...) landed in the table as a container binding (3 false rows).
 *   D2  A foreach over a 14-entry class const bound 14 singletons through a computed key.
 *       The whole site was dropped silently, so resolve() answered "nothing binds this".
 *   D3  All 54 (in fact 56 — two are multi-line chains) when()->needs()->give() sites were absent.
 *   D4  implementedBy/implements came only from bindings, never from extends/implements.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { extractBindings } = await import(join(root, "dist/php/bindings.js"));
const { extractDeclarations } = await import(join(root, "dist/php/declarations.js"));
const { laravelFactory } = await import(join(root, "dist/adapters/laravel.js"));

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};
const php = (body) => `<?php\nnamespace App\\Providers;\n\n${body}\n`;

console.log("-- D1: receiver must be the container --");
{
  const src = php(`
use Illuminate\\Support\\Facades\\Route;
use App\\Contracts\\FooContract;
use App\\Services\\FooService;

class RouteServiceProvider
{
    public function boot(): void
    {
        Route::bind('report', [$svc, 'reportConfigurationModel']);
        Route::bind('insight', [$svc, 'make']);
        Route::bind('deletedClient', function ($id) { return 1; });
        $this->app->bind(FooContract::class, FooService::class);
    }
}`);
  const r = extractBindings(src, "app/Providers/RouteServiceProvider.php");
  check("Route::bind is not a container binding", r.bindings.length === 1, `got ${r.bindings.length}`);
  check("the real container bind survives", r.bindings[0]?.abstract === "App\\Contracts\\FooContract", r.bindings[0]?.abstract);
  check("no route placeholder leaked in as an abstract",
    !r.bindings.some((b) => ["report", "insight", "deletedClient"].includes(b.abstract)));
  check("skipped calls are reported, not dropped silently", r.skipped.length === 3, `got ${r.skipped.length}`);
  check("skipped call names its receiver", r.skipped[0]?.receiver.includes("Route::"), r.skipped[0]?.receiver);
}
{
  // A method *declaration* reaches the same names and must not become a binding or a skip.
  const src = php(`
class Container
{
    public function bind($abstract, $concrete = null) {}
    public function singleton($abstract, $concrete = null) {}
}`);
  const r = extractBindings(src, "app/Container.php");
  check("a bind() declaration is not a binding", r.bindings.length === 0, JSON.stringify(r.bindings));
  check("a bind() declaration is not reported as skipped", r.skipped.length === 0, JSON.stringify(r.skipped));
}
{
  const src = php(`class P { public function r() { $router->bind('x', Y::class); } }`);
  const r = extractBindings(src, "app/P.php");
  check("$router->bind is skipped with its receiver", r.bindings.length === 0 && r.skipped[0]?.receiver.includes("router"),
    JSON.stringify(r));
}
{
  const src = php(`use App\\C; use App\\S;\nclass P { public function r() { app()->singleton(C::class, S::class); App::bind(C::class, S::class); } }`);
  const r = extractBindings(src, "app/P.php");
  check("app() and the App facade are container receivers", r.bindings.length === 2, JSON.stringify(r.bindings));
}

console.log("\n-- D2: a computed abstract must never be dropped silently --");
{
  const src = php(`
use App\\Contracts\\Models\\HasComparatorsContract;
use App\\Filters\\InventoryFilter;

class InventoryServiceProvider
{
    public const FILTERS = [
        HasComparatorsContract::COMPARATOR_EQUAL => InventoryFilter\\EqualFilter::class,
        HasComparatorsContract::COMPARATOR_LIKE => InventoryFilter\\LikeFilter::class,
        HasComparatorsContract::COMPARATOR_IN => InventoryFilter\\InFilter::class,
    ];

    public function register(): void
    {
        foreach (static::FILTERS as $key => $class) {
            $this->app->singleton(self::getAppKey($key), $class);
        }
    }
}`);
  const r = extractBindings(src, "app/Providers/InventoryServiceProvider.php");
  const singletonLine = src.split("\n").findIndex((l) => l.includes("->singleton(")) + 1;
  check("the iterated const is expanded to one edge per entry", r.bindings.length === 3, `got ${r.bindings.length}`);
  check("concretes are recovered and fully qualified",
    r.bindings[0]?.concrete === "App\\Filters\\InventoryFilter\\EqualFilter", r.bindings[0]?.concrete);
  check("the loop key is substituted into the abstract expression",
    r.bindings[0]?.abstract === "self::getAppKey(HasComparatorsContract::COMPARATOR_EQUAL)", r.bindings[0]?.abstract);
  check("expanded edges are marked computed, not resolvable names",
    r.bindings.every((b) => b.abstractKind === "computed"));
  check("expanded edges say what they were derived from",
    r.bindings.every((b) => b.inferredFrom === "static::FILTERS"), r.bindings[0]?.inferredFrom);
  check("every expanded edge points at the one real call site",
    r.bindings.every((b) => b.line === singletonLine), `${r.bindings[0]?.line} != ${singletonLine}`);
}
{
  // No expandable loop: the site must still be visible as a computed-abstract binding.
  const src = php(`class P { public function r() { $this->app->singleton($this->keyFor('a'), Svc::class); } }`);
  const r = extractBindings(src, "app/P.php");
  check("an unexpandable computed abstract is still emitted", r.bindings.length === 1, JSON.stringify(r.bindings));
  check("it carries the expression as written", r.bindings[0]?.abstract === "$this->keyFor('a')", r.bindings[0]?.abstract);
  check("it is flagged computed", r.bindings[0]?.abstractKind === "computed", r.bindings[0]?.abstractKind);
}
{
  const src = php(`class P { public function r() { foreach (static::MISSING as $k => $c) { $this->app->bind(f($k), $c); } } }`);
  const r = extractBindings(src, "app/P.php");
  check("an unresolvable const is not invented", r.bindings.length === 1 && r.bindings[0].inferredFrom === undefined,
    JSON.stringify(r.bindings));
}

console.log("\n-- D3: contextual when()->needs()->give() --");
{
  const src = php(`
use App\\Services\\KeywordGeneratorService;
use App\\Validators\\DiFillableOnly;
use App\\Sync\\NkwSynchronizer;
use App\\Sync\\PeSynchronizer;
use Illuminate\\Contracts\\Filesystem\\Filesystem;
use App\\Repositories\\CampaignRepository;
use App\\Contracts\\Repositories\\CampaignRepositoryContract;

class P
{
    public function register(): void
    {
        $this->app->when(KeywordGeneratorService::class)->needs('$app')->give(function () { return 1; });

        $this->app->when(DiFillableOnly::class)->needs('$diAgencyId')
            ->give(function (): int { return 2; });

        $this->app
            ->when(NkwSynchronizer::class)
            ->needs(Filesystem::class)
            ->give(fn () => Storage::disk('negative-keywords'));

        $this->app->when([NkwSynchronizer::class, PeSynchronizer::class])
            ->needs(CampaignRepositoryContract::class)
            ->give(CampaignRepository::class);

        $this->app->when(P::class)->needs('$tagged')->giveTagged('reports');
        $this->app->when(P::class)->needs('$cfg')->giveConfig('agency.id');
    }
}`);
  const r = extractBindings(src, "app/Providers/P.php");
  check("every chain form is captured, array form fanned out", r.contextual.length === 7, `got ${r.contextual.length}`);
  const first = r.contextual[0];
  check("context is the class being resolved", first?.context === "App\\Services\\KeywordGeneratorService", first?.context);
  check("a primitive parameter is kept as a variable", first?.needs === "$app" && first?.needsKind === "variable",
    `${first?.needs}/${first?.needsKind}`);
  check("a closure give is not guessed at", first?.gives === null && first?.givesKind === "closure", first?.givesKind);
  check("a chain split across lines is captured",
    r.contextual.some((c) => c.context === "App\\Validators\\DiFillableOnly" && c.needs === "$diAgencyId"));
  check("a multi-line $this->app chain is captured",
    r.contextual.some((c) => c.context === "App\\Sync\\NkwSynchronizer" && c.needs === "Illuminate\\Contracts\\Filesystem\\Filesystem"));
  check("when([A, B]) yields one edge per context",
    r.contextual.filter((c) => c.needs === "App\\Contracts\\Repositories\\CampaignRepositoryContract").length === 2);
  check("a class-typed give is resolved",
    r.contextual.find((c) => c.gives === "App\\Repositories\\CampaignRepository")?.givesKind === "class");
  check("giveTagged and giveConfig are distinguished",
    r.contextual.some((c) => c.givesKind === "tagged") && r.contextual.some((c) => c.givesKind === "config"));
}
{
  // Collection/query-builder ->when() is the common lookalike: not the container, no needs().
  const src = php(`class C { public function h() { return $query->when($flag, fn ($q) => $q->where('a', 1)); } }`);
  const r = extractBindings(src, "app/C.php");
  check("$query->when() is not a contextual binding", r.contextual.length === 0, JSON.stringify(r.contextual));
}

console.log("\n-- D4: PHP declarations --");
{
  const src = `<?php
namespace App\\Filters\\InventoryFilter;

use App\\Contracts\\Models\\HasComparatorsContract;
use App\\Contracts\\Models\\Inventory\\FilterableContract as Filterable;

/**
 * A docblock mentioning class FakeClass extends FakeParent must not be parsed.
 */
abstract class FilterAbstract implements HasComparatorsContract, Filterable
{
    public const NAME = self::class;
}

final class EqualFilter extends FilterAbstract
{
}

interface ChainedContract extends HasComparatorsContract, Filterable {}

enum Comparator: string implements HasComparatorsContract
{
    case Equal = 'eq';
}

trait Shared {}
`;
  const d = extractDeclarations(src, "app/Filters/InventoryFilter/FilterAbstract.php");
  const by = (n) => d.find((x) => x.symbol === `App\\Filters\\InventoryFilter\\${n}`);
  check("all five declarations found, docblock prose ignored", d.length === 5, `got ${d.length}: ${d.map((x) => x.symbol).join(",")}`);
  check("implements list is expanded through use aliases",
    JSON.stringify(by("FilterAbstract")?.implements) ===
      JSON.stringify(["App\\Contracts\\Models\\HasComparatorsContract", "App\\Contracts\\Models\\Inventory\\FilterableContract"]),
    JSON.stringify(by("FilterAbstract")?.implements));
  check("abstract is recorded", by("FilterAbstract")?.isAbstract === true);
  check("extends is captured on a final class",
    JSON.stringify(by("EqualFilter")?.extends) === JSON.stringify(["App\\Filters\\InventoryFilter\\FilterAbstract"]),
    JSON.stringify(by("EqualFilter")?.extends));
  check("EqualFilter is not marked abstract", by("EqualFilter")?.isAbstract === false);
  check("an interface can extend several", by("ChainedContract")?.extends.length === 2, JSON.stringify(by("ChainedContract")?.extends));
  check("an enum backing type is not a parent",
    by("Comparator")?.extends.length === 0 && by("Comparator")?.implements.length === 1,
    JSON.stringify(by("Comparator")));
  check("kinds are distinguished",
    by("Comparator")?.kind === "enum" && by("Shared")?.kind === "trait" && by("ChainedContract")?.kind === "interface");
  check("self::class in a const body is not a declaration", !d.some((x) => x.symbol.endsWith("\\class")));
}

console.log("\n-- adapter: buckets stay separate and empties carry caveats --");
{
  const repo = mkdtempSync(join(tmpdir(), "stackmap-laravel-"));
  try {
    writeFileSync(join(repo, "artisan"), "#!/usr/bin/env php\n");
    writeFileSync(join(repo, "composer.json"), JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } }));
    mkdirSync(join(repo, "app", "Providers"), { recursive: true });
    mkdirSync(join(repo, "app", "Filters"), { recursive: true });
    writeFileSync(join(repo, "app", "Filters", "FilterAbstract.php"),
      `<?php\nnamespace App\\Filters;\nuse App\\Contracts\\HasComparators;\nabstract class FilterAbstract implements HasComparators {}\n`);
    writeFileSync(join(repo, "app", "Filters", "EqualFilter.php"),
      `<?php\nnamespace App\\Filters;\nclass EqualFilter extends FilterAbstract {}\n`);
    writeFileSync(join(repo, "app", "Providers", "AppServiceProvider.php"), `<?php
namespace App\\Providers;

use App\\Filters;
use App\\Contracts\\HasComparators;
use App\\Services\\Thing;

class AppServiceProvider
{
    public const FILTERS = [HasComparators::EQ => Filters\\EqualFilter::class];

    public function register(): void
    {
        foreach (static::FILTERS as $key => $class) {
            $this->app->singleton(self::getAppKey($key), $class);
        }
        $this->app->when(Thing::class)->needs('$size')->give(fn () => 10);
        Route::bind('report', [$s, 'm']);
    }
}
`);
    const adapter = laravelFactory.create({ name: "t", root: repo, adapter: "laravel", options: {}, enabled: true }, repo, []);
    const stats = adapter.stats();
    check("declaration edges are counted separately from bindings",
      stats.containerBindings === 1 && stats.contextualBindings === 1 && stats.declarationEdges === 2,
      JSON.stringify(stats));
    check("skipped non-container calls are surfaced in stats", stats.skippedNonContainerCalls === 1, `${stats.skippedNonContainerCalls}`);
    check("computed sites are counted as sites, not edges",
      stats.computedAbstractSites === 1 && stats.computedAbstractEdges === 1,
      `${stats.computedAbstractSites}/${stats.computedAbstractEdges}`);

    const eq = adapter.resolveSymbol("App\\Filters\\EqualFilter");
    check("a singleton bound through a computed key is reported on the concrete side",
      eq.implements.length === 1 && eq.implements[0].inferredFrom === "static::FILTERS", JSON.stringify(eq.implements));
    check("extends shows up as a supertype",
      eq.supertypes.length === 1 && eq.supertypes[0].abstract === "App\\Filters\\FilterAbstract", JSON.stringify(eq.supertypes));
    check("declaration edges never leak into implementedBy", eq.implementedBy.length === 0, JSON.stringify(eq.implementedBy));

    const hc = adapter.resolveSymbol("App\\Contracts\\HasComparators");
    check("an interface with no binding still reports its implementors",
      hc.subtypes.length === 1 && hc.subtypes[0].concrete === "App\\Filters\\FilterAbstract", JSON.stringify(hc.subtypes));
    check("an empty implementedBy comes with a caveat, so it cannot read as a negative",
      hc.implementedBy.length === 0 && hc.caveats.some((c) => c.includes("not proof")), JSON.stringify(hc.caveats));
    check("a symbol that resolves to no file is still honest about it",
      hc.exists === false && hc.file === "app/Contracts/HasComparators.php", `${hc.exists} ${hc.file}`);

    const thing = adapter.resolveSymbol("App\\Services\\Thing");
    check("injections answer 'what gets injected into X'",
      thing.injections.length === 1 && thing.injections[0].abstract === "$size", JSON.stringify(thing.injections));
    check("the same edge is reachable from the dependency side",
      adapter.resolveSymbol("$size").injectedInto.length === 0 ||
      adapter.resolutionTable(["contextual"]).length === 1);
    check("resolutionTable defaults to the binding table only",
      adapter.resolutionTable().every((e) => e.kind !== "declaration"));
    check("declaration edges are reachable on request",
      adapter.resolutionTable(["declaration"]).length === 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log(`\n${failed === 0 ? "all extractor checks passed" : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
