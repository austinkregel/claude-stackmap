#!/usr/bin/env node
/**
 * Config and registry suite: config resolution order, validation (per index, strict keys, duplicate
 * names), scope selection, stack detection, root resolution, adapter construction and caching, the
 * capability check, and adding an index to the config file. Needs `npm run build`. Environment
 * variables and HOME point at temporary directories, so the real config is never read or written.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { configCandidates, loadConfig, selectIndex, selectScope, parseConfig, duplicateCaveats, addIndex, expandPath } = await import(pathToFileURL(join(root, "dist/config.js")).href);
const { detectAdapter, getAdapter, clearAdapterCache, resolveRoots, requireCapability } = await import(pathToFileURL(join(root, "dist/adapters/registry.js")).href);

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

const sandbox = mkdtempSync(join(tmpdir(), "stackmap-config-"));
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, STACKMAP_CONFIG: process.env.STACKMAP_CONFIG, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
/** Set the variables for a check. HOME also sets USERPROFILE, which os.homedir() reads on Windows. */
const setEnv = (vars) => {
  for (const k of ["STACKMAP_CONFIG", "XDG_CONFIG_HOME"]) delete process.env[k];
  Object.assign(process.env, vars, vars.HOME === undefined ? {} : { USERPROFILE: vars.HOME });
};
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
};
const cfg = (obj) => parseConfig(obj);
const idx = (name, extra = {}) => ({ name, root: sandbox, ...extra });
const LARAVEL = { require: { "laravel/framework": "^13.0" }, autoload: { "psr-4": { "App\\": "app/" } } };

try {
  const home = join(sandbox, "home");
  const xdg = join(sandbox, "xdg");
  const explicit = join(sandbox, "explicit.json");
  const homeConfig = join(home, ".config", "stackmap", "config.json");
  const xdgConfig = join(xdg, "stackmap", "config.json");

  console.log("-- resolution order --");
  setEnv({ HOME: home });
  check("with no variables, only ~/.config/stackmap/config.json", configCandidates().join() === homeConfig, configCandidates().join());
  setEnv({ HOME: home, XDG_CONFIG_HOME: xdg, STACKMAP_CONFIG: explicit });
  check("$STACKMAP_CONFIG, then $XDG_CONFIG_HOME, then home", configCandidates().join() === [explicit, xdgConfig, homeConfig].join(), configCandidates().join());

  write(homeConfig, { defaultIndex: "from-home" });
  write(xdgConfig, { defaultIndex: "from-xdg" });
  write(explicit, { defaultIndex: "from-explicit" });
  let loaded = loadConfig();
  check("the first existing candidate wins", loaded.config.defaultIndex === "from-explicit" && loaded.path === explicit, JSON.stringify(loaded));
  rmSync(explicit);
  loaded = loadConfig();
  check("a missing $STACKMAP_CONFIG falls through to $XDG_CONFIG_HOME", loaded.config.defaultIndex === "from-xdg" && loaded.path === xdgConfig, JSON.stringify(loaded));
  rmSync(xdgConfig);
  loaded = loadConfig();
  check("…and then to home", loaded.config.defaultIndex === "from-home", JSON.stringify(loaded));
  rmSync(homeConfig);
  loaded = loadConfig();
  check("no file at all: defaults and a null path", loaded.path === null && loaded.config.indexes.length === 0 && loaded.config.notesDir === "~/.config/stackmap/notes", JSON.stringify(loaded));

  console.log("\n-- validation --");
  setEnv({ HOME: home, STACKMAP_CONFIG: explicit });
  write(explicit, "{not json");
  let t = throws(() => loadConfig(), /config at .*explicit\.json is not valid JSON/);
  check("invalid JSON names the file", t.ok, t.detail);
  write(explicit, { indexes: [], notesDir: 5 });
  t = throws(() => loadConfig(), /is invalid:[\s\S]*notesDir/);
  check("an invalid top level is an error naming the path", t.ok, t.detail);
  write(explicit, { indexes: [{ name: "a", root: "~/src/a" }] });
  const a = loadConfig().config.indexes[0];
  check("index defaults are filled in, aliases included", a.adapter === "auto" && a.enabled === true && JSON.stringify(a.options) === "{}" && JSON.stringify(a.aliases) === "[]", JSON.stringify(a));
  check("globalExclude has its defaults", loadConfig().config.globalExclude.includes("vendor") && loadConfig().config.globalExclude.includes("node_modules"));
  check("expandPath expands ~ against HOME", expandPath("~/src/a") === join(home, "src", "a"), expandPath("~/src/a"));

  let c = cfg({ indexes: [{ name: "", root: "~/x", adapter: "rails" }, idx("good")] });
  check("an invalid index entry is left out; the others load", c.indexes.length === 1 && c.indexes[0].name === "good", JSON.stringify(c.indexes));
  check("…and its error lists every bad path", c.indexErrors.length === 1 && c.indexErrors[0].kind === "invalid" && /indexes\.0 is invalid: name: .*; adapter: /.test(c.indexErrors[0].message), JSON.stringify(c.indexErrors));
  c = cfg({ indexes: [idx("typo", { alias: [{ path: "/x" }] }), idx("fine")] });
  check("an unknown key invalidates only that index, naming the key", c.indexes.map((i) => i.name).join() === "fine" && /indexes\.0 \("typo"\) is invalid: .*alias/.test(c.indexErrors[0]?.message ?? ""), JSON.stringify(c.indexErrors));
  c = cfg({ indexes: [idx("s", { aliases: ["/just/a/string"] })] });
  check("aliases must be objects", c.indexes.length === 0 && /aliases\.0/.test(c.indexErrors[0]?.message ?? ""), JSON.stringify(c.indexErrors));
  c = cfg({ indexes: [idx("s", { aliases: [{ path: "/p", include: ["src"], extra: 1 }] })] });
  check("an unknown key inside an alias is an error", c.indexes.length === 0 && /extra/.test(c.indexErrors[0]?.message ?? ""), JSON.stringify(c.indexErrors));
  c = cfg({ indexes: [idx("both", { include: ["src", "tests"], exclude: ["tests"] }), idx("ok")] });
  check("a root that both includes and excludes a directory is invalid", c.indexes.map((i) => i.name).join() === "ok" && /indexes\.0 \("both"\) is invalid: include tests is also excluded/.test(c.indexErrors[0]?.message ?? ""), JSON.stringify(c.indexErrors));
  c = cfg({ indexes: [idx("nested", { include: ["packages/foo/tests"], exclude: ["tests"] })] });
  check("…including an exclude name deeper in an include path", c.indexes.length === 0 && /include packages\/foo\/tests is also excluded/.test(c.indexErrors[0]?.message ?? ""), JSON.stringify(c.indexErrors));
  c = cfg({ indexes: [idx("pathy", { include: ["bootstrap/cache/x"], exclude: ["bootstrap/cache"] })] });
  check("…and a path exclude covering an include", c.indexes.length === 0, JSON.stringify(c.indexErrors));
  c = cfg({ indexes: [idx("inherit", { include: ["src", "tests"], aliases: [{ path: "/p", exclude: ["tests"] }] })] });
  check("an alias whose own exclude contradicts the include it inherits is invalid", c.indexes.length === 0 && /aliases\.0 \(\/p\): include tests is also excluded/.test(c.indexErrors[0]?.message ?? ""), JSON.stringify(c.indexErrors));
  c = cfg({ indexes: [idx("fine", { include: ["src"], exclude: ["tests"], aliases: [{ path: "/p", include: ["tests"], exclude: ["cache"] }] })] });
  check("an alias with its own non-contradictory rules is fine", c.indexes.length === 1, JSON.stringify(c.indexErrors));
  c = cfg({ indexes: [idx("dup", { include: ["first"] }), idx("dup", { include: ["second"] }), idx("other")] });
  check("a duplicate name: the first entry wins", c.indexes.length === 2 && c.indexes[0].include[0] === "first", JSON.stringify(c.indexes));
  check("…and the later one is reported", c.indexErrors.length === 1 && c.indexErrors[0].kind === "duplicate" && c.indexErrors[0].entry === 1, JSON.stringify(c.indexErrors));
  check("…as a caveat every query carries", duplicateCaveats(c).length === 1 && /reuses the name "dup"/.test(duplicateCaveats(c)[0]), JSON.stringify(duplicateCaveats(c)));
  const example = parseConfig(JSON.parse(readFileSync(join(root, "config.example.json"), "utf8")));
  check("config.example.json loads with no index errors", example.indexErrors.length === 0 && example.indexes.length > 0, JSON.stringify(example.indexErrors));

  console.log("\n-- selectIndex and selectScope --");
  t = throws(() => selectIndex(cfg({ indexes: [idx("off", { enabled: false })] })), /no enabled indexes configured/);
  check("no enabled index is an error", t.ok, t.detail);
  check("a lone enabled index is picked without a name", selectIndex(cfg({ indexes: [idx("only"), idx("off", { enabled: false })] })).name === "only");
  t = throws(() => selectIndex(cfg({ indexes: [idx("a"), idx("b")] })), /multiple indexes configured \(a, b\)\. Pass "scope"/);
  check("several indexes and no default is an error naming them", t.ok, t.detail);
  check("defaultIndex is used when no name is passed", selectIndex(cfg({ indexes: [idx("a"), idx("b")], defaultIndex: "b" })).name === "b");
  check("an explicit name beats defaultIndex", selectIndex(cfg({ indexes: [idx("a"), idx("b")], defaultIndex: "b" }), "a").name === "a");
  t = throws(() => selectIndex(cfg({ indexes: [idx("a"), idx("b", { enabled: false })] }), "b"), /index "b" is disabled\. Enabled: a/);
  check("a disabled index can't be selected by name", t.ok, t.detail);
  t = throws(() => selectIndex(cfg({ indexes: [idx("a"), idx("b")], defaultIndex: "zzz" })), /no enabled index named "zzz"\. Known: a, b/);
  check("an unknown defaultIndex is an error, not a fallback", t.ok, t.detail);
  t = throws(() => selectIndex(cfg({ indexes: [idx("bad", { nope: 1 }), idx("a")] }), "bad"), /index "bad" was not loaded — indexes\.0 \("bad"\) is invalid/);
  check("selecting an invalid index says why it wasn't loaded", t.ok, t.detail);

  const three = cfg({ indexes: [idx("a"), idx("b"), idx("c")], defaultIndex: "b" });
  check("an omitted scope is the default project", selectScope(three, undefined).map((i) => i.name).join() === "b");
  check("a scope keeps the order given", selectScope(three, ["c", "a"]).map((i) => i.name).join() === "c,a");
  for (const [label, bad, pattern] of [
    ["an empty scope", [], /non-empty list/],
    ["a scope that isn't a list", "a", /non-empty list/],
    ["a scope with a non-string", ["a", 3], /non-empty list/],
    ["a scope naming a project twice", ["a", "a"], /lists "a" more than once/],
    ["a scope with an unknown project", ["a", "zzz"], /no enabled index named "zzz"/],
  ]) {
    t = throws(() => selectScope(three, bad), pattern);
    check(`${label} is an error`, t.ok, t.detail);
  }

  console.log("\n-- stack detection --");
  const repo = (name, files) => {
    const dir = join(sandbox, "repos", name);
    mkdirSync(dir, { recursive: true });
    for (const [f, content] of Object.entries(files)) write(join(dir, f), content);
    return dir;
  };
  check("laravel/framework in require is laravel", detectAdapter(repo("laravel", { "composer.json": LARAVEL })).adapter === "laravel");
  check("an illuminate/* package in require-dev is laravel", detectAdapter(repo("illuminate", { "composer.json": { "require-dev": { "illuminate/container": "^11" } } })).adapter === "laravel");
  check("artisan alone is not laravel", detectAdapter(repo("artisan-only", { artisan: "" })).adapter === null);
  check("a composer.json without laravel packages is not laravel", detectAdapter(repo("plain-php", { "composer.json": { require: { "monolog/monolog": "^3" } } })).adapter === null);
  let d = detectAdapter(repo("broken-composer", { "composer.json": "{not json" }));
  check("an unreadable composer.json is treated as no manifest, and said so", d.adapter === null && /can't be read as JSON .* treated as no manifest/.test(d.notes.join()), JSON.stringify(d));
  check("mix.exs is phoenix", detectAdapter(repo("phoenix", { "mix.exs": "" })).adapter === "phoenix");
  check("package.json is node", detectAdapter(repo("node", { "package.json": "{}" })).adapter === "node");
  check("laravel is checked before the planned stacks", detectAdapter(repo("both", { "composer.json": LARAVEL, "package.json": "{}" })).adapter === "laravel");
  check("no manifest detects nothing", detectAdapter(repo("empty", {})).adapter === null);

  console.log("\n-- roots --");
  const main = repo("multi", { "composer.json": LARAVEL });
  const alias = repo("multi-alias", {});
  const roots = resolveRoots(cfg({ indexes: [{ name: "m", root: main, aliases: [{ path: alias, include: ["src"] }] }] }).indexes[0]);
  check("the main root comes first, then aliases, with their own rules", roots.length === 2 && roots[0].kind === "root" && roots[1].kind === "alias" && roots[1].include[0] === "src" && roots[0].include === null, JSON.stringify(roots));
  t = throws(() => resolveRoots(cfg({ indexes: [{ name: "m", root: main, aliases: [{ path: join(sandbox, "nope") }] }] }).indexes[0]), /alias .*nope.* which does not exist/);
  check("a missing alias is an error", t.ok, t.detail);
  write(join(sandbox, "a-file"), "");
  t = throws(() => resolveRoots(cfg({ indexes: [{ name: "m", root: main, aliases: [{ path: join(sandbox, "a-file") }] }] }).indexes[0]), /is not a directory/);
  check("an alias that is a file is an error", t.ok, t.detail);
  // "junction": a directory link Windows allows without admin rights; other platforms ignore the type.
  symlinkSync(main, join(sandbox, "link-to-main"), "junction");
  t = throws(() => resolveRoots(cfg({ indexes: [{ name: "m", root: main, aliases: [{ path: join(sandbox, "link-to-main") }] }] }).indexes[0]), /lists the same directory twice/);
  check("an alias that resolves to the main root through a symlink is an error", t.ok, t.detail);

  console.log("\n-- getAdapter --");
  clearAdapterCache();
  const conf = cfg({});
  t = throws(() => getAdapter(conf, cfg({ indexes: [{ name: "gone", root: join(sandbox, "nope") }] }).indexes[0]), /index "gone" points at .*nope, which does not exist/);
  check("a missing root is an error", t.ok, t.detail);
  t = throws(() => getAdapter(conf, cfg({ indexes: [{ name: "blank", root: join(sandbox, "repos", "empty") }] }).indexes[0]), /could not detect a stack .* Set "adapter" explicitly on index "blank"/);
  check("an undetectable stack is an error", t.ok, t.detail);
  t = throws(() => getAdapter(conf, cfg({ indexes: [{ name: "why", root: join(sandbox, "repos", "broken-composer") }] }).indexes[0]), /could not detect a stack .*treated as no manifest/);
  check("…and says what detection found along the way", t.ok, t.detail);
  t = throws(() => getAdapter(conf, cfg({ indexes: [{ name: "ex", root: join(sandbox, "repos", "phoenix") }] }).indexes[0]), /adapter "phoenix" is not implemented yet \(index "ex"\)\. Implemented: laravel/);
  check("a detected but planned stack says it isn't implemented", t.ok, t.detail);
  t = throws(() => getAdapter(conf, cfg({ indexes: [{ name: "forced", root: join(sandbox, "repos", "laravel"), adapter: "node" }] }).indexes[0]), /adapter "node" is not implemented yet/);
  check("an explicit adapter overrides detection", t.ok, t.detail);
  t = throws(() => getAdapter(conf, cfg({ indexes: [{ name: "nocomposer", root: join(sandbox, "repos", "empty"), adapter: "laravel" }] }).indexes[0]), /uses the laravel adapter, but its root has no composer\.json/);
  check("an explicit laravel root with no composer.json is an error naming the file", t.ok, t.detail);
  t = throws(() => getAdapter(conf, cfg({ indexes: [{ name: "badjson", root: join(sandbox, "repos", "broken-composer"), adapter: "laravel" }] }).indexes[0]), /index "badjson": .*composer\.json can't be read as JSON/);
  check("a laravel root whose composer.json can't be read is an error", t.ok, t.detail);

  const laravelRoot = join(sandbox, "repos", "laravel");
  const lcfg = cfg({ indexes: [{ name: "lara", root: laravelRoot }] }).indexes[0];
  const first = getAdapter(conf, lcfg);
  check("auto builds the laravel adapter with the resolve capability", first.id === "laravel" && typeof first.resolve?.resolveSymbol === "function" && typeof first.stats === "function");
  check("an unchanged config reuses the adapter", getAdapter(conf, lcfg) === first);
  const withAlias = cfg({ indexes: [{ name: "lara", root: laravelRoot, aliases: [{ path: alias }] }] }).indexes[0];
  const second = getAdapter(conf, withAlias);
  check("a changed config for the same name rebuilds it", second !== first && second.stats().roots.length === 2, JSON.stringify(second.stats().roots));
  check("…and include changes rebuild it too", getAdapter(conf, { ...withAlias, include: ["app"] }) !== second);
  clearAdapterCache();
  check("clearAdapterCache rebuilds", getAdapter(conf, lcfg) !== first);

  t = throws(() => requireCapability({ id: "laravel", stats: () => ({}), resolve: null }, "resolve", "lara", "stackmap_resolve"), /stackmap_resolve needs the "resolve" capability, which index "lara" \(adapter "laravel"\) does not provide/);
  check("a missing capability is an error naming the tool, index, adapter and capability", t.ok, t.detail);

  console.log("\n-- addIndex --");
  const guarded = { guard: { enabled: true, protectedBranches: ["main"] }, houseRules: { enabled: false }, indexes: [{ name: "keep", root: "~/keep" }, { name: "broken", nope: 1 }] };
  write(explicit, guarded);
  let added = addIndex({ name: "new", root: laravelRoot, aliases: [{ path: alias, include: ["src"] }] });
  let onDisk = JSON.parse(readFileSync(explicit, "utf8"));
  check("adds the entry to the config file loadConfig reads", added.configPath === explicit && added.created === false && onDisk.indexes.at(-1).name === "new", JSON.stringify(added));
  check("…keeping sections it doesn't model, exactly", JSON.stringify(onDisk.guard) === JSON.stringify(guarded.guard) && JSON.stringify(onDisk.houseRules) === JSON.stringify(guarded.houseRules));
  check("…and every existing entry, even an invalid one", JSON.stringify(onDisk.indexes.slice(0, 2)) === JSON.stringify(guarded.indexes));
  t = throws(() => addIndex({ name: "keep", root: laravelRoot }), /already has an index named "keep"; not changed/);
  check("a name already used is refused", t.ok, t.detail);
  t = throws(() => addIndex({ name: "broken", root: laravelRoot }), /already has an index named "broken"/);
  check("…including the name of an invalid entry", t.ok, t.detail);
  t = throws(() => addIndex({ name: "x", root: laravelRoot, bogus: true }), /the index is invalid: .*bogus/);
  check("an invalid entry is refused", t.ok, t.detail);
  t = throws(() => addIndex({ name: "contradiction", root: laravelRoot, include: ["tests"], exclude: ["tests"] }), /the index is invalid: include tests is also excluded/);
  check("an entry that includes and excludes the same directory is refused", t.ok, t.detail);
  check("…and a refused add leaves the file unchanged", readFileSync(explicit, "utf8") === `${JSON.stringify(onDisk, null, 2)}\n`);
  rmSync(explicit);
  added = addIndex({ name: "first", root: laravelRoot });
  check("with no config file, it creates the first resolution candidate", added.created === true && added.configPath === explicit && existsSync(explicit) && JSON.parse(readFileSync(explicit, "utf8")).indexes[0].name === "first", JSON.stringify(added));
} finally {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall config checks passed" : `\n${failed} config check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
