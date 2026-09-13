#!/usr/bin/env node
/**
 * Regression suite for no-suppress.mjs and the suppression-rules.mjs catalog.
 *
 * Fixture directives are assembled from fragments with F(), for the same reason the catalog's
 * patterns are: a file containing them literally cannot be saved while the guard is running.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES, CATEGORIES, rulesForPath } from "./suppression-rules.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const guard = join(scripts, "guard.sh");
const BLOCK = 2, ALLOW = 0;
const RULE_BLOCK = /^Blocked:/m;
let failed = 0;
const F = (...parts) => parts.join("");

const sandbox = mkdtempSync(join(tmpdir(), "stackmap-suppress-"));
const configPath = join(sandbox, "config.json");
const env = { ...process.env, STACKMAP_CONFIG: configPath, STACKMAP_STATE: join(sandbox, "state") };
const setConfig = (obj) => writeFileSync(configPath, JSON.stringify(obj));

const tally = (ok) => {
  if (!ok) failed++;
  return ok;
};

function check(label, expected, payload, { raw = false, reason } = {}) {
  const r = spawnSync(guard, ["no-suppress.mjs"], { input: raw ? payload : JSON.stringify(payload), encoding: "utf8", env });
  const want = reason ?? (expected === BLOCK ? RULE_BLOCK : null);
  const ok = tally(r.status === expected && (!want || want.test(r.stderr ?? "")));
  const verdict = r.status === BLOCK ? "BLOCK" : r.status === ALLOW ? "allow" : `exit ${r.status}`;
  console.log(`${ok ? "PASS" : "FAIL"}  ${verdict.padEnd(5)} ${label}`);
  if (!ok) console.log(`        expected ${expected}${want ? ` matching ${want}` : ""}, stderr: ${(r.stderr ?? "").trim().slice(0, 240)}`);
}

const edit = (file_path, old_string, new_string) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path, old_string, new_string } });
const write = (file_path, content) => ({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path, content } });
const add = (file, line) => edit(join(sandbox, file), "const a = 1;", `${line}\nconst a = 1;`);

try {
  setConfig({});

  console.log("-- catalog integrity --");
  {
    const ids = RULES.map((r) => r.id);
    console.log(`${tally(new Set(ids).size === ids.length) ? "PASS" : "FAIL"}  rule ids are unique`);
    const badCategory = RULES.filter((r) => !CATEGORIES.includes(r.category)).map((r) => r.id);
    console.log(`${tally(badCategory.length === 0) ? "PASS" : "FAIL"}  every rule has a known category${badCategory.length ? `  <- ${badCategory}` : ""}`);
    // A guardrail that blocks its own maintenance is a design defect: the catalog, this suite, and
    // the guard must be editable while the guard is running.
    for (const file of ["suppression-rules.mjs", "suppress-test.mjs", "no-suppress.mjs"]) {
      const source = readFileSync(join(scripts, file), "utf8");
      const selfHits = rulesForPath(file).filter((r) => r.pattern.test(source)).map((r) => r.id);
      console.log(`${tally(selfHits.length === 0) ? "PASS" : "FAIL"}  ${file} matches none of its own rules${selfHits.length ? `  <- ${selfHits}` : ""}`);
    }
  }

  console.log("\n-- lookalikes that must survive --");
  check("regression: Rust iterator skip(n) is not a skipped test", ALLOW, edit("/x/a.rs", "let a = 1;", F("let rest = lines.iter().sk", "ip(1);")));
  check("regression: Java stream skip(n) is not a skipped test", ALLOW, edit("/x/A.java", "int a;", F("long n = list.stream().sk", "ip(n).count();")));
  check("Laravel collection skip(2) in PHP", ALLOW, edit("/x/a.php", "$a = 1;", F("$rest = $items->sk", "ip(2);")));
  check("a model's fit method is not a focused test", ALLOW, edit("/x/train.ts", "const a = 1;", "model.fit(data);"));
  check("process termination is not a skipped test", ALLOW, edit("/x/run.mjs", "const a = 1;", F("if (bad) process.exi", "t(1);")));
  check("prose file may discuss directives", ALLOW, write(join(sandbox, "README.md"), F("we ban eslint", "-disable")));
  check("directive text in a file type it does not apply to", ALLOW, edit("/x/a.py", "a = 1", F("# eslint", "-disable is a JS thing")));
  check("edit that REMOVES a suppression", ALLOW, edit("/x/a.js", F("// eslint", "-disable-next-line\nconst a = 1;"), "const a = 1;"));
  check("editing around a directive that was already there", ALLOW, edit("/x/a.js", F("// eslint", "-disable-next-line\nconst a = 1;"), F("// eslint", "-disable-next-line\nconst a = 2;")));
  check("ordinary code edit", ALLOW, edit("/x/a.js", "const a = 1;", "const a = 2;"));
  check("tsconfig turning a check ON", ALLOW, edit("/x/tsconfig.json", '"noUnusedLocals": false', '"noUnusedLocals": true'));
  {
    const existing = join(sandbox, "legacy.ts");
    writeFileSync(existing, F("// @ts", "-nocheck\nexport const a = 1;\n"));
    check("regression: Write of a file that ALREADY carries a directive", ALLOW, write(existing, F("// @ts", "-nocheck\nexport const a = 2;\n")));
  }

  console.log("\n-- inline directives, one per language family --");
  check("JS lint directive", BLOCK, add("a.js", F("// eslint", "-disable-next-line no-unused-vars")));
  check("TS type directive", BLOCK, add("a.ts", F("// @ts", "-expect-error")));
  check("JS focused test (.only narrows the run)", BLOCK, add("a.test.ts", F("it.on", "ly('works', () => {});")));
  check("JS skipped test", BLOCK, add("a.test.ts", F("describe.sk", "ip('suite', () => {});")));
  check("JS chained skip through a modifier (concurrent)", BLOCK, add("a.test.ts", F("test.concurrent.sk", "ip('x', () => {});")));
  check("JS x-prefixed test", BLOCK, add("a.test.js", F("xi", "t('x', () => {});")));
  check("JS coverage directive", BLOCK, add("a.js", F("/* istanbul ", "ignore next */")));
  check("Python lint directive", BLOCK, edit("/x/a.py", "import os", F("import os  # pylint: ", "disable=unused-import")));
  check("Python type directive", BLOCK, edit("/x/a.py", "a = f()", F("a = f()  # type: ", "ignore")));
  check("Python skipped test", BLOCK, edit("/x/test_a.py", "def test_a():", F("@pytest.mark.sk", "ip\ndef test_a():")));
  check("Python coverage pragma", BLOCK, edit("/x/a.py", "def f():", F("def f():  # pragma: no ", "cover")));
  check("Rust dead-code allowance", BLOCK, edit("/x/a.rs", "fn f() {}", F("#[al", "low(dead_code)]\nfn f() {}")));
  check("Rust expect attribute (the newer form)", BLOCK, edit("/x/a.rs", "fn f() {}", F("#[exp", "ect(dead_code)]\nfn f() {}")));
  check("Rust ignored test", BLOCK, edit("/x/a.rs", "#[test]", F("#[test]\n#[ig", "nore]")));
  check("Go lint directive", BLOCK, edit("/x/a.go", "x := 1", F("x := 1 //no", "lint:unused")));
  check("Go skipped test", BLOCK, edit("/x/a_test.go", "func TestA(t *testing.T) {", F("func TestA(t *testing.T) {\n\tt.Sk", "ip(\"later\")")));
  check("Kotlin/Java warnings annotation", BLOCK, edit("/x/A.kt", "fun f() {}", F("@Supp", "ress(\"UNUSED\")\nfun f() {}")));
  check("Java disabled test", BLOCK, edit("/x/ATest.java", "@Test", F("@Test\n@Disa", "bled")));
  check("C# warning pragma", BLOCK, edit("/x/A.cs", "int a;", F("#pragma warning ", "disable CS0168\nint a;")));
  check("C++ maybe_unused (dead code kept alive)", BLOCK, edit("/x/a.cpp", "int a;", F("[[maybe", "_unused]] int a;")));
  check("PHP phpstan directive", BLOCK, edit("/x/a.php", "$a = 1;", F("/** @phpstan", "-ignore-next-line */\n$a = 1;")));
  check("PHP skipped test", BLOCK, edit("/x/ATest.php", "public function testA() {", F("public function testA() {\n$this->markTest", "Skipped();")));
  check("Ruby rubocop directive", BLOCK, edit("/x/a.rb", "a = 1", F("a = 1 # rubocop:", "disable Lint/UselessAssignment")));
  check("Elixir unused-function compile attribute", BLOCK, edit("/x/a.ex", "def f, do: 1", F("@compile {:no", "warn_unused_function, f: 0}\ndef f, do: 1")));
  check("shellcheck directive", BLOCK, edit("/x/a.sh", "echo $a", F("# shellcheck ", "disable=SC2086\necho $a")));
  check("git hook bypass in a script", BLOCK, edit("/x/release.sh", "git commit -m x", F("git commit --no", "-verify -m x")));

  console.log("\n-- config-level relaxations --");
  check("tsconfig unused-locals check turned off", BLOCK, edit("/x/tsconfig.json", '"noUnusedLocals": true', '"noUnusedLocals": false'));
  check("tsconfig strict turned off", BLOCK, edit("/x/tsconfig.build.json", '"strict": true', '"strict": false'));
  check("Cargo.toml lint level set to allow", BLOCK, edit("/x/Cargo.toml", "[package]", F('[package]\n[lints.rust]\ndead_code = "al', 'low"')));
  check("eslint config rule turned off", BLOCK, edit("/x/eslint.config.js", "rules: {", F('rules: { "no-unused-vars": "of', 'f",')));
  check("phpstan ignoreErrors added", BLOCK, edit("/x/phpstan.neon", "parameters:", F("parameters:\n  ignore", "Errors:\n    - '#.*#'")));
  check("pyproject ruff ignore added", BLOCK, edit("/x/pyproject.toml", "[tool.ruff]", F("[tool.ruff]\nign", "ore = [\"F401\"]")));
  check("GitHub Actions step allowed to fail", BLOCK, edit("/repo/.github/workflows/ci.yml", "run: npm test", F("run: npm test\n        continue-on-", "error: true")));

  console.log("\n-- per-rule counting --");
  check(
    "regression: a DIFFERENT directive added next to an existing one",
    BLOCK,
    edit("/x/a.ts", F("// eslint", "-disable-line\nconst a = 1;"), F("// eslint", "-disable-line\n// @ts", "-nocheck\nconst a = 1;")),
  );
  check(
    "a second copy of the same directive",
    BLOCK,
    edit("/x/a.js", F("// eslint", "-disable-next-line\nconst a = 1;"), F("// eslint", "-disable-next-line\nconst a = 1;\n// eslint", "-disable-next-line\nconst b = 2;")),
  );
  {
    const existing = join(sandbox, "grow.ts");
    writeFileSync(existing, F("// @ts", "-nocheck\nexport const a = 1;\n"));
    check("Write adding a directive to a file that has a different one", BLOCK, write(existing, F("// @ts", "-nocheck\n// eslint", "-disable\nexport const a = 1;\n")));
  }

  console.log("\n-- notebooks --");
  {
    const nb = join(sandbox, "analysis.ipynb");
    const notebook = (language, cells) => JSON.stringify({ metadata: language ? { kernelspec: { language } } : {}, cells });
    const nbEdit = (input) => ({ hook_event_name: "PreToolUse", tool_name: "NotebookEdit", tool_input: { notebook_path: nb, ...input } });
    writeFileSync(nb, notebook("python", [
      { id: "c1", cell_type: "code", source: ["import os\n"] },
      { id: "m1", cell_type: "markdown", source: ["# Notes\n"] },
    ]));
    check("code cell gains a Python directive", BLOCK, nbEdit({ cell_id: "c1", new_source: F("import os  # no", "qa") }));
    check("ordinary code cell edit", ALLOW, nbEdit({ cell_id: "c1", new_source: "import sys" }));
    check("markdown cell is prose", ALLOW, nbEdit({ cell_id: "m1", new_source: F("Avoid # no", "qa comments") }));
    check("inserted code cell is checked", BLOCK, nbEdit({ edit_mode: "insert", cell_type: "code", new_source: F("x = f()  # type: ", "ignore") }));
    check("deleting a cell introduces nothing", ALLOW, nbEdit({ cell_id: "c1", edit_mode: "delete", new_source: "" }));
    check("unknown cell id fails closed", BLOCK, nbEdit({ cell_id: "nope", new_source: "x = 1" }), { reason: /no cell with id/ });
    writeFileSync(nb, notebook(null, [{ id: "c1", cell_type: "code", source: "" }]));
    check("notebook with no declared language is checked against every language", BLOCK, nbEdit({ cell_id: "c1", new_source: F("let a = b; // eslint", "-disable-line") }));
  }

  console.log("\n-- configuration --");
  setConfig({ guard: { noSuppress: { disableCategories: ["coverage"] } } });
  check("a disabled category is not enforced", ALLOW, add("a.js", F("/* istanbul ", "ignore next */")));
  check("…other categories still are", BLOCK, add("a.js", F("// eslint", "-disable-next-line")));
  setConfig({ guard: { noSuppress: { disableCategories: ["nonsense"] } } });
  check("an unknown category name is a config error, not a silent no-op", BLOCK, add("a.js", "x"), { reason: /unknown category/ });
  setConfig({ guard: { noSuppress: { enabled: false } } });
  check("noSuppress.enabled=false turns the rule off", ALLOW, add("a.js", F("// eslint", "-disable-next-line")));
  setConfig({});

  console.log("\n-- failure paths: fail CLOSED --");
  check("malformed JSON on stdin", BLOCK, "{not json", { raw: true, reason: /unreadable hook payload/ });
  check("empty stdin", BLOCK, "", { raw: true, reason: /unreadable hook payload/ });
  check("Edit with no readable content", BLOCK, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/x/a.js" } }, { reason: /no readable/ });
  check("Write with no readable content", BLOCK, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/x/a.js" } }, { reason: /no readable/ });
  {
    const dirAsFile = join(sandbox, "is-a-directory.js");
    mkdirSync(dirAsFile);
    check("Write over a path that exists but cannot be read as a file", BLOCK, write(dirAsFile, "const a = 1;"), { reason: /could not be read/ });
  }

  console.log("\n-- tools this guard does not own pass through --");
  check("Bash is not this guard's business", ALLOW, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: F("echo eslint", "-disable") } });
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall no-suppress checks passed" : `\n${failed} no-suppress check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
