# stackmap

A Claude Code plugin in four parts.

| Component | What it does |
|---|---|
| `stackmap_*` MCP tools | Deterministic code-structure lookups — resolve an interface to its implementation and file without reading service providers |
| `note_*` MCP tools + `recall` skill | A durable cross-session note store with provenance stamping |
| Hooks | Guards against destructive commands, truncated command output, and check-silencing edits; configurable house rules injected into every session and sub-agent; repo-freshness context, fetch sanity, and review enforcement |
| `sm` CLI | Reusable data commands (`jsonl`, `csv`, `slice`, `wait`, `dupes`) that report their own counts instead of dropping rows quietly |

`npm test` runs every suite. `npm run bench` measures note retrieval latency and rank quality.

## Status

| Stack | Detection | Resolution table | State |
|---|---|---|---|
| Laravel / PHP | `artisan` | container `bind`/`singleton`/`scoped`/`instance`, contextual `when`/`needs`/`give`, PHP `extends`/`implements` | **implemented** |
| Phoenix / Elixir | `mix.exs` | behaviours + app config + supervision trees | detected, not implemented |
| Node / TS | `package.json` | — | detected, not implemented |

## Install

```bash
cd /path/to/stackmap
npm install
npm run build
```

### In the CLI

```bash
claude --plugin-dir /path/to/stackmap
```

### In VS Code (Claude Code extension)

`--plugin-dir` is CLI-only. In the extension, any folder under `~/.claude/skills/` containing
`.claude-plugin/plugin.json` loads in place as `<name>@skills-dir`:

```bash
mkdir -p ~/.claude/skills
ln -sfn /path/to/stackmap ~/.claude/skills/stackmap
```

Then enable it in `~/.claude/settings.json`:

```json
{ "enabledPlugins": { "stackmap@skills-dir": true } }
```

Start a new session or run `/reload-plugins`. A server that failed to start is listed in the
**Errors** tab of `/plugin`. After each `npm run build`, run `/reload-plugins` to pick up the new
`dist/`.

`.mcp.json` starts the server through `scripts/launch.sh`, which finds a working `node` binary and
prints an error on stderr if none works.

## Configuration

Config lives outside the repo. Resolution order, first hit wins:

1. `$STACKMAP_CONFIG`
2. `$XDG_CONFIG_HOME/stackmap/config.json`
3. `~/.config/stackmap/config.json`

Copy `config.example.json` to `~/.config/stackmap/config.json` and edit.

```json
{
  "defaultIndex": "my-app",
  "indexes": [
    {
      "name": "my-app",
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
| `notesDir` | Where notes are stored. Default `~/.config/stackmap/notes`. |

Adding a repo is a config edit, as long as its stack has an adapter.

## Tools

### `stackmap_indexes`
Lists configured indexes with detected stack and structure counts. Reports per-index errors
(missing root, unimplemented adapter) without failing the whole call.

### `stackmap_resolve`
`{ symbol, index? }` → the symbol's file plus every edge, in six separate fields:

| Field | Source | Answers |
|---|---|---|
| `implementedBy` | container bindings, abstract side | what the container hands you for this abstract |
| `implements` | container bindings, concrete side | what this class is registered as |
| `subtypes` | PHP `extends`/`implements` | what actually implements this interface |
| `supertypes` | PHP `extends`/`implements` | what this class extends/implements |
| `injections` | `when(X)->needs(…)->give(…)` | what gets injected into X |
| `injectedInto` | same, other side | where this type/parameter is injected |

Plus `caveats`: runtime-computed binding sites, skipped lookalike calls, and the directories that
were scanned. **An empty list plus an empty `caveats` is a real negative; an empty list with
caveats is not.**

Reports `exists: false` when PSR-4 resolves a path that isn't on disk.

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

Edge flags:

- `computedAbstract: true` — the abstract is an expression evaluated at runtime, so `abstract`
  holds the source text, not a name you can look up.
- `inferredFrom` — the edge was derived, not written literally at the call site. Currently only
  from expanding a `foreach` over a class-const array declared in the same file.

## Guards

Three `PreToolUse` guardrails. Each evaluates the parsed command or edit, not raw text, and each
fails closed.

| Hook | Tool | Blocks |
|---|---|---|
| `guard.mjs` | `Bash` | destructive, hard-to-reverse commands, and commit messages that contain a command |
| `no-truncate.mjs` | `Bash` | a live command's output piped into a truncating filter without `tee` first |
| `no-suppress.mjs` | `Edit`, `Write`, `NotebookEdit` | an edit that introduces a check-silencing directive |

### Destructive commands and commit messages (`guard.mjs`)

| Rule | Blocks |
|---|---|
| `git merge` | a merge (`merge-base` is allowed; `guard.allowMerge` turns the rule off) |
| push/commit touching a protected branch | pushes and commits to `guard.protectedBranches` |
| force-push | `--force`, `-f` (`--force-with-lease` is allowed) |
| `git reset --hard` | discarding uncommitted work |
| `migrate:fresh` / `:refresh` / `:reset` / `db:wipe` | dropping every table |
| `DROP TABLE` / `DROP DATABASE` / `TRUNCATE TABLE` | the same, including in a heredoc fed to a client |
| a commit message containing `git <subcommand>` | a command inside a commit message |

- The commit-message rule reads `-m`, `--message`, clustered `-am`, `-F <file>`, and heredoc
  messages. Subcommand names come from `git --list-cmds=main,alias`.
- Prose naming a subcommand ("the git remote") also matches.
- A message piped in on stdin fails closed. Text built at runtime (`-m "$MSG"`) is not checked.
- `rm -rf` is not blocked.
- Quoted text is data: `echo "wip; git merge later"` is an echo, not a merge.
- Commands inside `$(…)`, backticks, `${x:-$(…)}`, unquoted heredoc bodies, and `bash -c '…'` are
  evaluated, even inside double quotes.

### Truncated output (`no-truncate.mjs`)

- In a pipeline, if any later stage is a truncating filter, the stage straight after the producer
  must be `tee`: `cmd 2>&1 | tee out.log | tail` passes; `cmd | tail | tee out.log` and
  `cmd | sort | tee out.log | tail` do not.
- A `tee` in a different command does not count: `cmd && tee f | tail` blocks. Reading the saved
  file afterwards (`cmd | tee f && tail f`) passes.
- A filter reading a process substitution (`tail <(cmd)`) blocks.
- Filters on files (`grep x file`, `tail -50 build.log`) pass.
- `wc`, `sort`, and `jq` are not truncating filters. The list is `guard.noTruncate.consumers`.

### Check-silencing edits (`no-suppress.mjs`)

The catalog in `scripts/suppression-rules.mjs` covers inline directives for JS/TS, Python, Rust,
Go, JVM, C#, C/C++, Swift, PHP, Ruby, Elixir, shell, and CSS, plus config-level relaxations
(`tsconfig` strictness and unused checks, ESLint rules set to off/warn, ruff/flake8/pylint/mypy
ignores, pytest deselects, Cargo lint levels, phpstan `ignoreErrors`, psalm error levels,
golangci, rubocop, swiftlint, phpunit/jest/vitest exclusions, GitHub Actions `continue-on-error`)
and hook bypasses.

| Category | Example |
|---|---|
| `lint` | a linter told to ignore a line or rule |
| `type` | a type checker told to ignore code, or strictness turned off |
| `test-skip` | a skipped, focused (`.only`), or excluded test |
| `coverage` | code excluded from coverage |
| `dead-code` | unused-code diagnostics silenced (`[[maybe_unused]]`, `noUnusedLocals: false`) |
| `hook-bypass` | commit hooks bypassed |
| `ci` | a CI step allowed to fail |

- Only an edit that introduces a directive blocks: per rule, the match count after the edit may
  not exceed the count before. For `Write`, "before" is the file on disk.
- Patterns are scoped to file types, so an iterator's `skip(n)` in Rust or Java is not a skipped
  test.
- Notebook cells use the notebook's declared language; with none declared, every inline rule
  applies.

### Failure handling

- Every path that cannot evaluate a call exits 2: unreadable stdin, malformed JSON, invalid config
  (including a misspelled key), a command the shell would reject, a filter or git subcommand only
  known at runtime, a missing script, no usable node.
- `scripts/guard.sh <script.mjs>` wraps every guardrail and accepts only `[a-z0-9-]+.mjs` names.
- The guards read config through `scripts/hook-config.mjs`, not `dist/`.
- A `PreToolUse` hook that times out lets the call through, so every hook entry sets a short
  explicit `timeout`.

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
| `protectedBranches` | branches that push/commit may not touch |
| `allowMerge` | `true` permits `git merge` |
| `noTruncate.consumers` | programs treated as truncating filters |
| `noSuppress.disableCategories` | catalog categories not enforced |
| `commitMessage.commands` | tools whose subcommands may not appear in a commit message; each entry has `subcommands` (a list) or `listCommand` (argv that prints them) |

In the `guard` and `houseRules` sections, unknown keys, wrong types, and unknown category names are
errors.

## House rules

A `SessionStart` and `SubagentStart` hook injects a working agreement into Claude's context: at
startup, resume, clear, fork, and after compaction, and into every sub-agent.

The shipped default (`house-rules/default.md`) covers asking instead of assuming, proving instead
of guessing, verifying before claiming, failing loudly, never narrowing a check to get green, root
causes over band-aids, reusing what exists, planning, never truncating output, sub-agent
briefings, commits, and keeping docs current. The injected text ends with a list, generated from
the `guard` config, of which rules the hooks enforce.

Default rule text that a guard enforces is left out while that guard is enabled, since the
enforcement list and the guard's block message carry it: the `command-output` section
(`noTruncate`), the dead-code bullet (`noSuppress` with the `dead-code` category), and the
commit-message bullet (`commitMessage`). Turning the guard off brings the text back.

```json
"houseRules": { "enabled": true, "subagents": true, "mode": "extend", "files": [], "disable": [] }
```

| Key | Meaning |
|---|---|
| `subagents` | `false` skips injection at `SubagentStart`. Guards still apply inside sub-agents. |
| `mode` | `extend`: the default ruleset, then `files`. `replace`: only `files`. |
| `files` | Markdown rule files, injected in order. Absolute or `~/` paths. |
| `disable` | default section ids to drop (`extend` only): `ask`, `prove`, `verify`, `no-fallbacks`, `no-narrowing`, `root-cause`, `reuse`, `plan`, `command-output`, `sub-agents`, `commits`, `write-it-down` |

If a configured file is missing, unreadable, or empty, a `disable` id is unknown, or the total
exceeds Claude Code's 10,000-character limit for hook output, **nothing** is injected and the user
is shown why.

## Informational hooks

`freshness` (SessionStart), `house-rules`, `fetch-sanity` (PostToolUse), and `review-arm` /
`review-check` (UserPromptSubmit / Stop) run through `scripts/hook-open.sh <script.mjs>` and fail
open: a failure exits 1 with a `systemMessage` for the user and never blocks a session, prompt,
tool result, or turn. A `git fetch` that fails at session start is stated in the freshness context.

Per-session state (review markers) lives in `~/.stackmap/sessions`, or under `$STACKMAP_STATE`
when set (it must be absolute).

## Limits

- **Closure bindings can't be statically resolved.** They return `concrete: null` with a `note`
  telling you to read the provider.
- **A computed abstract stays computed.** The site is reported with the expression as written,
  `computedAbstract: true`, and a caveat on every `resolve` in that index, but it is not a name you
  can look up.
- **Const expansion is narrow.** Only a `foreach` over a class-const array declared in the same
  file is expanded. A loop over a property, a method return, a merged array, or a const in another
  file yields one unexpanded edge. Expanded edges are marked `inferredFrom`.
- **Inheritance is indexed only where you scan.** A framework or vendor parent is named in the edge
  but has no declaration of its own, and a class outside `include` is invisible. `caveats` states
  which directories were scanned.
- **Receiver detection is a whitelist.** `$this->app`, `$app`, `$container`, `$this->container`,
  `app()`, the `App` facade, and `Container::getInstance()`. Anything else is skipped and counted
  in `skippedNonContainerCalls`.
- **PSR-4 only.** Classmap-autoloaded files resolve only if they also sit under a PSR-4 prefix.
- **Static, not runtime.** Conditionally registered bindings are reported as declared, without
  evaluating the condition.
- **Per-process memoization.** The adapter memoizes within a server process; restart or call
  `stackmap_indexes` to rebuild.
- **Guards see the command, not what it runs.** `eval` strings, aliases, shell functions, scripts
  on disk, and zsh-only syntax (glob qualifiers) are not followed. A program name or push refspec
  built at runtime is not checked.
- **Edit hooks see edits, not shell writes.** A directive written with `sed -i` or `cat >` is not
  seen by `no-suppress`. Pest's `->skip()` chain is not matched.

## Development

```bash
npm run check              # typecheck only
npm run build              # compile to dist/
npm test                   # every suite
npm run bench              # note retrieval latency and rank quality
npm run shell-tokens-test  # the shell parser the Bash guards evaluate
npm run guard-test         # destructive-command and commit-message rules, guard.sh
npm run truncate-test      # no-truncate
npm run suppress-test      # no-suppress and the suppression catalog
npm run house-rules-test   # house rules: extend/replace/disable, and every failure path
npm run hooks-test         # hook-open.sh, freshness, fetch sanity, config.example.json
npm run review-test        # review arm/check
npm run extract-test       # PHP extractors + adapter wiring, on inline fixtures
npm run notes-test         # note store
npm run smoke              # end-to-end test over stdio, including failure paths
```

The hook suites need no build and use temporary config and state directories. `extract-test`,
`notes-test`, and `smoke` need `npm run build` first. `smoke` asserts against your configured
indexes, so it needs at least one working index.

## Layout

```
src/
  config.ts            config schema, resolution, index selection
  index.ts             MCP server — tool definitions and dispatch
  notes/store.ts       note serialization, file stamping, drift, caching
  notes/search.ts      BM25 over an inverted index
  notes/tools.ts       note_* tool handlers
  php/psr4.ts          composer.json PSR-4 -> symbol/file mapping, both directions
  php/uses.ts          namespace + use-statement parsing, short-name expansion
  php/bindings.ts      container + contextual binding extraction
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
  cli/                 the sm CLI
house-rules/
  default.md           the shipped default ruleset
```

To add a stack, implement `StackAdapter` and register a factory in `adapters/registry.ts`.
