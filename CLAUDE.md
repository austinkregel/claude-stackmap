# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`stackmap` is a Claude Code **plugin** (not a library or app). It ships four surfaces from one
repo, each with a different runtime and different failure semantics:

| Surface | Entry point | Runs from | Needs a build? |
|---|---|---|---|
| MCP server (`stackmap_*`, `note_*` tools) | `scripts/launch.sh` → `dist/index.js` | compiled TS | **yes** |
| Hooks (guards, house rules, freshness, fetch sanity, skill and audit checks) | `hooks/hooks.json` → `scripts/*.sh` → `scripts/*.mjs` | plain `.mjs`, never `dist/` | no |
| `sm` CLI | `bin/sm` → `scripts/cli/main.mjs` | plain `.mjs` | no |
| Skills | `skills/*/SKILL.md` | markdown | no |
| Agents | `agents/*.md` (auto-discovered; no `agents` key in `plugin.json`) | markdown | no |

Every guard rule is narrow enough not to fire on ordinary work, with a test for the safe lookalike
it must not catch. Every blind spot is reported as a count or a caveat.

## Commands

```bash
npm install
npm run build          # tsc -> dist/  (required before the MCP server, extract-test, notes-test, smoke)
npm run check          # typecheck only
npm run watch          # tsc --watch
npm test               # every suite below, in order
npm run bench          # note retrieval latency + rank quality
```

Run a single suite directly — they are standalone scripts, and there is no test-name filter:

```bash
node scripts/shell-tokens-test.mjs  # shell parser the Bash guards evaluate (no build needed)
node scripts/guard-test.mjs         # destructive commands, commit messages, guard.sh fail-closed paths
node scripts/truncate-test.mjs      # no-truncate
node scripts/suppress-test.mjs      # no-suppress + suppression catalog integrity
node scripts/house-rules-test.mjs   # house rules: extend/replace/disable and every failure path
node scripts/hooks-test.mjs         # hook-open.sh, freshness, fetch sanity, config.example.json
node scripts/skill-check-test.mjs   # /review and /double-blind closing blocks, arming, loop safety
node scripts/audit-test.mjs         # the adversarial auditor's report check
node scripts/extract-test.mjs       # PHP extractors + adapter wiring, inline fixtures  (needs dist/)
node scripts/notes-test.mjs         # note store: supersession, retraction weighting, drift  (needs dist/)
node scripts/smoke.mjs              # boots dist/index.js over stdio, exercises every tool + error paths
```

The hook suites set `$STACKMAP_CONFIG` and `$STACKMAP_STATE` to temp paths; keep it that way in any
new hook test.

Each suite prints `PASS`/`FAIL` per check and exits non-zero if any failed; add a `check(...)` call
to extend one. `smoke` asserts against your real config, so it needs at least one working index.

After `npm run build`, run `/reload-plugins` in Claude Code to pick up the new `dist/`.

## Config lives outside the repo

Resolution order, first hit wins: `$STACKMAP_CONFIG`, `$XDG_CONFIG_HOME/stackmap/config.json`,
`~/.config/stackmap/config.json`. Copy `config.example.json` there; see the README for fields.
Adding a repo is a config edit as long as its stack has an adapter.

Notes live under `notesDir` (default `~/.config/stackmap/notes/`, one markdown file per note).
Per-session hook state (`sessions/<id>.review.json`) lives in `~/.stackmap/`, or under
`$STACKMAP_STATE` (must be absolute). `stateDir()` in `scripts/hook-lib.mjs` is the only place that
path is resolved.

## Architecture invariants

### Node resolution

`scripts/find-node.sh` is sourced by `bin/sm`, `launch.sh`, `guard.sh`, and `hook-open.sh`. Never
replace these wrappers with a bare `node` command in `.mcp.json` or `hooks.json`.

### Two-tier hook failure semantics — do not mix them

Both wrappers accept only `[a-z0-9-]+.mjs` script names.

- `scripts/guard.sh <script>` → **fails closed** (exit 2). Wraps `guard.mjs`, `no-truncate.mjs`,
  `no-suppress.mjs`. Any failure to evaluate a call blocks it; the suites assert those paths.
- `scripts/hook-open.sh <script>` → **fails open, visibly** (exit 1 with a `systemMessage`). Wraps
  `freshness.mjs`, `house-rules.mjs`, `fetch-sanity.mjs`, `skill-arm.mjs`, `skill-check.mjs`,
  `audit-check.mjs`.

`scripts/hook-lib.mjs` owns the wire protocol. Its helpers set `process.exitCode` and return; never
call `process.exit()` after writing a decision. Stop blocks use top-level `{ "decision": "block", "reason" }`.

`scripts/hook-config.mjs` is the only owner of the `guard` and `houseRules` sections (src/config.ts
does not model them). Keep it dependency-free and never import `dist/` from a hook. It validates
strictly: an unknown key is an error.

Every entry in `hooks.json` sets a short explicit `timeout`; keep guard work bounded.

### Guards evaluate parsed commands, never raw text

`scripts/shell-tokens.mjs` parses commands the way the shell does; guards walk its stages with
`walkStages`. Never add a guard rule that regex-matches the raw command. Syntax the shell would
reject throws `ShellParseError`, which guards turn into a block.

### Guard rules stay narrow

Each allowance has a test:

- `git merge` blocks, `git merge-base` does not.
- `--force` / `-f` block, `--force-with-lease` does not.
- `rm -rf` is not blocked.
- `cmd | tee f | tail` passes; `cmd | tail | tee f` and `cmd | sort | tee f | tail` block.
- Suppression patterns are scoped by file type in `scripts/suppression-rules.mjs`, so an iterator's
  `skip(n)` in Rust or Java is not a skipped test.

Branch detection tries `symbolic-ref --short HEAD` before `rev-parse --abbrev-ref HEAD` (the latter
prints `HEAD` on an unborn branch). A value only known at runtime fails closed only where a rule
needs it.

### The suppression catalog stays free of literal directives

Patterns in `suppression-rules.mjs` are assembled from fragments with `re(...)`, rule ids avoid
directive text, and test fixtures use `F(...)`. `suppress-test.mjs` asserts that the catalog, the
guard, and the suite match none of their own rules. `no-suppress` blocks only when a rule's match
count rises; for `Write`, "before" is the file on disk.

### House rules never inject a partial set

`house-rules.mjs` runs on SessionStart and SubagentStart. `houseRules.mode` is `extend` (shipped
`house-rules/default.md` minus `disable` ids, then `files`) or `replace` (`files` only). Every `## `
section in the default needs a `<!-- id: … -->` line under its heading; those ids are public names,
so don't rename them. A missing/empty file, unknown id, or a total over the 10,000-character hook
output limit injects nothing and reports why. The enforcement list at the end is generated from the
`guard` config; keep it generated.

An `<!-- enforced-by: name -->` line directly above a `## ` heading or `- ` bullet in the default
leaves that text out while the named guard (`guard`, `noTruncate`, `commitMessage`, `noSuppress`, or
`noSuppress:<category>`) is enabled. Tag only text the guard's block message fully covers. An
unknown name or a misplaced tag injects nothing. `houseRules.subagents: false` skips SubagentStart.

### Closing blocks are checked by hooks, defined in one place

`scripts/deliverables.mjs` owns every closing block (review, double-blind, audit report), the
checks that name what a message is missing, and `ENFORCED_SKILLS`. The skill text and the check
must change together. Hooks import it; no hook imports another hook.

- `skill-arm.mjs` (UserPromptSubmit) writes `sessions/<id>.<skill>.json` only when the prompt
  literally invokes a skill in `ENFORCED_SKILLS`. `skill-check.mjs` (Stop) blocks until the final
  message satisfies every armed skill, clearing each marker as it is satisfied. Markers older than
  6 hours or corrupt are cleared.
- `audit-check.mjs` (SubagentStop, matcher `^stackmap:adversarial-auditor$`) blocks the auditor
  until its report is complete. FALSIFIED and SURVIVED require PROVEN. Called for any other agent
  type, it reports an error rather than passing.
- On `stop_hook_active` neither blocks again: the turn or agent ends and a `systemMessage` names
  what is still missing.

### Agents audit `main` unless a ref is named

Claude Code starts an `isolation: worktree` agent at the remote's default branch (e.g.
`origin/main`), not local `main` or the current branch. Agents therefore check out explicitly: the
ref the brief names, or `main`, and report `<ref>@<sha>`. When no ref is named and the current
branch isn't `main`, the skills ask before dispatching. Don't make a skill or agent silently switch
to the current branch.

### Three kinds of edge, never conflated

| kind | Source | `via` |
|---|---|---|
| `container` | `$this->app->bind/singleton/scoped/instance` | `container:bind`, … |
| `contextual` | `when(X)->needs(Y)->give(Z)` | `container:when-needs-give` |
| `declaration` | PHP `extends` / `implements` | `php:implements`, `php:extends` |

`resolveSymbol` keeps them in six separate fields (`implementedBy`/`implements`,
`subtypes`/`supertypes`, `injections`/`injectedInto`); never merge them. `resolutionTable()`
defaults to container + contextual; declaration edges come only when asked for.

### `caveats` keeps an empty result from reading as a negative

`SymbolHit.caveats` reports runtime-computed binding sites (with file:line), calls skipped for a
non-container receiver, and which directories were scanned. Any code path that cannot extract
something adds a caveat or a `stats()` counter (`computedAbstractSites`,
`skippedNonContainerCalls`, `closureBindings`) — never `continue` silently.

### PHP extraction: receiver whitelist, and what may be inferred

`CONTAINER_RECEIVER_RE` in [src/php/bindings.ts](src/php/bindings.ts) whitelists receivers
(`$this->app`, `$app`, `$container`, `$this->container`, `app()`, `App::`,
`Container::getInstance()`), read backwards over a 96-char window:

- container receiver → an edge;
- some other receiver (`Route::bind`, `$query->when`) → a `SkippedCall`, counted and surfaced;
- no receiver at all (a method declaration, a bare call) → ignored.

A computed abstract is emitted with the source text and `computedAbstract: true`, never dropped.
The only inference allowed is expanding a `foreach` over a class-const array declared in the same
file, with `inferredFrom` set. Do not extend it to properties, method returns, merged arrays, or
other files.

Declarations are parsed from every file matching `DECL_HINT`. `DECL_RE` is line-anchored so
`Foo::class`, `self::class`, and docblock prose can't match.

### Stack adapters: the seam for new languages

`src/adapters/types.ts` defines `StackAdapter` (`resolveSymbol`, `resolutionTable`, `stats`) and
`AdapterFactory`. To add a stack, implement the interface and register the factory in `FACTORIES`
in `src/adapters/registry.ts`, moving it out of `PLANNED`. Nothing in `config.ts`, `index.ts`, or
the tool surface is PHP-specific — keep it that way.

Laravel is the only implemented adapter. Edges are built in one pass and memoized per adapter
instance; `clearAdapterCache()` (called by `stackmap_indexes`) clears them.

Report unknowns as unknown: a closure binding yields `concrete: null` plus a `note`; a PSR-4 path
that isn't on disk yields `exists: false` with the candidate path.

### Note store: provenance and caching invariants

`src/notes/store.ts` serializes notes as markdown with hand-rolled frontmatter; change `serialize`
and `deserialize` in lockstep. A malformed note is skipped. `note_write` content-hashes every file
the note is about; `drift()` re-hashes at read time.

`src/notes/search.ts` is Okapi BM25 (k1 1.2, b 0.75) with a 3x title/tag boost over an inverted
index. Cache invalidation keys:

| Cache | Keyed / invalidated by |
|---|---|
| file hashes (`hashCache`) | `mtimeMs:size` |
| parsed notes (`NoteStore.cache`) | `mtimeMs:size` per file |
| directory listing (`listCache`) | `fs.watch` dirty flag **plus** a 2s wall-clock backstop |
| tokenized docs (`docCache`) | `WeakMap` on `Note` object identity |

The watcher is never the correctness boundary; keep the backstop. `store.write()` sets `dirty`
itself. `scan()` must replace the `Note` object whenever its file changes, or `docCache` goes stale.

Notes are stamped relative to the repo root of the index `selectIndex` picks for the call: the
`repo` argument, else `defaultIndex`, else the only enabled index.

### `sm` CLI: verified counts, not silent drops

Every command reports read / matched / skipped / error counts; `sm slice` prints totals and exits 3
on a short read. When adding a subcommand, register it in `COMMANDS` and `USAGE` in
`scripts/cli/main.mjs`, share flag parsing via `scripts/cli/args.mjs`, and support `--json`.
