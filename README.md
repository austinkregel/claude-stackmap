# stackmap

A Claude Code plugin in four parts.

| Component | What it does |
|---|---|
| `stackmap_*` MCP tools | Deterministic code-structure lookups — resolve an interface to its implementation and file without reading service providers |
| `note_*` MCP tools + `recall` skill | A durable cross-session note store with provenance stamping, so a conclusion outlives the session that reached it |
| Hooks | A `PreToolUse` action guard, `SessionStart` repo-freshness context, `PostToolUse` fetch sanity, and `Stop` review enforcement |
| `sm` CLI | Reusable data commands (`jsonl`, `csv`, `slice`, `wait`, `dupes`) that report their own counts instead of dropping rows quietly |

Run `npm test` for the full suite: **116 checks** across the action guard, the PHP extractors,
the note store, review enforcement, and the MCP server. `npm run bench` measures retrieval at
scale.

### Retrieval performance (measured, not asserted)

Okapi BM25 with IDF and length normalization over an inverted index, with parsed notes and file
hashes cached and invalidated by mtime, and the directory listing invalidated by an `fs.watch`
watcher plus a 2s backstop.

| Notes in store | Cold search | Warm search | Correct note ranked #1 |
|---|---|---|---|
| 101 notes | 18 ms | 0.2 ms | yes |
| 1,001 notes | 132 ms | 0.3 ms | yes |
| 5,001 notes | 590 ms | 0.5 ms | yes |

Profiling drove those numbers: at 5k notes, 95 of the original 99 ms was `statSync` on every
note file, not scoring. The watcher removed it. `npm run bench` re-checks both latency and rank
quality, so a regression fails the suite rather than going unnoticed.

## Status

| Stack | Detection | Resolution table | State |
|---|---|---|---|
| Laravel / PHP | `artisan` | container `bind`/`singleton`/`scoped`/`instance`, contextual `when`/`needs`/`give`, PHP `extends`/`implements` | **implemented** |
| Phoenix / Elixir | `mix.exs` | behaviours + app config + supervision trees | detected, not implemented |
| Node / TS | `package.json` | — | detected, not implemented |

Measured against a large production Laravel codebase, 2,770 PHP files in ~335 ms:

| | Count |
|---|---|
| Container bindings | 322 |
| — of them bound to a closure (concrete unresolvable, reported as such) | 99 |
| — of them recovered by expanding a `foreach` over a class const | 14 |
| Contextual bindings (`when`/`needs`/`give`) | 56 |
| Declaration edges (`extends` / `implements`) | 2,512 |
| Distinct statically-named abstracts | 307 |
| Calls named like a binding but skipped — receiver is not the container | 3 |

Those last two rows are the point. Three `Route::bind('report', …)` calls used to land in the
table as container bindings with abstracts `report`, `insight`, and `deletedClient`; they are now
excluded by a receiver check and *counted*, because a silent skip is how that stayed invisible.

## Install

```bash
cd ~/src/stackmap
npm install
npm run build
```

### In VS Code (Claude Code extension)

The `--plugin-dir` flag is CLI-only. In the extension, install it as a **skills-directory
plugin**: any folder under `~/.claude/skills/` containing `.claude-plugin/plugin.json`
auto-loads as `<name>@skills-dir` with no marketplace and no install step. It loads *in place*,
so the code can stay in `~/src` behind a symlink:

```bash
mkdir -p ~/.claude/skills
ln -sfn ~/src/stackmap ~/.claude/skills/stackmap
```

Then enable it in `~/.claude/settings.json`:

```json
{ "enabledPlugins": { "stackmap@skills-dir": true } }
```

Start a new session, or run `/reload-plugins` in an existing one. Personal scope needs no
workspace-trust acceptance and its MCP server loads without per-server approval. Verify with
`/plugin` — a server that failed to start is listed in the **Errors** tab.

After a `npm run build`, run `/reload-plugins` to pick up the new `dist/`.

### In the CLI

```bash
claude --plugin-dir ~/src/stackmap
```

### Why the launcher script

`.mcp.json` points at `scripts/launch.sh` rather than `node` directly. VS Code launched from the
Dock inherits a minimal `PATH` that excludes version-manager shims, so a bare `node` command does
not resolve — and an asdf/mise *shim* is itself a shell script that fails to exec when its manager
is off `PATH`. The launcher verifies each candidate by running it, prefers real installed binaries
over shims, and exits with a message on stderr if none work, so a broken setup shows up in the
`/plugin` Errors tab instead of looking like an empty result.

## Configuration

Config lives in your home directory, not in this repo. Resolution order, first hit wins:

1. `$STACKMAP_CONFIG`
2. `$XDG_CONFIG_HOME/stackmap/config.json`
3. `~/.config/stackmap/config.json`

Copy `config.example.json` to `~/.config/stackmap/config.json` and edit.

```json
{
  "defaultIndex": "fuel",
  "indexes": [
    {
      "name": "fuel",
      "root": "~/src/my-app",
      "adapter": "laravel",
      "include": ["app"]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Handle passed as `index` in tool calls. |
| `root` | Repo root. `~` is expanded. |
| `adapter` | `auto` (detect from marker files), `laravel`, `phoenix`, `node`. Default `auto`. |
| `include` | Directories scanned. Adapter default for Laravel is `["app"]`. |
| `exclude` | Extra directory names to skip, merged with `globalExclude` and adapter defaults. |
| `options` | Per-adapter settings. Laravel accepts `bindingPaths` as an alias for `include`. |
| `enabled` | Set `false` to keep an entry without loading it. |
| `defaultIndex` | Index used when a tool call omits `index`. Required once you configure more than one. |
| `globalExclude` | Directory names skipped in every index. |

Adding a repo is a config edit — no code change — as long as its stack has an adapter.

## Tools

### `stackmap_indexes`
Lists configured indexes with detected stack and structure counts. Reports per-index errors
(missing root, unimplemented adapter) without failing the whole call. Start here when unsure.

### `stackmap_resolve`
`{ symbol, index? }` → the symbol's file plus every edge, in **six separate fields**, because
these are different kinds of evidence and conflating them is how a tool starts overclaiming:

| Field | Source | Answers |
|---|---|---|
| `implementedBy` | container bindings, abstract side | what the container hands you for this abstract |
| `implements` | container bindings, concrete side | what this class is registered as |
| `subtypes` | PHP `extends`/`implements` | what actually implements this interface |
| `supertypes` | PHP `extends`/`implements` | what this class extends/implements |
| `injections` | `when(X)->needs(…)->give(…)` | what gets injected into X |
| `injectedInto` | same, other side | where this type/parameter is injected |

Plus `caveats`: runtime-computed binding sites, skipped lookalike calls, and the directories that
were *not* scanned. **An empty list plus an empty `caveats` is a real negative; an empty list with
caveats is not.** That distinction is the whole reason the field exists.

Reports `exists: false` when PSR-4 resolves a path that isn't on disk, rather than inventing one.

### `stackmap_bindings`
`{ index?, kind?, filter?, limit?, offset? }` → the resolution table as
`abstract → concrete → declaringFile:line`. `kind` selects what to return:

| `kind` | Returns |
|---|---|
| `bindings` (default) | container + contextual |
| `container` | global bindings only |
| `contextual` | `when`/`needs`/`give` overrides only — each carries a `context` |
| `declaration` | PHP `extends`/`implements` edges |
| `all` | everything |

`filter` is a case-insensitive substring matched against abstract, concrete, context, and
declaring file. Paged, default 100 rows. Response counts rows per kind and how many have
`computedAbstract: true`.

Two edge flags matter when reading results:

- `computedAbstract: true` — the abstract is an expression evaluated at runtime, so `abstract`
  holds the source text (e.g. `self::getAppKey(HasComparatorsContract::COMPARATOR_EQUAL)`), not a
  name you can look up.
- `inferredFrom` — the edge was *derived*, not written literally at the call site. Currently only
  from expanding a `foreach` over a class-const array declared in the same file.

## Action guard

A `PreToolUse` hook on `Bash` blocks a narrow set of destructive or hard-to-reverse commands,
and nothing else.

| Rule | Why |
|---|---|
| `git merge` (not `merge-base`) | An unrequested merge is disruptive and awkward to unwind |
| push/commit touching `develop`/`main`/`master` | Shared branches should move through a PR, not a local push |
| force-push (`--force`, `-f`; `--force-with-lease` allowed) | remote history loss |
| `git reset --hard` | discards uncommitted work |
| `migrate:fresh` / `:refresh` / `:reset` / `db:wipe` | Drops every table |
| `DROP TABLE` / `DROP DATABASE` / `TRUNCATE TABLE` | same |

### Precision over breadth

`git merge-base` is read-only and far more common in ordinary work than a real merge. A blunt
`Bash(git merge*)` rule blocks the safe verb, and a guardrail that fires on ordinary work gets
switched off. The merge rule therefore excludes `merge-base`, and there is a regression test for
exactly that.

`rm -rf` is deliberately **not** blocked. It is overwhelmingly aimed at scratch directories, so
blocking it would be constant friction for no matching payoff.

### It fails closed

Hooks fail *open* by default — a crash, timeout, or malformed JSON lets the call proceed, so a
broken guardrail silently permits what it exists to prevent. Exit code 2 is the only code that
blocks unconditionally, so every internal failure path here exits 2: unreadable stdin, malformed
JSON, a missing script, no usable node, an evaluation error. `npm run guard-test` asserts those
paths, not just the happy ones.

The guard reads its config directly rather than importing from `dist/`, so a broken TypeScript
build cannot disable the safety layer.

### Configuration

```json
"guard": { "enabled": true, "protectedBranches": ["develop", "main", "master"], "allowMerge": false }
```

### Second layer

A few literal forms are also in `~/.claude/settings.json` under `permissions.deny`. Deny rules are
evaluated before hooks and can't be talked around by the model, so they still apply if the plugin
is disabled or its script is deleted. The hook is the primary mechanism — it does real command
parsing, where a prefix rule can't tell `git merge` from `git merge-base` or handle flag ordering.

## Honesty about limits

- **Closure bindings can't be statically resolved.** In that codebase, 99 of 322 bindings are
  closures. Those return `concrete: null` with a `note` telling you to read the provider, rather
  than a guess.
- **A computed abstract stays computed.** `$this->app->singleton(self::getAppKey($key), $class)`
  binds a name that only exists at runtime. The site is now *reported* — with the expression as
  written, `computedAbstract: true`, and a caveat on every `resolve` in that index — but the
  abstract is still not a name you can look up. Reporting it is the fix; resolving it isn't
  possible statically.
- **Const expansion is narrow on purpose.** A `foreach` over a class-const array declared in the
  same file is expanded, because that is literal static data. A loop over a property, a method
  return, a merged array, or a const in another file is not, and yields one unexpanded edge
  instead of a guess. Expanded edges are marked `inferredFrom`.
- **Inheritance is indexed, but only where you scan.** `subtypes`/`supertypes` come from parsing
  `extends`/`implements` in the included directories. A framework or vendor parent is named in the
  edge but has no declaration of its own here, and a class outside `include` is invisible — which
  is why `caveats` always states which directories were scanned.
- **Receiver detection is a whitelist.** `$this->app`, `$app`, `$container`, `$this->container`,
  `app()`, the `App` facade, and `Container::getInstance()`. Anything else is skipped and counted.
  A container reached through some other expression is a false negative, visible in
  `skippedNonContainerCalls`.
- **PSR-4 only.** Classmap-autoloaded files (`database/seeds`, `database/factories`) resolve only
  if they also sit under a PSR-4 prefix.
- **Static, not runtime.** Bindings registered conditionally — inside `if` branches, environment
  checks, or by packages — are reported as declared, without evaluating the condition.
- Results describe the working tree as it is on disk right now. There is no cache to invalidate
  between calls, but the adapter memoizes within a single server process; restart or call
  `stackmap_indexes` to rebuild.

## Development

```bash
npm run check         # typecheck only
npm run build         # compile to dist/
npm run extract-test  # PHP extractors + adapter wiring, on self-contained fixtures
npm run smoke         # end-to-end test over stdio, including failure paths
```

`npm run extract-test` needs no configured repo — every case is an inline PHP fixture, each one
grounded in a defect found by running against a real 2,770-file codebase.

`npm run smoke` starts the built server as a subprocess and exercises every tool plus its error
paths. It asserts against whatever you have configured, so it needs at least one working index.

## Layout

```
src/
  config.ts            config schema, resolution, index selection
  index.ts             MCP server — tool definitions and dispatch
  notes/store.ts       note serialization, file stamping, drift, caching
  notes/search.ts       BM25 over an inverted index
  notes/tools.ts       note_* tool handlers
  php/psr4.ts          composer.json PSR-4 -> symbol/file mapping, both directions
  php/uses.ts          namespace + use-statement parsing, short-name expansion
  php/bindings.ts      container + contextual binding extraction (receiver-checked,
                       paren/quote-aware, not line-based)
  php/declarations.ts  class/interface/trait/enum declarations and their extends/implements
  adapters/types.ts    StackAdapter interface — the seam new stacks implement
  adapters/laravel.ts  Laravel adapter
  adapters/registry.ts stack detection and adapter caching
  adapters/walk.ts     directory walker honouring excludes
```

To add a stack, implement `StackAdapter` and register a factory in `adapters/registry.ts`.
Nothing in `config.ts`, `index.ts`, or the tool surface is PHP-specific.
