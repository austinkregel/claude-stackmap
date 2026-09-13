# stackmap

A Claude Code plugin in four parts.

| Component | What it does |
|---|---|
| `stackmap_*` MCP tools | Deterministic code-structure lookups — resolve an interface to its implementation and file without reading service providers |
| `note_*` MCP tools + `recall` skill | A durable cross-session note store with provenance stamping, so a conclusion outlives the session that reached it |
| Hooks | Guards against destructive commands, truncated command output, and check-silencing edits; configurable house rules injected into every session and sub-agent; repo-freshness context, fetch sanity, and review enforcement |
| `sm` CLI | Reusable data commands (`jsonl`, `csv`, `slice`, `wait`, `dupes`) that report their own counts instead of dropping rows quietly |

Run `npm test` for the full suite, across the shell parser, the guards, house rules, the
informational hooks, review enforcement, the PHP extractors, the note store, and the MCP server.
`npm run bench` measures retrieval at scale.

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

## Guards

Three `PreToolUse` guardrails. Each evaluates the *parsed* command or edit, not raw text, and each
fails closed.

| Hook | Tool | Blocks |
|---|---|---|
| `guard.mjs` | `Bash` | destructive, hard-to-reverse commands, and commit messages that contain a command |
| `no-truncate.mjs` | `Bash` | a live command's output piped into a truncating filter without `tee` first |
| `no-suppress.mjs` | `Edit`, `Write`, `NotebookEdit` | an edit that introduces a check-silencing directive |

### Destructive commands and commit messages (`guard.mjs`)

| Rule | Why |
|---|---|
| `git merge` (not `merge-base`) | An unrequested merge is disruptive and awkward to unwind |
| push/commit touching `develop`/`main`/`master` | Shared branches should move through a PR, not a local push |
| force-push (`--force`, `-f`; `--force-with-lease` allowed) | remote history loss |
| `git reset --hard` | discards uncommitted work |
| `migrate:fresh` / `:refresh` / `:reset` / `db:wipe` | Drops every table |
| `DROP TABLE` / `DROP DATABASE` / `TRUNCATE TABLE` (including in a heredoc fed to a client) | same |
| a commit message containing `git <subcommand>` | A command inside a commit message is almost always a mis-type: "wip; git merge later" should read "wip; merge later" |

The commit-message rule reads `-m`, `--message`, clustered `-am`, `-F <file>`, and heredoc
messages (`-m "$(cat <<'EOF' … EOF)"`, `-F - <<EOF`). Subcommand names come from the tool itself
(`git --list-cmds=main,alias`), so "git is implied" passes while "git remote" does not. It matches
prose that names a subcommand too ("the git remote"), by design. A message piped in on stdin
cannot be read, so it fails closed. Text built at runtime (`-m "$MSG"`) is not checked.

### Truncated output (`no-truncate.mjs`)

Not every command is safe to run twice, so a command's output must be captured in full before
anything cuts it down.

- In a pipeline, if any later stage is a truncating filter, the stage straight after the producer
  must be `tee`: `cmd 2>&1 | tee out.log | tail` passes; `cmd | tail | tee out.log` and
  `cmd | sort | tee out.log | tail` do not.
- A `tee` in a different command does not count: `cmd && tee f | tail` blocks. Reading the saved
  file afterwards (`cmd | tee f && tail f`) passes.
- A filter reading a process substitution (`tail <(cmd)`) blocks.
- Filters on files (`grep x file`, `tail -50 build.log`) pass.
- `wc`, `sort`, and `jq` are not truncating filters. The list is `guard.noTruncate.consumers`.

Run over 5,727 distinct Bash commands from real Claude Code transcripts, it blocked 2,435. All but
one name a pipe (or process substitution) into one of those filters; the remaining one is a
command that bash and zsh both reject as a syntax error.

### Check-silencing edits (`no-suppress.mjs`)

Dead code is deleted, not annotated; a failing check is fixed, not silenced. The catalog in
`scripts/suppression-rules.mjs` covers inline directives for JS/TS, Python, Rust, Go, JVM, C#,
C/C++, Swift, PHP, Ruby, Elixir, shell, and CSS, plus config-level relaxations (`tsconfig`
strictness and unused checks, ESLint rules set to off/warn, ruff/flake8/pylint/mypy ignores, pytest
deselects, Cargo lint levels, phpstan `ignoreErrors`, psalm error levels, golangci, rubocop,
swiftlint, phpunit/jest/vitest exclusions, GitHub Actions `continue-on-error`) and hook bypasses.

| Category | Example |
|---|---|
| `lint` | a linter told to ignore a line or rule |
| `type` | a type checker told to ignore code, or strictness turned off |
| `test-skip` | a skipped, focused (`.only`), or excluded test |
| `coverage` | code excluded from coverage |
| `dead-code` | unused-code diagnostics silenced (`[[maybe_unused]]`, `noUnusedLocals: false`) |
| `hook-bypass` | commit hooks bypassed |
| `ci` | a CI step allowed to fail |

Only an edit that *introduces* a directive blocks: per rule, the match count after the edit may not
exceed the count before. For `Write`, "before" is the file on disk, so rewriting a file that
already carries a directive passes, while adding a second, different directive does not. Patterns
are scoped to file types, so an iterator's `skip(n)` in Rust or Java is not a skipped test.
Notebook cells use the notebook's declared language; with none declared, every inline rule applies.

### Precision over breadth

A guardrail that fires on ordinary work gets switched off, so every allowance is pinned by a test:

- `git merge-base` is read-only and far more common than a real merge, so the merge rule excludes it.
- `rm -rf` is deliberately **not** blocked. It is overwhelmingly aimed at scratch directories.
- Quoted text is data: `echo "wip; git merge later"` is an echo, not a merge.
- Commands inside `$(…)`, backticks, `${x:-$(…)}`, unquoted heredoc bodies, and `bash -c '…'` are
  still commands, even inside double quotes.

The shell parser (`scripts/shell-tokens.mjs`) was checked against the same 5,727 real commands: it
rejects none that bash accepts.

### They fail closed

Hooks fail *open* by default — a crash or malformed JSON lets the call proceed, so a broken
guardrail silently permits what it exists to prevent. Exit code 2 is the only code that blocks
unconditionally, so every path that cannot evaluate a call exits 2: unreadable stdin, malformed
JSON, invalid config (including a misspelled key), a command the shell would reject, a filter or
git subcommand only known at runtime, a missing script, no usable node. The test suites assert
those paths, not just the happy ones.

`scripts/guard.sh <script.mjs>` wraps every guardrail. It accepts only `[a-z0-9-]+.mjs` names, so
an argument cannot run a file outside `scripts/`. The guards parse their config directly
(`scripts/hook-config.mjs`) rather than importing from `dist/`, so a broken TypeScript build cannot
disable them.

A **timeout** is the one failure that still lets a call through: per the hooks reference, a
`PreToolUse` command hook cancelled at its `timeout` lets the tool call continue. Every hook entry
sets an explicit, short timeout (the default is 600 seconds).

### Configuration

```json
"guard": {
  "enabled": true,
  "protectedBranches": ["develop", "main", "master"],
  "allowMerge": false,
  "noTruncate": { "enabled": true, "consumers": ["head", "tail", "less", "more", "cut", "grep", "egrep", "rg", "sed", "awk", "Select-Object", "Select-String", "Format-Table", "findstr"] },
  "noSuppress": { "enabled": true, "disableCategories": [] },
  "commitMessage": { "enabled": true, "commands": [{ "name": "git", "listCommand": ["git", "--list-cmds=main,alias"] }] }
}
```

| Key | Meaning |
|---|---|
| `enabled` | the destructive-command rules in `guard.mjs` |
| `noTruncate.consumers` | programs treated as truncating filters |
| `noSuppress.disableCategories` | catalog categories not enforced |
| `commitMessage.commands` | tools whose subcommands may not appear in a commit message; each entry has `subcommands` (a list) or `listCommand` (argv that prints them) |

In the `guard` and `houseRules` sections, unknown keys, wrong types, and unknown category names are
errors, not silent no-ops.

## House rules

A `SessionStart` and `SubagentStart` hook injects a working agreement into Claude's context: at
startup, resume, clear, fork, and after compaction, and into every sub-agent.

The shipped default (`house-rules/default.md`) covers asking instead of assuming, proving instead
of guessing, verifying before claiming, failing loudly, never narrowing a check to get green, root
causes over band-aids, reusing what exists, planning, never truncating output, sub-agent
briefings, commits, and keeping docs current. The injected text ends with a list, generated from
the `guard` config, of which rules the hooks enforce — so turning a guard off never leaves text
claiming it is enforced.

```json
"houseRules": { "enabled": true, "mode": "extend", "files": [], "disable": [] }
```

| Key | Meaning |
|---|---|
| `mode` | `extend`: the default ruleset, then `files`. `replace`: only `files`. |
| `files` | Markdown rule files, injected in order. Absolute or `~/` paths; an organisation can point at a shared checkout. |
| `disable` | default section ids to drop (`extend` only): `ask`, `prove`, `verify`, `no-fallbacks`, `no-narrowing`, `root-cause`, `reuse`, `plan`, `command-output`, `sub-agents`, `commits`, `write-it-down` |

If a configured file is missing, unreadable, or empty, a `disable` id is unknown, or the total
exceeds Claude Code's 10,000-character limit for hook output, **nothing** is injected and the user
is shown why. A partial rule set would read as the complete one, and an oversize one would be
replaced by a preview the model would not notice.

## Informational hooks

`freshness` (SessionStart), `house-rules`, `fetch-sanity` (PostToolUse), and `review-arm` /
`review-check` (UserPromptSubmit / Stop) run through `scripts/hook-open.sh <script.mjs>` and fail
**open**: a failure never blocks a session, prompt, tool result, or turn. It is never silent
either. Stderr from a hook that exits 0 goes only to the debug log, so a failure instead exits 1 and
carries a `systemMessage` for the user. A `git fetch` that fails at session start is stated in the
freshness context rather than presenting stale ahead/behind counts as verified.

Per-session state (review markers) lives in `~/.stackmap/sessions`, or under `$STACKMAP_STATE`
when set (it must be absolute). The test suites point `$STACKMAP_STATE` and `$STACKMAP_CONFIG` at
temp directories, so running them never touches real files.

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
- **Guards see the command, not what it runs.** `eval` strings, aliases, shell functions, scripts
  on disk, and zsh-only syntax (glob qualifiers) are not followed. A program whose name is built at
  runtime is not recognised by the destructive-command rules, and a refspec built at runtime
  (`git push origin "$BRANCH"`) is not checked against protected branches.
- **Edit hooks see edits, not shell writes.** A directive written with `sed -i` or `cat >` is not
  seen by `no-suppress`. Pest's `->skip()` chain is not matched, because Laravel collections share
  the method name.
- **A hook's `systemMessage` is verified to reach Claude Code, not verified on screen.** In a
  headless run a failing informational hook is recorded as `exit_code: 1, outcome: "error"` with its
  message; how the interactive transcript renders it was not checked.

## Development

```bash
npm run check              # typecheck only
npm run build              # compile to dist/
npm run shell-tokens-test  # the shell parser the Bash guards evaluate
npm run guard-test         # destructive-command and commit-message rules, guard.sh
npm run truncate-test      # no-truncate
npm run suppress-test      # no-suppress and the suppression catalog
npm run house-rules-test   # house rules: extend/replace/disable, and every failure path
npm run hooks-test         # hook-open.sh, freshness, fetch sanity, config.example.json
npm run review-test        # review arm/check
npm run extract-test       # PHP extractors + adapter wiring, on self-contained fixtures
npm run smoke              # end-to-end test over stdio, including failure paths
```

The hook suites need no build and use temporary config and state directories.

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
scripts/
  hook-lib.mjs         hook wire protocol: deny, block, context, visible errors, state dir
  hook-config.mjs      the `guard` and `houseRules` config sections, strictly validated
  shell-tokens.mjs     shell parser shared by the Bash guards
  guard.mjs            destructive commands and commit messages
  no-truncate.mjs      truncated command output
  no-suppress.mjs      check-silencing edits
  suppression-rules.mjs  the suppression catalog
  house-rules.mjs      house rules injection
  guard.sh / hook-open.sh  fail-closed / fail-open wrappers
house-rules/
  default.md           the shipped default ruleset
```

To add a stack, implement `StackAdapter` and register a factory in `adapters/registry.ts`.
Nothing in `config.ts`, `index.ts`, or the tool surface is PHP-specific.
