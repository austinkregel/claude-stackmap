# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`stackmap` is a Claude Code **plugin** (not a library or app). It ships four surfaces from one
repo, each with a different runtime and different failure semantics:

| Surface | Entry point | Runs from | Needs a build? |
|---|---|---|---|
| MCP server (`stackmap_*`, `note_*` tools) | `scripts/launch.sh` → `dist/index.js` | compiled TS | **yes** |
| Hooks (guard, freshness, fetch sanity, review arm/check) | `hooks/hooks.json` → `scripts/*.sh` → `scripts/*.mjs` | plain `.mjs`, never `dist/` | no |
| `sm` CLI | `bin/sm` → `scripts/cli/main.mjs` | plain `.mjs` | no |
| Skills | `skills/*/SKILL.md` | markdown | no |

The guiding constraint is precision: every rule is narrow enough not to fire on ordinary work,
and every blind spot is reported as a count or a caveat rather than left silent. When adding or
changing behaviour, state the reasoning in the code and add a regression test for the safe
lookalike the rule must not catch.

## Commands

```bash
npm install
npm run build          # tsc -> dist/  (required before the MCP server or note tests will run)
npm run check          # typecheck only
npm run watch          # tsc --watch
npm test               # guard, extractors, notes, review, smoke  (116 checks)
npm run bench          # note retrieval latency + rank quality at 101/1001/5001 notes
```

Run a single suite directly — they are standalone scripts, and there is no test-name filter:

```bash
node scripts/guard-test.mjs    # PreToolUse guard, incl. fail-closed paths (no build needed)
node scripts/extract-test.mjs  # PHP extractors + adapter wiring, inline fixtures  (needs dist/)
node scripts/notes-test.mjs    # note store: supersession, retraction weighting, drift  (needs dist/)
node scripts/review-test.mjs   # review arm/check enforcement
node scripts/smoke.mjs         # boots dist/index.js over stdio, exercises every tool + error paths
```

Each suite prints `PASS`/`FAIL` per check and exits non-zero if any failed; add a `check(...)` call
to extend one. `notes-test` and `smoke` import from `dist/`, so **build first** or you test stale
code. `smoke` asserts against your real config, so it needs at least one working index.

After `npm run build`, run `/reload-plugins` in Claude Code to pick up the new `dist/`.

## Config lives outside the repo

Resolution order, first hit wins: `$STACKMAP_CONFIG`, `$XDG_CONFIG_HOME/stackmap/config.json`,
`~/.config/stackmap/config.json`. Copy `config.example.json` there; see the README table for
fields. Adding a repo to query is a config edit, never a code change, as long as its stack has an
adapter. Set `STACKMAP_CONFIG` to a temp file to test config-dependent behaviour in isolation.

Runtime state also lives under `~/.config/stackmap/`: `notes/` (one markdown file per note,
git-friendly) and `sessions/<id>.review.json` (review-arm markers).

## Architecture

### Node resolution is a shared, deliberate concern

`scripts/find-node.sh` is sourced by `bin/sm`, `launch.sh`, `guard.sh`, and `hook-open.sh`. VS Code
launched from the Dock inherits a minimal `PATH` without version-manager shims, and a shim is
itself a script that fails to exec when its manager is off `PATH` — so every candidate is verified
by actually running `--version`, and real installs are preferred over shims. Never replace these
wrappers with a bare `node` command in `.mcp.json` or `hooks.json`.

### Two-tier hook failure semantics — do not mix them

Claude Code hooks fail **open** by default; exit code 2 is the only code that blocks
unconditionally.

- `scripts/guard.sh` → **fails closed.** Unreadable stdin, malformed JSON, missing script, no
  node, evaluation error — all exit 2. A guardrail that cannot evaluate must not wave calls
  through. `guard-test.mjs` asserts these paths, not just the happy ones.
- `scripts/hook-open.sh` → **fails open.** Wraps the informational hooks (`freshness.mjs`,
  `fetch-sanity.mjs`, `review-arm.mjs`, `review-check.mjs`); a missing node or parse error exits 0
  silently rather than blocking a session or a tool result.

`scripts/guard.mjs` parses its own config instead of importing from `dist/`, on purpose: a broken
TypeScript build must not be able to disable the safety layer. Keep it dependency-free.

### Precision over breadth is the governing rule for guard rules

A guardrail that fires on ordinary work gets switched off, so rules are narrow and each has a
regression test for its read-only lookalike:

- `git merge` blocks, `git merge-base` does not — the latter is read-only and far more common.
- `--force` / `-f` block, `--force-with-lease` does not.
- `rm -rf` is deliberately **not** blocked: it is overwhelmingly aimed at scratch directories.

`guard.mjs` splits a command on `\n && || ; |` and evaluates each segment separately, so compound
commands can't smuggle a blocked verb past a prefix match. Branch detection tries
`symbolic-ref --short HEAD` before `rev-parse --abbrev-ref HEAD`, because the latter prints
`HEAD` on an unborn branch and would silently disable the protected-branch rules exactly where
they matter.

### Review enforcement is a two-hook state machine

`review-arm.mjs` (UserPromptSubmit) writes a session marker **only** when the prompt literally
invokes `/review` or `/stackmap:review` — arming on explicit invocation rather than guessing from
output is what keeps it from misfiring. `review-check.mjs` (Stop) blocks the turn unless the final
message matches `/reviewed at <sha>/i`, then clears the marker. It also bails out on
`stop_hook_active` (another Stop hook already blocked) and on markers older than 6 hours.

### Three kinds of edge, never conflated

`ResolutionEdge.kind` distinguishes evidence that answers different questions, and mixing them is
how the tool overclaimed before:

| kind | Source | `via` |
|---|---|---|
| `container` | `$this->app->bind/singleton/scoped/instance` | `container:bind`, … |
| `contextual` | `when(X)->needs(Y)->give(Z)` | `container:when-needs-give` |
| `declaration` | PHP `extends` / `implements` | `php:implements`, `php:extends` |

`resolveSymbol` keeps them in six separate fields (`implementedBy`/`implements`,
`subtypes`/`supertypes`, `injections`/`injectedInto`). Never merge them into one list: a container
binding says what the container hands you, a declaration says what the language guarantees, and a
contextual binding applies only while resolving one class. `resolutionTable()` defaults to
container + contextual; declaration edges (2,512 of them in one large Laravel codebase, against
322 bindings) come only when asked for, so they can't swamp the binding table.

### `caveats` is what keeps an empty result from reading as a negative

The worst defect this codebase has had: a `foreach` over a 14-entry class const bound 14 filter
singletons through a computed key, the extractor dropped the whole site with no note, and
`resolve()` answered `implementedBy: []` — indistinguishable from "nothing binds this". Empty
edge lists are unavoidable; *unqualified* empty edge lists are the bug.

So `SymbolHit.caveats` reports runtime-computed binding sites (with file:line), calls skipped for
a non-container receiver, and which directories were scanned. When adding any code path that
cannot extract something, add a caveat or a counter with it — never `continue` silently. The same
rule drives `stats()`: `computedAbstractSites`, `skippedNonContainerCalls`, and
`closureBindings` all exist so a blind spot shows up as a number instead of as a wrong answer.

### PHP extraction: receiver whitelist, and what may be inferred

`bind`/`singleton`/`scoped`/`instance`/`when` are ordinary method names, so the *receiver*
decides whether a call is a container binding. `CONTAINER_RECEIVER_RE` in
[src/php/bindings.ts](src/php/bindings.ts) is a whitelist (`$this->app`, `$app`, `$container`,
`$this->container`, `app()`, `App::`, `Container::getInstance()`), read backwards over a 96-char
window so multi-line `$this->app
->when(...)` chains still match. Three outcomes, all deliberate:

- container receiver → an edge;
- some other receiver (`Route::bind`, `$query->when`) → a `SkippedCall`, counted and surfaced;
- no receiver at all (a `public function bind()` declaration, a bare call) → ignored entirely.

A computed abstract is emitted with the source text and `computedAbstract: true`, never dropped.
The one inference allowed is expanding a `foreach` over a class-const array **declared in the same
file** — literal static data, with the loop key substituted into the abstract expression and
`inferredFrom` set. Do not extend this to properties, method returns, merged arrays, or other
files: that is interpretation, and the tool's value is that it doesn't guess.

Declarations are parsed from every file with a type declaration (`DECL_HINT`), not just the 26
with bindings. That reads all 2,770 files instead of 26 and cost ~15 ms on top of a ~320 ms walk —
`walkFiles` had already stat'd them, so the pages were warm. `DECL_RE` is line-anchored so
`Foo::class`, `self::class`, and docblock prose can't match.

### Stack adapters: the seam for new languages

`src/adapters/types.ts` defines `StackAdapter` (`resolveSymbol`, `resolutionTable`, `stats`) and
`AdapterFactory`. To add a stack: implement the interface and register the factory in
`FACTORIES` in `src/adapters/registry.ts` (move it out of `PLANNED`, which exists so an
unimplemented-but-detected stack produces a useful error instead of "no stack found"). Nothing in
`config.ts`, `index.ts`, or the tool surface is PHP-specific — keep it that way.

Laravel is the only implemented adapter. It reads PSR-4 from `composer.json`
(`src/php/psr4.ts`), walks `include` dirs, then parses container calls paren/quote-aware rather
than line-by-line (`src/php/bindings.ts`) and type declarations (`src/php/declarations.ts`). All
edges are built in one pass and memoized per adapter instance; the cache is per-process, cleared
by `clearAdapterCache()` (called by `stackmap_indexes`).

**Report unknowns as unknown.** A closure binding yields `concrete: null` plus a `note` telling
the caller to read the provider; a PSR-4 path that isn't on disk yields `exists: false` with the
candidate path. Never synthesize a plausible answer — that honesty is the tool's whole value over
the agent guessing.

### Note store: provenance and caching invariants

`src/notes/store.ts` serializes notes as markdown with hand-rolled frontmatter (no YAML
dependency) — if you change `serialize`, change `deserialize` in lockstep, and note that a
malformed note is skipped so it can't break retrieval of the rest. `note_write` content-hashes
every file the conclusion is about; `drift()` re-hashes at read time so a search can say whether
the ground moved.

`src/notes/search.ts` is Okapi BM25 (k1 1.2, b 0.75) with a 3x title/tag boost and an inverted
index. Three caches with distinct invalidation keys — get these wrong and the perf claims in the
README stop holding:

| Cache | Keyed / invalidated by |
|---|---|
| file hashes (`hashCache`) | `mtimeMs:size` |
| parsed notes (`NoteStore.cache`) | `mtimeMs:size` per file |
| directory listing (`listCache`) | `fs.watch` dirty flag **plus** a 2s wall-clock backstop |
| tokenized docs (`docCache`) | `WeakMap` on `Note` object identity |

The watcher is an optimization, never the correctness boundary — `fs.watch` can miss events, hence
the backstop. `store.write()` sets `dirty` itself rather than waiting for the watcher to observe
our own write. Doc memoization by `Note` identity is sound only because `scan()` replaces the
`Note` object whenever its file changes; preserve that.

Notes are stamped relative to the default index's repo root, so relative paths in a note resolve
identically on every later read.

### `sm` CLI: verified counts, not silent drops

`scripts/cli/` exists so that ad-hoc data one-liners stop being retyped per session, and stop
dropping rows silently when a filter misses. Every command reports read / matched / skipped /
error counts, `sm slice` always prints totals alongside what it emitted (and exits 3 on
a short read), and `sm wait` polls in one agent turn instead of N. Keep that contract when adding
a subcommand: register it in `COMMANDS` and `USAGE` in `scripts/cli/main.mjs`, share flag parsing
via `scripts/cli/args.mjs`, and support `--json`.

## Installation notes

The working directory is not a git repository, and `dist/` is gitignored but is what the plugin
actually loads. The plugin is installed in place via symlink so the source can stay in `~/src`:

```bash
ln -sfn ~/src/stackmap ~/.claude/skills/stackmap   # loads as stackmap@skills-dir
```

Then `{ "enabledPlugins": { "stackmap@skills-dir": true } }` in `~/.claude/settings.json`. Check
`/plugin` → Errors tab when the MCP server appears to return nothing; `launch.sh` exits with a
message on stderr rather than exiting silently, precisely so failures land there.

A few literal command forms are also duplicated into `~/.claude/settings.json` under
`permissions.deny` as a second layer — deny rules are evaluated before hooks and still apply if
the plugin is disabled. The hook remains the primary mechanism, since a prefix rule can't
distinguish `git merge` from `git merge-base`.
