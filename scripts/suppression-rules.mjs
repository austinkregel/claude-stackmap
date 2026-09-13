/**
 * The catalog of check-silencing directives that no-suppress.mjs blocks an edit from introducing.
 *
 * Data, not code: each rule names a category, the files it applies to, and a pattern. Patterns are
 * scoped to file types so a lookalike in another language cannot match — Rust and Java iterators
 * have a `skip(n)` method, and a pattern written for JavaScript test runners must never see them.
 *
 * Every pattern is assembled from fragments with `re(...)`, and rule ids avoid directive text, so
 * no complete directive appears in this file's source. Otherwise the guard would block edits to
 * the very file that defines it. suppress-test.mjs pins that: the catalog's own source must match
 * none of the rules that apply to it.
 *
 * Categories (guard.noSuppress.disableCategories can switch one off):
 *   lint        a linter or static analyser told to ignore code or a rule
 *   type        a type checker told to ignore code, or its strictness lowered
 *   test-skip   a test skipped, focused (which skips the rest), or excluded from the run
 *   coverage    code excluded from coverage measurement
 *   dead-code   unused-code diagnostics silenced instead of deleting the code
 *   hook-bypass commit/push hooks bypassed
 *   ci          a CI step allowed to fail without failing the build
 *
 * Stated limits: directives written through Bash (`sed -i`, `cat >`) are not seen by an Edit/Write
 * hook. Pest's `->skip()` chain is not matched, because Laravel collections share the method name
 * and the two cannot be told apart from the text. ESLint rules configured inside package.json are
 * not matched.
 */

export const CATEGORIES = ["lint", "type", "test-skip", "coverage", "dead-code", "hook-bypass", "ci"];

/** Build a RegExp from fragments. The first argument is the flags. */
const re = (flags, ...parts) => new RegExp(parts.join(""), flags);

const PROSE = [".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"];

const JS = { ext: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro"] };
const PY = { ext: [".py", ".pyi", ".pyx"] };
const RS = { ext: [".rs"] };
const GO = { ext: [".go"] };
const JVM = { ext: [".java", ".kt", ".kts", ".scala", ".groovy"] };
const CS = { ext: [".cs"] };
const C = { ext: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".m", ".mm"] };
const SWIFT = { ext: [".swift"] };
const PHP = { ext: [".php"] };
const RUBY = { ext: [".rb", ".rake"] };
const ELIXIR = { ext: [".ex", ".exs"] };
const SHELL = { ext: [".sh", ".bash", ".zsh"] };
const CSS = { ext: [".css", ".scss", ".sass", ".less"] };
const ANY_CODE = { any: true };

const TSCONFIG = { names: /^(?:tsconfig|jsconfig)(?:\..+)?\.json$/ };
const JS_TEST_CONFIG = { names: /^(?:jest|vitest)\.config\.\w+$/ };

export const RULES = [
  // JavaScript / TypeScript
  { id: "js-eslint-directive", category: "lint", files: JS, pattern: re("", "eslint", "-disable") },
  { id: "js-biome-directive", category: "lint", files: { ext: [...JS.ext, ".json", ".jsonc", ".css"] }, pattern: re("", "biome", "-ignore") },
  { id: "js-oxlint-directive", category: "lint", files: JS, pattern: re("", "oxlint", "-disable") },
  { id: "js-deno-lint-directive", category: "lint", files: JS, pattern: re("", "deno-lint", "-ignore") },
  { id: "js-tslint-directive", category: "lint", files: JS, pattern: re("", "tslint", ":disable") },
  { id: "js-jshint-directive", category: "lint", files: JS, pattern: re("", "jshint", "\\s+ignore") },
  { id: "ts-ignore-directive", category: "type", files: JS, pattern: re("", "@ts", "-ignore\\b") },
  { id: "ts-nocheck-directive", category: "type", files: JS, pattern: re("", "@ts", "-nocheck\\b") },
  { id: "ts-expect-error-directive", category: "type", files: JS, pattern: re("", "@ts", "-expect-error\\b") },
  {
    id: "js-test-skipped-or-focused",
    category: "test-skip",
    files: JS,
    pattern: re("", "(?<![\\w$.])(?:it|test|describe|suite|context|specify|bench)(?:\\.\\w+)*\\.", "(?:sk", "ipIf|sk", "ip|on", "ly)\\b"),
  },
  { id: "js-mocha-runtime-skip", category: "test-skip", files: JS, pattern: re("", "(?<![\\w$.])this\\.sk", "ip\\s*\\(") },
  { id: "js-x-or-f-prefixed-test", category: "test-skip", files: JS, pattern: re("", "(?<![\\w$.])(?:x(?:it|test|describe|context|specify)|f(?:it|describe|context))", "\\s*\\(") },
  { id: "js-coverage-directive", category: "coverage", files: JS, pattern: re("", "(?:istanbul|c8|v8)\\s+", "ignore\\b") },

  // Python
  { id: "py-noqa-directive", category: "lint", files: PY, pattern: re("", "#\\s*(?:(?:flake8|ruff):\\s*)?", "noqa\\b") },
  { id: "py-pylint-directive", category: "lint", files: PY, pattern: re("", "#\\s*pylint:\\s*", "disable") },
  { id: "py-bandit-directive", category: "lint", files: PY, pattern: re("", "#\\s*", "nosec\\b") },
  { id: "py-type-directive", category: "type", files: PY, pattern: re("", "#\\s*type:\\s*", "ignore\\b") },
  { id: "py-pyright-directive", category: "type", files: PY, pattern: re("", "#\\s*pyright:\\s*", "ignore\\b") },
  { id: "py-pyre-directive", category: "type", files: PY, pattern: re("", "#\\s*pyre-", "(?:ignore|fixme)\\b") },
  { id: "py-mypy-file-directive", category: "type", files: PY, pattern: re("", "#\\s*mypy:\\s*", "ignore-errors") },
  { id: "py-pytest-marker", category: "test-skip", files: PY, pattern: re("", "@pytest\\.mark\\.", "(?:sk", "ipif|sk", "ip|xfail)\\b") },
  { id: "py-unittest-decorator", category: "test-skip", files: PY, pattern: re("", "@(?:unittest\\.)?sk", "ip(?:If|Unless)?\\s*\\(") },
  { id: "py-runtime-skip", category: "test-skip", files: PY, pattern: re("", "(?:\\bpytest\\.(?:sk", "ip|xfail)|\\.sk", "ipTest)\\s*\\(") },
  { id: "py-coverage-pragma", category: "coverage", files: PY, pattern: re("", "#\\s*pragma:\\s*no\\s*", "cover") },

  // Rust
  { id: "rs-lint-attribute", category: "lint", files: RS, pattern: re("", "#!?\\[\\s*(?:al", "low|exp", "ect)\\s*\\(") },
  { id: "rs-cfg-attr-lint-attribute", category: "lint", files: RS, pattern: re("", "#!?\\[\\s*cfg_attr\\s*\\([^\\]]*\\b(?:al", "low|exp", "ect)\\s*\\(") },
  { id: "rs-test-attribute", category: "test-skip", files: RS, pattern: re("", "#\\[\\s*", "ignore\\b") },

  // Go
  { id: "go-golangci-directive", category: "lint", files: GO, pattern: re("", "//\\s*", "nolint\\b") },
  { id: "go-staticcheck-directive", category: "lint", files: GO, pattern: re("", "//\\s*lint:", "(?:file-)?ignore\\b") },
  { id: "go-gosec-directive", category: "lint", files: GO, pattern: re("", "//\\s*#?", "nosec\\b") },
  { id: "go-runtime-skip", category: "test-skip", files: GO, pattern: re("", "(?:(?<![\\w.])(?:t|b|tb|f)|\\bT\\(\\))\\.Sk", "ip(?:f|Now)?\\s*\\(") },

  // JVM
  { id: "jvm-warnings-annotation", category: "lint", files: JVM, pattern: re("", "@(?:file:)?Supp", "ress\\w*") },
  { id: "jvm-sonar-directive", category: "lint", files: JVM, pattern: re("", "//\\s*NO", "SONAR\\b") },
  { id: "jvm-checkstyle-directive", category: "lint", files: JVM, pattern: re("", "CHECKSTYLE:\\s*", "OFF") },
  { id: "jvm-test-annotation", category: "test-skip", files: JVM, pattern: re("", "@(?:Ign", "ore|Disa", "bled)\\b") },

  // C#
  { id: "cs-warning-pragma", category: "lint", files: CS, pattern: re("", "#\\s*pragma\\s+warning\\s+", "disable\\b") },
  { id: "cs-analysis-attribute", category: "lint", files: CS, pattern: re("", "\\[(?:assembly:\\s*)?(?:System\\.Diagnostics\\.CodeAnalysis\\.)?Supp", "ressMessage\\b") },
  { id: "cs-resharper-directive", category: "lint", files: CS, pattern: re("", "//\\s*ReSharper\\s+", "disable\\b") },
  { id: "cs-test-attribute", category: "test-skip", files: CS, pattern: re("", "[\\[,]\\s*Ign", "ore\\b|\\[\\s*(?:Fact|Theory)\\s*\\([^\\]]*\\bSk", "ip\\s*=|\\bAssert\\.Ign", "ore\\s*\\(") },

  // C / C++ / Objective-C
  { id: "c-diagnostic-pragma", category: "lint", files: C, pattern: re("", "#\\s*pragma\\s+(?:GCC|clang)\\s+diagnostic\\s+", "ignored\\b") },
  { id: "c-msvc-warning-pragma", category: "lint", files: C, pattern: re("", "#\\s*pragma\\s+warning\\s*\\(\\s*", "disable\\b") },
  { id: "c-clang-tidy-directive", category: "lint", files: C, pattern: re("", "//\\s*NO", "LINT(?:NEXTLINE|BEGIN)?\\b") },
  { id: "c-unused-attribute", category: "dead-code", files: C, pattern: re("", "\\[\\[\\s*maybe", "_unused\\s*\\]\\]|__attribute__\\s*\\(\\(\\s*un", "used\\b|\\bQ_UN", "USED\\s*\\(") },

  // Swift
  { id: "swift-swiftlint-directive", category: "lint", files: SWIFT, pattern: re("", "//\\s*swiftlint:", "disable\\b") },

  // PHP
  { id: "php-phpstan-directive", category: "type", files: PHP, pattern: re("", "@phpstan", "-ignore") },
  { id: "php-psalm-directive", category: "type", files: PHP, pattern: re("", "@psalm", "-suppress") },
  { id: "php-phpcs-directive", category: "lint", files: PHP, pattern: re("", "phpcs:", "(?:ignore|disable)\\b|@codingStandards", "Ignore") },
  { id: "php-phpmd-annotation", category: "lint", files: PHP, pattern: re("", "@Supp", "ressWarnings\\s*\\(") },
  { id: "php-phpstorm-directive", category: "lint", files: PHP, pattern: re("", "@no", "inspection\\b") },
  { id: "php-runtime-skip", category: "test-skip", files: PHP, pattern: re("", "->markTest", "(?:Skipped|Incomplete)\\s*\\(") },
  { id: "php-coverage-annotation", category: "coverage", files: PHP, pattern: re("", "@codeCoverage", "Ignore") },

  // Ruby
  { id: "rb-rubocop-directive", category: "lint", files: RUBY, pattern: re("", "#\\s*rubocop:\\s*", "(?:disable|todo)\\b") },
  { id: "rb-x-prefixed-test", category: "test-skip", files: RUBY, pattern: re("", "(?<![\\w.])x(?:it|describe|context|specify)", "\\b") },
  { id: "rb-runtime-skip", category: "test-skip", files: RUBY, pattern: re("m", "(?<![\\w.:])(?:sk", "ip|pen", "ding)(?=\\s*(?:\\(|[\"']|$))") },
  { id: "rb-coverage-directive", category: "coverage", files: RUBY, pattern: re("", "#\\s*:no", "cov:") },

  // Elixir
  { id: "ex-test-tag", category: "test-skip", files: ELIXIR, pattern: re("", "@(?:module)?tag\\s+(?::sk", "ip\\b|sk", "ip:)") },
  { id: "ex-credo-directive", category: "lint", files: ELIXIR, pattern: re("", "#\\s*credo:", "disable") },
  { id: "ex-dialyzer-attribute", category: "type", files: ELIXIR, pattern: re("", "@dialyzer\\s+\\{?\\s*:?no", "warn") },
  { id: "ex-unused-compile-attribute", category: "dead-code", files: ELIXIR, pattern: re("", "@compile\\s+\\{?\\s*:no", "warn_unused") },

  // Shell and CSS
  { id: "sh-shellcheck-directive", category: "lint", files: SHELL, pattern: re("", "#\\s*shellcheck\\s+", "disable\\b") },
  { id: "css-stylelint-directive", category: "lint", files: CSS, pattern: re("", "stylelint", "-disable") },

  // Config files: a check relaxed or narrowed where it is configured rather than inline.
  { id: "tsconfig-unused-checks-off", category: "dead-code", files: TSCONFIG, pattern: re("", '"(?:noUnused', 'Locals|noUnused', 'Parameters)"\\s*:\\s*false') },
  {
    id: "tsconfig-strictness-off",
    category: "type",
    files: TSCONFIG,
    pattern: re(
      "",
      '"(?:strict|strictNullChecks|strictFunctionTypes|strictBindCallApply|strictPropertyInitialization|',
      "noImplicitAny|noImplicitThis|noImplicitReturns|noImplicitOverride|noFallthroughCasesInSwitch|",
      'noUncheckedIndexedAccess|useUnknownInCatchVariables|alwaysStrict)"\\s*:\\s*false',
    ),
  },
  {
    id: "eslint-config-rule-relaxed",
    category: "lint",
    files: { names: /^(?:\.eslintrc(?:\.\w+)?|eslint\.config\.\w+)$/ },
    pattern: re("", ":\\s*\\[?\\s*(?:[\"'](?:of", "f|wa", "rn)[\"']|[01](?=\\s*[,}\\]]))"),
  },
  {
    id: "python-config-lint-ignore",
    category: "lint",
    files: { names: /^(?:pyproject\.toml|setup\.cfg|tox\.ini|\.flake8|\.?ruff\.toml|\.pylintrc|pylintrc)$/ },
    pattern: re("m", "^\\s*(?:extend-)?(?:per-file-)?ign", "ores?\\s*=|^\\s*dis", "able\\s*="),
  },
  {
    id: "python-config-type-ignore",
    category: "type",
    files: { names: /^(?:pyproject\.toml|setup\.cfg|mypy\.ini|\.mypy\.ini)$/ },
    pattern: re("m", "ignore_", "errors\\s*=\\s*[Tt]rue|^\\s*disable_error_", "code\\s*="),
  },
  {
    id: "pytest-config-deselect",
    category: "test-skip",
    files: { names: /^(?:pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini)$/ },
    pattern: re("", "--de", "select\\b|--ig", "nore(?:-glob)?[=\\s]"),
  },
  {
    id: "python-coverage-config-exclude",
    category: "coverage",
    files: { names: /^(?:pyproject\.toml|setup\.cfg|tox\.ini|\.coveragerc)$/ },
    pattern: re("m", "^\\s*(?:exclude_lines|exclude_also|om", "it)\\s*="),
  },
  {
    id: "cargo-lint-level-lowered",
    category: "lint",
    files: { names: /^Cargo\.toml$/ },
    pattern: re("", "=\\s*(?:[\"']al", "low[\"']|\\{[^}\\n]*level\\s*=\\s*[\"']al", "low[\"'])"),
  },
  {
    id: "cargo-config-lint-flags",
    category: "lint",
    files: { path: /(?:^|\/)\.cargo\/config(?:\.toml)?$/ },
    pattern: re("", "[\"']-A[\"']|-A\\s*(?:dead_code|unused|warnings|clippy)|--cap", "-lints"),
  },
  {
    id: "phpstan-config-ignored-errors",
    category: "type",
    files: { names: /^phpstan(?:\.dist)?\.neon(?:\.dist)?$/ },
    pattern: re("", "\\bignore", "Errors\\s*:|reportUnmatchedIgnored", "Errors\\s*:\\s*false"),
  },
  {
    id: "psalm-config-error-level",
    category: "type",
    files: { names: /^psalm\.xml(?:\.dist)?$/ },
    pattern: re("", "errorLevel\\s*=\\s*[\"'](?:supp", "ress|info)[\"']"),
  },
  {
    id: "golangci-config-linters-off",
    category: "lint",
    files: { names: /^\.golangci\.(?:ya?ml|toml|json)$/ },
    pattern: re("m", "\\bexclude-", "rules\\b|\\bdisable-", "all\\s*:\\s*true|^\\s*dis", "able\\s*:|\\bexclu", "sions\\s*:"),
  },
  { id: "phpunit-config-excluded-tests", category: "test-skip", files: { names: /^phpunit\.xml(?:\.dist)?$/ }, pattern: re("", "<exc", "lude>") },
  { id: "js-test-config-excluded-tests", category: "test-skip", files: JS_TEST_CONFIG, pattern: re("", "testPathIgnore", "Patterns|passWithNo", "Tests\\s*:\\s*true") },
  { id: "js-test-config-coverage-excluded", category: "coverage", files: JS_TEST_CONFIG, pattern: re("", "coveragePathIgnore", "Patterns") },
  {
    id: "rubocop-config-cops-off",
    category: "lint",
    files: { names: /^\.rubocop(?:_todo)?\.ya?ml$/ },
    pattern: re("m", "^\\s*Enabled\\s*:\\s*fal", "se|^\\s*Exc", "lude\\s*:"),
  },
  { id: "swiftlint-config-rules-off", category: "lint", files: { names: /^\.swiftlint\.ya?ml$/ }, pattern: re("m", "^\\s*disabled_", "rules\\s*:") },
  {
    id: "github-actions-step-may-fail",
    category: "ci",
    files: { path: /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/ },
    pattern: re("", "continue-on-", "error\\s*:\\s*true"),
  },
  { id: "git-hooks-bypassed", category: "hook-bypass", files: ANY_CODE, pattern: re("", "--no", "-verify\\b|\\bHUSKY\\s*=\\s*0\\b|\\bLEFTHOOK\\s*=\\s*0\\b") },
];

export const isProse = (path) => PROSE.some((ext) => path.toLowerCase().endsWith(ext));

function fileMatches(files, path) {
  const posix = path.replace(/\\/g, "/");
  const base = posix.slice(posix.lastIndexOf("/") + 1);
  if (files.any) return !isProse(posix);
  if (files.ext) return files.ext.some((ext) => posix.toLowerCase().endsWith(ext));
  if (files.names) return files.names.test(base);
  if (files.path) return files.path.test(posix);
  throw new Error(`suppression rule has no file matcher: ${JSON.stringify(files)}`);
}

/** Rules that apply to `path`, minus disabled categories. */
export function rulesForPath(path, disabledCategories = []) {
  return RULES.filter((rule) => !disabledCategories.includes(rule.category) && fileMatches(rule.files, path));
}

/**
 * Rules for inline code in any language: used when a notebook cell's language cannot be
 * determined, so the cell is checked against everything rather than against nothing.
 */
export function inlineCodeRules(disabledCategories = []) {
  return RULES.filter((rule) => !disabledCategories.includes(rule.category) && (rule.files.ext || rule.files.any));
}

const countOf = (pattern, text) => {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  return (text.match(global) ?? []).length;
};

/**
 * Rules whose match count went up between `before` and `after`. Counting per rule, rather than
 * asking "was any directive already present", means adding a second, different directive next to
 * an existing one is still caught.
 */
export function introduced(rules, pairs) {
  const hits = [];
  for (const rule of rules) {
    for (const { before, after } of pairs) {
      if (countOf(rule.pattern, after) > countOf(rule.pattern, before)) {
        const line = after.split("\n").find((l) => rule.pattern.test(l)) ?? "";
        hits.push({ rule, line: line.trim() });
        break;
      }
    }
  }
  return hits;
}
