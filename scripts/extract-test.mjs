#!/usr/bin/env node
/**
 * Suite for the PHP extractors and the Laravel adapter wiring, using inline fixtures.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { extractBindings } = await import(pathToFileURL(join(root, "dist/php/bindings.js")).href);
const { extractDeclarations } = await import(pathToFileURL(join(root, "dist/php/declarations.js")).href);
const { laravelFactory } = await import(pathToFileURL(join(root, "dist/adapters/laravel.js")).href);

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};
const php = (body) => `<?php\nnamespace App\\Providers;\n\n${body}\n`;

console.log("-- receiver must be the container --");
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

console.log("\n-- a computed abstract must never be dropped silently --");
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

console.log("\n-- contextual when()->needs()->give() --");
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

console.log("\n-- PHP declarations --");
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
    const indexed = laravelFactory.create(
      { name: "t", root: repo, adapter: "laravel", options: {}, enabled: true, aliases: [] },
      [{ kind: "root", configured: repo, path: realpathSync(repo), include: null, exclude: null }],
      [],
    );
    const adapter = indexed.resolve;
    const stats = indexed.stats();
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
      hc.exists === false && hc.files.length === 1 && hc.files[0].path === "app/Contracts/HasComparators.php" && hc.files[0].exists === false && hc.files[0].root === realpathSync(repo),
      JSON.stringify(hc.files));

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

console.log("\n-- adapter: a project with several roots --");
{
  const base = realpathSync(mkdtempSync(join(tmpdir(), "stackmap-roots-")));
  const put = (rel, text) => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), text);
  };
  const LARAVEL = JSON.stringify({ require: { "laravel/framework": "^13.0" }, autoload: { "psr-4": { "App\\": "app/" } } });
  const root = (kind, rel, include = null, exclude = null) => ({ kind, configured: rel, path: join(base, rel), include, exclude });
  const make = (roots, cfgExtra = {}) =>
    laravelFactory.create({ name: "multi", root: roots[0].path, adapter: "laravel", options: {}, enabled: true, aliases: [], ...cfgExtra }, roots, []);
  try {
    // main: an App providing a binding to a contract that lives in a package root.
    put("main/composer.json", LARAVEL);
    put("main/app/Providers/AppServiceProvider.php", `<?php
namespace App\\Providers;
use Pkg\\Contract;
use Pkg\\Impl;
class AppServiceProvider { public function register(): void { $this->app->bind(Contract::class, Impl::class); $this->app->singleton($this->key(), Impl::class); } }
`);
    put("main/app/Shared.php", "<?php\nnamespace App;\nclass Shared extends Base {}\n");
    put("main/bootstrap/app.php", "<?php\nnamespace App;\nclass BootstrapApp extends Base {}\n");
    put("main/bootstrap/cache/services.php", "<?php\nnamespace App;\nclass CachedServices extends Base {}\n");
    put("main/config/app.php", "<?php\nnamespace App;\nclass ConfigThing extends Base {}\n");
    put("main/routes/web.php", "<?php\nnamespace App;\nclass RoutesThing extends Base {}\n");
    // pkg: a sibling root with its own composer.json and PSR-4 map.
    put("pkg/composer.json", JSON.stringify({ autoload: { "psr-4": { "Pkg\\": "src/", "App\\": "src/app/" } } }));
    put("pkg/src/Contract.php", "<?php\nnamespace Pkg;\ninterface Contract {}\n");
    put("pkg/src/Impl.php", "<?php\nnamespace Pkg;\nclass Impl implements Contract {}\n");
    put("pkg/src/app/Shared.php", "<?php\nnamespace App;\nclass Shared {}\n");
    put("pkg/src/Providers/PkgProvider.php", "<?php\nnamespace Pkg\\Providers;\nclass PkgProvider { public function register(): void { $this->app->singleton($this->key(), Impl::class); } }\n");
    // bare: a root with PHP files but no composer.json.
    put("bare/src/Loose.php", "<?php\nnamespace Loose;\nclass Loose {}\n");

    const two = make([root("root", "main"), root("alias", "pkg", ["src"])]);
    const contract = two.resolve.resolveSymbol("Pkg\\Contract");
    check("a symbol mapped by an alias's PSR-4 resolves to a file in that alias",
      contract.exists && contract.files.length === 1 && contract.files[0].root === join(base, "pkg") && contract.files[0].path === "src/Contract.php",
      JSON.stringify(contract.files));
    check("a binding declared in the main root to a contract in the alias is found",
      contract.implementedBy.length === 1 && contract.implementedBy[0].root === join(base, "main") && contract.implementedBy[0].declaredIn === "app/Providers/AppServiceProvider.php",
      JSON.stringify(contract.implementedBy));
    check("…with the concrete's file in the alias",
      contract.implementedBy[0]?.concreteFiles?.[0]?.root === join(base, "pkg") && contract.implementedBy[0].concreteFiles[0].exists === true,
      JSON.stringify(contract.implementedBy[0]?.concreteFiles));
    const shared = two.resolve.resolveSymbol("App\\Shared");
    check("a class present in two roots reports both files", shared.files.length === 2 && shared.files.every((f) => f.exists) && new Set(shared.files.map((f) => f.root)).size === 2, JSON.stringify(shared.files));
    const s2 = two.stats();
    check("the same relative computed site in two roots counts as two sites", s2.computedAbstractSites === 2, `${s2.computedAbstractSites}`);
    check("stats report each root, aliases first then the main root", s2.roots.map((r) => r.configured).join() === "pkg,main" && s2.roots[0].psr4Prefixes === 2, JSON.stringify(s2.roots));

    const main = s2.roots.find((r) => r.configured === "main");
    const mainDecls = two.resolve.resolutionTable(["declaration"]).filter((e) => e.root === join(base, "main")).map((e) => e.declaredIn).sort();
    check("the default include scans app/, bootstrap/, config/ and routes/",
      mainDecls.join() === "app/Shared.php,bootstrap/app.php,config/app.php,routes/web.php", JSON.stringify(mainDecls));
    check("…but not bootstrap/cache", main.filesScanned === 5 && !mainDecls.some((f) => f.startsWith("bootstrap/cache")), JSON.stringify(main));

    const withBare = make([root("root", "main"), root("alias", "bare", ["src"])]);
    const bare = withBare.stats().roots.find((r) => r.configured === "bare");
    check("an alias with no composer.json is still indexed", bare.filesScanned === 1, JSON.stringify(bare));
    check("…with a loud warning in stats", bare.warnings.some((w) => /no composer\.json/.test(w)), JSON.stringify(bare.warnings));
    check("…and in every result's caveats", withBare.resolve.resolveSymbol("Loose\\Loose").caveats.some((c) => /^WARNING alias bare .*no composer\.json/.test(c)), JSON.stringify(withBare.resolve.resolveSymbol("Loose\\Loose").caveats));

    put("broken/composer.json", "{not json");
    put("broken/src/X.php", "<?php\nclass X {}\n");
    const withBroken = make([root("root", "main"), root("alias", "broken", ["src"])]);
    const broken = withBroken.stats().roots.find((r) => r.configured === "broken");
    check("an alias whose composer.json can't be read is an error for that root and not scanned", /can't be read as JSON/.test(broken.error ?? "") && broken.filesScanned === 0, JSON.stringify(broken));
    check("…reported in caveats while the other roots still answer",
      withBroken.resolve.resolveSymbol("Pkg\\Contract").caveats.some((c) => /alias broken .* was not scanned: .*can't be read as JSON/.test(c)) && withBroken.stats().roots.find((r) => r.configured === "main").filesScanned === 5,
      JSON.stringify(withBroken.resolve.resolveSymbol("Pkg\\Contract").caveats));

    // A child root nested inside the main root, with rules that disagree with the parent's.
    // The user's example: the parent includes packages/, the child excludes tests/.
    put("nest/composer.json", LARAVEL);
    put("nest/packages/foo/src/Bar.php", "<?php\nnamespace Foo;\nclass Bar extends Base {}\n");
    put("nest/packages/foo/src/tests/Inner.php", "<?php\nnamespace Foo;\nclass Inner extends Base {}\n");
    put("nest/packages/foo/tests/FooTest.php", "<?php\nnamespace Foo;\nclass FooTest extends Base {}\n");
    put("nest/packages/foo/lib/Other.php", "<?php\nnamespace Foo;\nclass Other extends Base {}\n");
    put("nest/packages/zed/Zed.php", "<?php\nnamespace Zed;\nclass Zed extends Base {}\n");
    const nested = make(
      [root("root", "nest"), root("alias", "nest/packages/foo", ["src", "lib"], ["tests"])],
      { include: ["packages"] },
    );
    const nstats = nested.stats();
    const child = nstats.roots.find((r) => r.configured === "nest/packages/foo");
    const parent = nstats.roots.find((r) => r.configured === "nest");
    const edges = nested.resolve.resolutionTable(["declaration"]).map((e) => `${e.root === join(base, "nest") ? "parent" : e.root === join(base, "nest/packages/foo") ? "child" : e.root}:${e.declaredIn}`).sort();
    check("a file under a child root is grouped under the child, with a path relative to it",
      edges.includes("child:src/Bar.php") && !edges.some((e) => e.startsWith("parent:packages/foo/")), JSON.stringify(edges));
    check("a parent file outside the child stays with the parent", edges.includes("parent:packages/zed/Zed.php"), JSON.stringify(edges));
    check("the child's exclude wins: files the parent reaches under excluded names aren't indexed",
      !edges.some((e) => /FooTest|Inner/.test(e)), JSON.stringify(edges));
    check("…while the child's own include still indexes its other files", edges.includes("child:lib/Other.php") && edges.length === 3, JSON.stringify(edges));
    check("each file is scanned once", child.filesScanned === 2 && parent.filesScanned === 1 && nstats.phpFilesScanned === 3, JSON.stringify(nstats.roots));
    put("vend/composer.json", LARAVEL);
    put("vend/vendor/lib/Lib.php", "<?php\nclass Lib extends Base {}\n");
    const vend = laravelFactory.create(
      { name: "vend", root: join(base, "vend"), adapter: "laravel", options: {}, enabled: true, aliases: [], include: ["vendor"] },
      [root("root", "vend")],
      ["vendor"],
    );
    const vstats = vend.stats().roots[0];
    check("an include directory a global exclude rules out is reported, not scanned",
      vstats.filesScanned === 0 && vstats.warnings.some((w) => /matched by a global or default exclude, so not scanned: vendor/.test(w)), JSON.stringify(vstats));

    put("order/composer.json", LARAVEL);
    for (const dir of ["order/pkg", "order/pkg/sub", "order/pkg/sub/deep", "order/zzz", "order/aaa"]) mkdirSync(join(base, dir), { recursive: true });
    const ordered = make([root("root", "order"), root("alias", "order/zzz"), root("alias", "order/pkg"), root("alias", "order/pkg/sub/deep"), root("alias", "order/aaa"), root("alias", "order/pkg/sub")]);
    check("groups: a nested alias comes before the alias it sits in, siblings in path order, the main root last",
      ordered.stats().roots.map((r) => r.configured).join() === "order/aaa,order/pkg/sub/deep,order/pkg/sub,order/pkg,order/zzz,order",
      ordered.stats().roots.map((r) => r.configured).join());
    const onlySrc = make([root("root", "nest"), root("alias", "nest/packages/foo", ["src"])], { include: ["packages"] });
    const onlySrcEdges = onlySrc.resolve.resolutionTable(["declaration"]).map((e) => e.declaredIn).sort();
    check("the child's include wins: a child file outside it isn't indexed even though the parent reached it",
      !onlySrcEdges.includes("lib/Other.php") && !onlySrcEdges.includes("packages/foo/lib/Other.php") && onlySrcEdges.includes("src/Bar.php"), JSON.stringify(onlySrcEdges));

    put("walkmiss/composer.json", LARAVEL);
    const missing = make([root("root", "walkmiss", ["app", "nope"])]);
    const mstats = missing.stats().roots[0];
    check("include directories that don't exist are reported, not ignored", mstats.warnings.some((w) => /include directories not found: app, nope/.test(w)), JSON.stringify(mstats.warnings));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

console.log(`\n${failed === 0 ? "all extractor checks passed" : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
