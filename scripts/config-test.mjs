#!/usr/bin/env node
/**
 * Config and registry suite: config resolution order, validation, index selection, stack detection,
 * and adapter construction. Needs `npm run build`. Environment variables and HOME point at
 * temporary directories, so the real config is never read.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { configCandidates, loadConfig, selectIndex, ConfigSchema, expandPath } = await import(join(root, "dist/config.js"));
const { detectAdapter, getAdapter, clearAdapterCache } = await import(join(root, "dist/adapters/registry.js"));

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
const saved = { HOME: process.env.HOME, STACKMAP_CONFIG: process.env.STACKMAP_CONFIG, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
const setEnv = (vars) => {
  for (const k of ["STACKMAP_CONFIG", "XDG_CONFIG_HOME"]) delete process.env[k];
  Object.assign(process.env, vars);
};
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
};
const cfg = (obj) => ConfigSchema.parse(obj);
const idx = (name, extra = {}) => ({ name, root: sandbox, ...extra });

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
  write(explicit, { indexes: [{ name: "", root: "~/x", adapter: "rails" }], notesDir: 5 });
  t = throws(() => loadConfig(), /is invalid:[\s\S]*indexes\.0\.name[\s\S]*indexes\.0\.adapter[\s\S]*notesDir/);
  check("schema errors list every bad path", t.ok, t.detail);
  write(explicit, { indexes: [{ name: "a", root: "~/src/a" }] });
  const a = loadConfig().config.indexes[0];
  check("index defaults are filled in", a.adapter === "auto" && a.enabled === true && JSON.stringify(a.options) === "{}", JSON.stringify(a));
  check("globalExclude has its defaults", loadConfig().config.globalExclude.includes("vendor") && loadConfig().config.globalExclude.includes("node_modules"));
  check("expandPath expands ~ against HOME", expandPath("~/src/a") === join(home, "src", "a"), expandPath("~/src/a"));

  console.log("\n-- selectIndex --");
  t = throws(() => selectIndex(cfg({ indexes: [idx("off", { enabled: false })] })), /no enabled indexes configured/);
  check("no enabled index is an error", t.ok, t.detail);
  check("a lone enabled index is picked without a name", selectIndex(cfg({ indexes: [idx("only"), idx("off", { enabled: false })] })).name === "only");
  t = throws(() => selectIndex(cfg({ indexes: [idx("a"), idx("b")] })), /multiple indexes configured \(a, b\)/);
  check("several indexes and no default is an error naming them", t.ok, t.detail);
  check("defaultIndex is used when no name is passed", selectIndex(cfg({ indexes: [idx("a"), idx("b")], defaultIndex: "b" })).name === "b");
  check("an explicit name beats defaultIndex", selectIndex(cfg({ indexes: [idx("a"), idx("b")], defaultIndex: "b" }), "a").name === "a");
  t = throws(() => selectIndex(cfg({ indexes: [idx("a"), idx("b", { enabled: false })] }), "b"), /no enabled index named "b"\. Known: a/);
  check("a disabled index can't be selected by name", t.ok, t.detail);
  t = throws(() => selectIndex(cfg({ indexes: [idx("a"), idx("b")], defaultIndex: "zzz" })), /no enabled index named "zzz"\. Known: a, b/);
  check("an unknown defaultIndex is an error, not a fallback", t.ok, t.detail);

  console.log("\n-- stack detection --");
  const repo = (name, markers) => {
    const dir = join(sandbox, "repos", name);
    mkdirSync(dir, { recursive: true });
    for (const m of markers) writeFileSync(join(dir, m), "");
    return dir;
  };
  check("artisan is laravel", detectAdapter(repo("laravel", ["artisan"])) === "laravel");
  check("mix.exs is phoenix", detectAdapter(repo("phoenix", ["mix.exs"])) === "phoenix");
  check("package.json is node", detectAdapter(repo("node", ["package.json"])) === "node");
  check("artisan wins over package.json", detectAdapter(repo("both", ["artisan", "package.json"])) === "laravel");
  check("no marker detects nothing", detectAdapter(repo("empty", [])) === null);

  console.log("\n-- getAdapter --");
  clearAdapterCache();
  const conf = cfg({});
  t = throws(() => getAdapter(conf, cfg({ indexes: [{ name: "gone", root: join(sandbox, "nope") }] }).indexes[0]), /index "gone" points at .*nope, which does not exist/);
  check("a missing root is an error", t.ok, t.detail);
  t = throws(() => getAdapter(conf, cfg({ indexes: [{ name: "blank", root: join(sandbox, "repos", "empty") }] }).indexes[0]), /could not detect a stack .* Set "adapter" explicitly on index "blank"/);
  check("an undetectable stack is an error", t.ok, t.detail);
  t = throws(() => getAdapter(conf, cfg({ indexes: [{ name: "ex", root: join(sandbox, "repos", "phoenix") }] }).indexes[0]), /adapter "phoenix" is not implemented yet \(index "ex"\)\. Implemented: laravel/);
  check("a detected but planned stack says it isn't implemented", t.ok, t.detail);
  t = throws(() => getAdapter(conf, cfg({ indexes: [{ name: "forced", root: join(sandbox, "repos", "laravel"), adapter: "node" }] }).indexes[0]), /adapter "node" is not implemented yet/);
  check("an explicit adapter overrides detection", t.ok, t.detail);

  const laravelRoot = join(sandbox, "repos", "laravel");
  write(join(laravelRoot, "composer.json"), { autoload: { "psr-4": { "App\\": "app/" } } });
  const lcfg = cfg({ indexes: [{ name: "lara", root: laravelRoot }] }).indexes[0];
  const first = getAdapter(conf, lcfg);
  check("auto builds the laravel adapter", typeof first.resolveSymbol === "function" && typeof first.stats === "function");
  check("adapters are cached by index name", getAdapter(conf, lcfg) === first);
  clearAdapterCache();
  check("clearAdapterCache rebuilds", getAdapter(conf, lcfg) !== first);
} finally {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall config checks passed" : `\n${failed} config check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
