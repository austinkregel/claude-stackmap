# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`stackmap` is a Claude Code **plugin** (not a library or app). It ships four surfaces from one
repo, each with a different runtime and different failure semantics:

| Surface | Entry point | Runs from | Needs a build? |
|---|---|---|---|
| MCP server (`stackmap_*`, `note_*` tools) | `scripts/launch` (`launch.cmd` on Windows) → `dist/index.js` | compiled TS | **yes** |
| Hooks (guards, house rules, freshness, fetch sanity, skill and audit checks) | `hooks/hooks.json` → `scripts/guard` / `scripts/hook-open` (`.cmd` on Windows) → `scripts/*.mjs` | plain `.mjs`, never `dist/` | no |
| `sm` CLI | `bin/sm` (`bin/sm.cmd` on Windows) → `scripts/cli/main.mjs` | plain `.mjs` | no |
| Skills | `skills/*/SKILL.md` | markdown | no |
| Agents | `agents/*.md` (auto-discovered; no `agents` key in `plugin.json`) | markdown | no |

Every guard rule is narrow enough not to fire on ordinary work, with a test for the safe lookalike
it must not catch. Every blind spot is reported as a count or a caveat.

## Commands

```bash
npm install
npm run build          # tsc -> dist/  (required before the MCP server, config-test, extract-test, notes-test, smoke)
npm run check          # typecheck only
npm run watch          # tsc --watch
npm test               # every suite below, in order
npm run bench          # note retrieval latency + rank quality
```

Run a single suite directly — they are standalone scripts, and there is no test-name filter:

```bash
node scripts/plugin-test.mjs        # hooks.json wiring, launcher twins and line endings, name agreement, closing-block drift, npm test coverage
node scripts/shell-tokens-test.mjs  # shell parser the Bash guards evaluate (no build needed)
node scripts/guard-test.mjs         # destructive commands, commit messages, the guard launcher's fail-closed paths
node scripts/truncate-test.mjs      # no-truncate
node scripts/suppress-test.mjs      # no-suppress + suppression catalog integrity
node scripts/house-rules-test.mjs   # house rules: extend/replace/disable and every failure path
node scripts/hooks-test.mjs         # the hook-open launcher, freshness, fetch sanity, config.example.json
node scripts/skill-check-test.mjs   # /review and /double-blind closing blocks, arming, loop safety
node scripts/audit-test.mjs         # the auditor's report check, Reproducers against transcript fixtures, lag retries
node scripts/cli-test.mjs           # every sm subcommand through bin/sm: output, counts, --json, exit codes
node scripts/config-test.mjs        # config resolution, per-entry validation, scope, detection, roots, cache, addIndex  (needs dist/)
node scripts/extract-test.mjs       # PHP extractors + adapter wiring, several roots, inline fixtures  (needs dist/)
node scripts/notes-test.mjs         # note store: supersession, drift, stamps across roots, file format, typed notes, note_query, tokenizer  (needs dist/)
node scripts/plans-test.mjs         # plan store: plans config section, record validation, nesting, ownership, final states, closing
node scripts/smoke.mjs              # every MCP tool over stdio: scope, aliases, duplicates, add-index, typed notes, notesDir change, plus a no-config server  (needs dist/)
```

Every suite uses temporary config, state, notes, and fixtures (`$STACKMAP_CONFIG`, `$STACKMAP_STATE`,
`HOME` and `USERPROFILE`); keep it that way in any new test, so none reads your real config.

Suites must run on Linux, macOS, and Windows (CI runs all three, `.github/workflows/test.yml`):
- run launchers with `crossSpawn.sync(join(scripts, "guard"), …)`, never `spawnSync` on a launcher
  path. On Windows, cross-spawn resolves the extensionless name to the `.cmd` twin through `cmd.exe`,
  as Claude Code does for the MCP server. Node refuses to spawn a `.cmd` without a shell.
- import `dist/` with `pathToFileURL(...).href`, since a `C:\` path isn't a valid ESM specifier.
- set `USERPROFILE` wherever you set `HOME`, because `os.homedir()` reads it on Windows.

Each suite prints `PASS`/`FAIL` per check and exits non-zero if any failed; add a `check(...)` call
to extend one. A new `*-test.mjs` needs an npm script in the `test` chain; `plugin-test` fails
otherwise.

After `npm run build`, run `/reload-plugins` in Claude Code to pick up the new `dist/`.

## Config lives outside the repo

Resolution order, first hit wins: `$STACKMAP_CONFIG`, `$XDG_CONFIG_HOME/stackmap/config.json`,
`~/.config/stackmap/config.json`. Copy `config.example.json` there; see the README for fields.
Adding a project is a config edit, or the `stackmap_add_index` tool, as long as its stack has an
adapter.

Notes live under `notesDir` (default `~/.config/stackmap/notes/`): one markdown file per note, plus a
`<id>.json` data file beside each typed note.
Per-session hook state (`sessions/<id>.review.json`) lives in `~/.stackmap/`, or under
`$STACKMAP_STATE` (must be absolute). `stateDir()` in `scripts/hook-lib.mjs` is the only place that
path is resolved.

## Architecture invariants

### Node resolution

Every launcher is a pair (user decision): an extensionless POSIX sh file and a `.cmd` twin for
Windows. The pairs are `scripts/launch`, `scripts/guard`, `scripts/hook-open`, and `bin/sm`.
- **Node resolution.** `scripts/find-node.sh` is sourced by the sh launchers. `scripts/find-node.cmd`
  is `call`ed by the `.cmd` twins and looks on PATH, then in `%ProgramFiles%\nodejs\node.exe`.
- **Change both twins together.** They share script-name validation, messages' meaning, and exit
  codes.
- **Wiring.** `.mcp.json` and `hooks.json` name the extensionless path. Hooks use exec form
  (`"command": "${CLAUDE_PLUGIN_ROOT}/scripts/guard"`, `"args": ["guard.mjs"]`): shell-form hooks need
  Git Bash on Windows, and Claude Code refuses to run them without it.
- **Never** replace a launcher with a bare `node` command or a shell-form command.
- **Line endings.** `.gitattributes` keeps text LF and `*.cmd` CRLF. The `.cmd` files stay ASCII.
  plugin-test checks both twins, the git executable bit, and line endings.
- **Proven vs unverified** (from Claude Code 2.1.231's Windows build):
  - PROVEN: the MCP server's `scripts/launch` resolves to `launch.cmd` through cross-spawn's PATHEXT
    lookup.
  - UNVERIFIED: exec-form hooks are spawned with plain `child_process.spawn` in Bun, and whether that
    resolves `.cmd` has not been checked on Windows yet.
  - A hook that fails to spawn is non-blocking.

### Two-tier hook failure semantics — do not mix them

Both wrappers accept only `[a-z0-9-]+.mjs` script names.

- `scripts/guard <script>` (and `guard.cmd`) → **fails closed** (exit 2). Wraps `guard.mjs`,
  `no-truncate.mjs`, `no-suppress.mjs`. Any failure to evaluate a call blocks it; the suites assert
  those paths.
- `scripts/hook-open <script>` (and `hook-open.cmd`) → **fails open, visibly** (exit 1 with a
  `systemMessage`). Wraps `freshness.mjs`, `house-rules.mjs`, `fetch-sanity.mjs`, `skill-arm.mjs`,
  `skill-check.mjs`, `audit-check.mjs`.

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
  literally invokes a skill in `ENFORCED_SKILLS`. Background-task notifications also arrive as
  prompts (a `<task-notification>` envelope carrying an agent's output); `isTaskNotification`
  excludes them, since the payload has no other marker of origin. `skill-check.mjs` (Stop) blocks
  until the final message satisfies every armed skill, clearing each marker as it is satisfied.
  Markers older than 6 hours or corrupt are cleared.
- `audit-check.mjs` (SubagentStop, matcher `^stackmap:adversarial-auditor$`) blocks the auditor
  until its report is complete. FALSIFIED and SURVIVED require PROVEN and at least one Reproducer.
  Called for any other agent type, it reports an error rather than passing.
  - Each Reproducer after the last `Claim:` is checked against the auditor's own transcript:
    `sameShellCommand` compares the command via `shell-tokens.mjs`, and `Actual` must be an exact run
    of output lines (`verifyReproducers`).
  - Two outcomes, never mixed. What the auditor can fix blocks. What it can't is surfaced to the user
    in a `systemMessage` with the report, never blocked: a missing or unreadable transcript, an
    unparseable command, `Actual` in an excerpt's cut, a result unwritten after the lag window.
  - Reproducers on UNTESTED are not verified. The hook's 60 s timeout covers the 50 s lag window.
- `scripts/agent-transcript.mjs` reads subagent transcripts. It is a library, not a hook: it never
  reads a payload, and plugin-test asserts that.
  - The record shapes and the `<persisted-output>` and error-excerpt formats come from captures of
    Claude Code 2.1.231. The saved-output file name is parsed from the content, never derived from
    the tool_use id.
  - Anything unexpected is a `TranscriptError`, not a partial read.
- The auditor's report block in `agents/adversarial-auditor.md` must equal `AUDIT_BLOCK` exactly;
  plugin-test compares the text, not just labels.
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

`src/adapters/types.ts` defines `StackAdapter` (`resolveSymbol`, `resolutionTable`, `stats`),
`IndexedAdapter`, and `AdapterFactory` (`detect`, `create(cfg, roots, globalExclude)`).

To add a stack:
- implement the interface;
- give the factory a `detect` that reads the root's own manifest;
- register it in `FACTORIES` in `src/adapters/registry.ts`, moving it out of `PLANNED`.

Detection is first match in `FACTORIES` order, then the `PLANNED` markers.

**Capabilities are declared, never assumed.** An `IndexedAdapter` names every capability (today
`resolve`), with `null` when the adapter lacks it. Tools get one through `requireCapability`, which
fails naming the tool, the index, the adapter, and the capability. The config and the tool surface
are stack-neutral. `index.ts`'s resolve and bindings descriptions, and its edge-count sum, are
PHP-specific because Laravel is the only `resolve` provider; keep new tools stack-neutral.

Laravel is the only implemented adapter. Edges are built in one pass and memoized per adapter
instance. The registry cache is keyed by index name plus a fingerprint of the resolved config (roots'
real paths and rules, adapter, include, exclude, options, globalExclude), so a config edit rebuilds on
the next query. `clearAdapterCache()` (called by `stackmap_indexes`) also rebuilds, which is what
re-reads changed source files.

### Projects, roots, and scope

An index entry is a **project**: its `root` (which owns the index) plus `aliases`, each an extra root
`{ path, include?, exclude? }`.
- `resolveRoots` resolves every root to a real path, and a missing, non-directory, or duplicated root
  is an error.
- Each file is indexed once, grouped under the innermost root containing it, with paths relative to
  that root. Only that root's walk, under its own rules, indexes it, so a child root's rules win over
  its parent's.
- Groups are ordered aliases first, then the main root. A nested alias precedes the alias containing
  it (deepest first), and siblings are in path order.
- `FileRef`, `ResolutionEdge.root`, and `RootStats` carry the root. Never report a path without its
  root.

Config entries are validated one at a time (`parseConfig`):
- An unknown key, any invalid field, or a root whose own (or inherited) `include` names a directory
  its `exclude` rules out leaves only that entry out, recorded in `indexErrors`.
- A contradiction with `globalExclude` or an adapter default is not a config error: the walker skips
  the directory and the adapter warns.
- A later entry reusing a name is ignored (the first wins) and reported in `stackmap_indexes` and in
  every query's `caveats` (`duplicateCaveats`).
- `addIndex` edits the file's JSON as written, because `guard` and `houseRules` aren't modelled
  here. It refuses names used by any entry, valid or not.

`scope` (a list of project names, `selectScope`) replaces `index` on every `stackmap_*` tool.
- Omitted means `selectIndex`'s default.
- `acrossScope` gives each project its own outcome, and a project that can't answer is an error
  entry, never dropped.
- `index.ts` rejects arguments a tool doesn't declare. Argument values go through `src/args.ts`
  (`countArg`, `stringArg`, `stringListArg`, `booleanArg`). A value of the wrong type is an error that
  shows it as JSON. Never coerce an argument with `String()`, `Boolean()`, or a template (an object
  becomes `[object Object]`), and never fall back to a default for anything but an absent value.

`walkFiles` returns sorted files, and reports missing, unreadable, and excluded configured
directories.
- An exclude with a `/` is a root-relative path.
- An exclude also applies to configured include directories. Config validation rejects an entry's
  own contradictions, so the walker only sees ones from global or default excludes.

Laravel reads `composer.json` per root:
- a main root without one, or any root whose file can't be read, is an error for that root;
- an alias without one is indexed with a warning.

Report unknowns as unknown: a closure binding yields `concrete: null` plus a `note`; a PSR-4 path
that isn't on disk yields `exists: false` with the candidate path.

### Note store: provenance and caching invariants

`src/notes/store.ts` writes notes in frontmatter format 2 (a `format: 2` line, every value JSON);
change `serialize` and `parseFormat2` in lockstep. `parseLegacy` only reads the older format; a note
is rewritten as format 2 on its next write.
- Both parsers are strict: an unknown key, a key given twice, or a line that isn't a key is an error.
- `parseLegacy` requires exactly what every older writer emitted: all nine keys, a bare-word status,
  quoted strings, `[..]` lists of quoted strings, and path, sha256, and at on every stamp. Never add
  a default for something missing. `note_write` content-hashes every file the note is about;
`drift()` re-hashes at read time.

A file that can't be read as a note is never skipped: `scan()` lists it in `malformed()`, every note
tool returns it as `malformedFiles`, and `get()` throws for it. That includes an unknown status, a data
file with no note or beside an untyped note, and a typed note whose data file is missing, unparseable,
or doesn't match.

Typed notes are two files: `<id>.md` names `schema`, `schema_version`, and the `data_sha256` of
`<id>.json` (`{schema, version, data}`). `write()` writes the data file first and the note second,
each through a temporary file and a rename. An interrupted pair leaves an orphan data file or a hash
mismatch, and both are reported on read. Note ids that could leave the notes directory are refused
(`checkId`).

`src/notes/schemas.ts` holds the shipped schemas as `name@version`. `notes-test` pins a sha256 of each
one's JSON Schema, so changing a shape means a new version, never an edit under the old one. Records
of another version, or that fail validation, are reported in `note_query`'s `invalid` and `note_get`'s
`validation`, never treated as current. `src/notes/query.ts` checks a filter's parameters against the
schema's JSON Schema before running it, so an unknown field is an error, not an empty result.

`index.ts` keeps one `NoteStore` per process, keyed by the expanded `notesDir`. A changed `notesDir`
gets a new store, and the old one's watcher is closed.

`src/notes/search.ts` is Okapi BM25 (k1 1.2, b 0.75) with a 3x title/tag boost over an inverted
index. A typed note's schema name and every key and value of its data are indexed at body weight with
`dataTokens`, which keeps numbers and short tokens whole. Queries are tokenized both ways. The
tokenizer's rules are user-approved and pinned by `notes-test`; don't change them silently. Cache
invalidation keys:

| Cache | Keyed / invalidated by |
|---|---|
| file hashes (`hashCache`) | `mtimeMs:size` |
| parsed notes (`NoteStore.cache`) | `mtimeMs:size` of the note **and** of its `.json` data file |
| directory listing (`listCache`) | `fs.watch` dirty flag **plus** a 2s wall-clock backstop |
| tokenized docs (`docCache`) | `WeakMap` on `Note` object identity |

The watcher is never the correctness boundary; keep the backstop. `store.write()` sets `dirty`
itself. `scan()` must replace the `Note` object whenever its file changes, or `docCache` goes stale.

Stamps and drift resolve against the roots of the project named in the note's own `repo` (else
`defaultIndex`, else the only enabled project), looked up per note, never per query.
- A `FileStamp` records its alias's configured path in `root`; absent means the main root, which is
  how stamps written before roots existed read.
- A relative path is stamped in the one root that holds it. In two roots it is an error. With no
  resolvable project it is an error (absolute paths need none).
- Drift reports `unresolved`, with a reason, when the project or alias can't be found.

### `sm` CLI: verified counts, not silent drops

Every command reports read / matched / skipped / error counts and supports `--json`. Exit 3 means
the result is incomplete (unparseable lines, ragged rows, duplicates found, a `--lines`/`--bytes`
range past EOF); exit 1 means bad input or an unreadable path. Numeric flags go through
`numberFlag`, so a typo is an error rather than a disabled limit. When adding a subcommand, register
it in `COMMANDS` and `USAGE` in `scripts/cli/main.mjs`, share flag parsing via
`scripts/cli/args.mjs`, and cover it in `cli-test.mjs`.
