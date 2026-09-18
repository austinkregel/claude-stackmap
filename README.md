# stackmap

A Claude Code plugin in five parts.

| Component | What it does |
|---|---|
| `stackmap_*` MCP tools | Deterministic code-structure lookups — resolve an interface to its implementation and file without reading service providers |
| `note_*` MCP tools + `recall` skill | A durable cross-session note store with provenance stamping, and typed records you can query |
| `adversarial-auditor` agent + `review` and `double-blind` skills | Differentiated review and verification, with an agent that tries to falsify a claim against ground truth |
| Hooks | Guards against destructive commands, truncated command output, and check-silencing edits; configurable house rules injected into every session and sub-agent; repo-freshness context, fetch sanity, and closing-block checks for the skills and the auditor |
| `sm` CLI | Reusable data commands (`jsonl`, `csv`, `slice`, `wait`, `dupes`) that report their own counts instead of dropping rows quietly |

`npm test` runs every suite. `npm run bench` measures note retrieval latency and rank quality.

## Status

| Stack | Detection | Resolution table | State |
|---|---|---|---|
| Laravel / PHP | `composer.json` `require` or `require-dev` lists `laravel/framework` or any `illuminate/*` package | container `bind`/`singleton`/`scoped`/`instance`, contextual `when`/`needs`/`give`, PHP `extends`/`implements` | **implemented** |
| Ghidra (compiled programs) | a `.gpr` file in the root | — (functions, type layouts and references instead) | **implemented** |
| Phoenix / Elixir | `mix.exs` | behaviours + app config + supervision trees | detected, not implemented |
| Node / TS | `package.json` | — | detected, not implemented |

## Install

Needs **Node 22.13 or newer**: the MCP server reads Ghidra exports through `node:sqlite`, which stopped
needing `--experimental-sqlite` in 22.13. The launchers check the version of every node they find and
refuse an older one by name.

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

`.mcp.json` starts the server through `scripts/launch`, which finds a working `node` binary and
prints an error on stderr if none works.

### Launchers and Windows

Every entry point is an extensionless POSIX sh launcher with a Windows `.cmd` twin:

| Launcher | Windows twin | Runs |
|---|---|---|
| `scripts/launch` | `scripts/launch.cmd` | the MCP server |
| `scripts/guard` | `scripts/guard.cmd` | guardrail hooks (fail closed) |
| `scripts/hook-open` | `scripts/hook-open.cmd` | informational hooks (fail open) |
| `bin/sm` | `bin/sm.cmd` | the `sm` CLI |

- **How they're called.** `.mcp.json` and `hooks.json` name the extensionless path. Hooks use exec form
  (`"command"` plus `"args"`), so no shell is involved. On Windows the path resolves to the `.cmd` twin.
- **Finding node.** The sh launchers look on PATH, then in asdf, nvm, and mise installs, Homebrew, and
  shims. The `.cmd` launchers look on PATH, then in `%ProgramFiles%\nodejs\node.exe`. Each candidate is
  run, and one older than Node 22.13 is rejected, so the version is reported by the launcher rather
  than as an import error inside `dist/`.
- **Line endings.** `.gitattributes` checks out every text file with LF and the `.cmd` files with CRLF.
- **Windows status.**
  - The MCP server resolves `scripts/launch` to `launch.cmd` in Claude Code's Windows build.
  - Whether exec-form hooks resolve to their `.cmd` twin there has not been verified yet. If they don't,
    the hooks fail to start, and a hook that fails to start does not block.
  - The Bash guards match the `Bash` tool only. On a Windows machine without Git Bash, Claude Code runs
    shell commands through its PowerShell tool, which those guards are not written for.
  - CI runs every suite on Linux, macOS, and Windows (`.github/workflows/test.yml`).

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
      "include": ["app"],
      "aliases": [{ "path": "~/src/my-shared-package", "include": ["src"] }]
    }
  ]
}
```

Each entry in `indexes` is a **project**:

| Field | Meaning |
|---|---|
| `name` | Handle listed in `scope` in tool calls. Must be unique. |
| `root` | The project's main root; it owns the index. `~` is expanded. |
| `aliases` | Extra roots of the same project, each `{ "path", "include"?, "exclude"? }`. Every query searches every root. An alias without its own `include`/`exclude` inherits the project's. |
| `adapter` | `auto` (detect from the root: a `.gpr` means `ghidra`, else the package manifest), `laravel`, `ghidra`, `phoenix`, `node`. Default `auto`. |
| `include` | Directories scanned in each root. Laravel's default is `["app", "bootstrap", "config", "routes"]`. |
| `exclude` | Extra directories to skip, merged with `globalExclude` and adapter defaults. A name skips that directory at any depth; a root-relative path containing `/` (like Laravel's default `bootstrap/cache`) skips that path. |
| `options` | Per-adapter settings. Laravel accepts `bindingPaths` as an alias for `include`. |
| `enabled` | Set `false` to keep an entry without loading it. |
| `defaultIndex` | Project used when a tool call omits `scope`. Required once you configure more than one. |
| `globalExclude` | Directory names skipped in every project. |
| `notesDir` | Where notes are stored. Default `~/.config/stackmap/notes`. |
| `plans` | `{ "dir": … }`, where plans are stored. Default `~/.config/stackmap/plans`. The path must be absolute or start with `~/`; an unknown key is an error. |

Index entries are validated one at a time. An unknown or misspelled key, or any other invalid field,
leaves that entry out and names the problem in `stackmap_indexes`; the other projects still load. If
two entries share a name, the first is used, and every later one is reported in `stackmap_indexes`
and in the `caveats` of every query.

Add a project with the `stackmap_add_index` tool, or by editing the file, as long as its stack has an
adapter.

### Several roots in one project

- **Each file is indexed once.** It is grouped under the innermost root that contains it, with paths
  relative to that root, and real paths (symlinks resolved) decide what "the same file" is.
- **A child root's rules win.** When an alias sits inside another root, the alias's `include` and
  `exclude` decide which of its files are indexed. The parent's rules can't add or remove them.
- **Group order.** Alias groups come first, then the main root. An alias nested inside another alias
  comes before it (deepest first), and sibling aliases are in path order.
- **Contradictory rules are config errors.** A root whose own `include` names a directory its own
  `exclude` rules out invalidates that entry. An alias is checked against the lists it inherits.
  Excluded by `globalExclude` or an adapter default instead: not scanned, and a warning says so.
- **Laravel `composer.json` per root.**
  - An alias with no `composer.json` is indexed anyway, with a warning, because it has no PSR-4 map.
  - A main root with none, or any root whose `composer.json` can't be read, is an error for that root.
- **Note stamps record their root.** A note's file stamps resolve against the roots of the project
  named in the note's own `repo`.
  - A relative path is stamped in the one root that has it. If it's in two roots, that's an error;
    pass an absolute path to say which.
  - A stamp in an alias records that alias. If the alias is later removed, drift reports the file as
    `unresolved`, with the reason.
  - `note_write` with relative files and no resolvable project is an error.

## Tools

Every `stackmap_*` query takes `scope`: a list of project names, searched in order, each across all
of its roots. When `scope` is omitted, the query uses `defaultIndex`, or the only enabled project.
Each project answers on its own. A project that can't answer (an unreachable root, an adapter
without the needed capability) appears as `{ index, error }`, and the others still answer. Arguments
a tool doesn't declare are errors; the old `index` argument says it was replaced by `scope`.

### `stackmap_indexes`
Lists configured projects with their detected stack, their roots with per-root counts and warnings,
and structure counts. Reports per-project errors (missing root, unimplemented adapter) without failing
the whole call, and lists config entries that were not loaded under `notLoaded`.

### `stackmap_add_index`
`{ name, root, include?, exclude?, aliases? }` adds a project to the config file that is in use, or
creates the first resolution candidate when none exists. The JSON is edited as written, so `guard`,
`houseRules`, and every other entry are kept. It refuses:
- a name any existing entry already uses;
- an invalid entry;
- a root or alias that isn't an existing directory.

### `stackmap_resolve`
`{ symbol, scope? }` → per project, `files` (every place the symbol's source may live, each with its
`root`, root-relative `path`, and `exists`) plus every edge, in six separate fields:

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
`{ scope?, kind?, filter?, limit?, offset? }` → the resolution table as
`abstract → concrete → root/declaringFile:line`, each edge tagged with its `index` (project) and
`root`, joined across the projects in scope order. `limit` and `offset` page the joined list and must
be numbers when given. `totalByIndex` and `matchedByIndex` count per project; `errors` lists projects
that couldn't answer. `kind` selects what to return:

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

### `stackmap_get_function`
`{ name | address, scope?, limit?, disassembly? }` → per project, the matching compiled functions from
its Ghidra exports: `signature`, `pseudocode`, `callers`, `callees`, `data_refs`,
`computed_calls_unresolved`, and `disassembly` when asked for. Each match names its `program` and
`root`. `name` matches exactly first, then any name containing it; `address` accepts an entry or any
address inside a body. A function whose pseudocode is missing carries `decompile` and
`decompile_error`.

### `stackmap_get_type`
`{ name | path, scope?, limit?, depth? }` → a type's layout: `size`, `align`, `packing`, and `fields`
with `offset`, `size`, `type`, and `bit_offset`/`bit_size` for bitfields. A by-value member carries its
own `layout` up to `depth`. An anonymous union or struct has `name: null`, `anonymous: true`, and its
members in `layout` at offsets relative to the containing type. A program with no PDB or DWARF says so
instead of answering with nothing.

### `stackmap_xref`
`{ constant | string, scope?, limit?, context? }` → where a value is used, with surrounding
disassembly:

| `via` | What it means |
|---|---|
| `instruction operand` | a constant appears as an operand (decimal or hex, plus a negative value's two's complement) |
| `reference (TYPE)` | an instruction references the string |
| `pointer word (N bytes)` | a data word holds the string's address — one pointer hop, which is how PPC64 reaches a string with no direct reference |
| `reference (TYPE) to the pointer word 0x…` | an instruction reads that word |

A **PHP project** answers the same tool from its source instead, with `file`, `line` and `column`:

| `via` | What it means |
|---|---|
| `string literal (exact)` / `(contains)` | a quoted string, matched whole or as a substring |
| `… (interpolated)` | the literal interpolates (`"$name"`), so its run-time text isn't what is written |
| `number literal` | a number in any base PHP writes — `416`, `0x1a0`, `0b1101`, `0o777`, `0755` — compared by value |

A literal inside a comment is not a use. Heredoc bodies and backtick strings are stepped over, and the
caveats say how many, alongside how many files were searched.

A string is matched exactly first, then as a case-insensitive substring. Byte-pattern search is not
offered, because an export carries instructions, strings, pointers and types, not raw memory.

### Ghidra projects

A root holding a `.gpr` is a Ghidra project directory, and each alias is another one. **stackmap never
runs Ghidra.** You run the shipped export script yourself, read-only, and stackmap reads what it wrote:

```bash
analyzeHeadless <project dir> <project name> -process <program> -readOnly -noanalysis \
  -scriptPath /path/to/stackmap/ghidra_scripts -postScript StackmapExport.java [decompile_timeout=60]
```

- **Where the export goes.** Beside the `.gpr`, in `<project name>.stackmap/<program>.json`, which is
  where stackmap looks. One file per program; a project may hold several.
- **What it holds.** Functions (signature, pseudocode or the reason there is none, callers, callees, data
  references, unresolved computed calls), every instruction with its operands and references, strings —
  including runs Ghidra never defined — data words that point at strings, type layouts, and memory
  blocks.
- **The index.** On first use stackmap builds `<export>.sqlite` beside the export by streaming it, and
  rebuilds it whenever the export changes. A 201 MB export indexes in about 7 seconds.
- **Staleness.** Each export records its program's database file. Saving that program in Ghidra makes
  every later answer carry a stale caveat naming what changed; the answer still comes, because it is
  evidence of what the project said. If the project can't be read, the caveat says freshness is unknown.
- **`include`/`exclude` don't apply** to a Ghidra index and are refused: there is no source tree to scan.
- **Ownership.** Ghidra refuses to open a project owned by another OS user, so the export must be run by
  whoever owns it.

## Notes

Notes are conclusions that outlive a session. Each one is a markdown file in `notesDir`; a typed note
also has a data file beside it. Every note tool reports files in `notesDir` that can't be read as
notes under `malformedFiles`, rather than skipping them.

### `note_write`
`{ title, body, files?, tags?, repo?, status?, supersedes?, id?, verified_on?, schema?, data? }`
- `files` are content-hashed when the note is written, so a later read can report drift.
- `supersedes` ids must exist; they are demoted and back-linked.
- `id` defaults to a slug of the title. Passing an existing id updates that note. An id containing
  `/`, `\`, or `..` is an error.
- `verified_on` is an ISO 8601 date or date-time; default now.
- `schema` + `data` make a **typed note**. `data` is validated against the shipped schema and stored as
  `<id>.json`. `schema` and `data` go together.
  - Updating a typed note without them keeps its record.
  - An untyped note can become typed.
  - A typed note can't change schema: write a new note and supersede the old one.

### `note_search`
`{ query, repo?, include_retracted?, limit? }` → notes ranked by BM25, weighted by status and drift,
with `caveat`, `drift`, and `schema`. Typed notes are searchable by every key and value in their data:
numbers, hex values, and short tokens like `u32` are kept whole, and dotted or dashed values also match
by their parts (`CRC-32` → `crc`, `32`).

### `note_get`, `note_supersede`
`note_get { id }` returns the note, its drift, and for a typed note its record and `validation`.
`note_supersede { old_id, new_id }` links two existing notes; nothing is changed if either is missing.

### `note_schemas`
Lists the shipped schemas with their version, description, and JSON Schema:

| Schema | Shape |
|---|---|
| `struct_field_list@2` | `{ name, size, align (null when unknown), fields: [{ name, offset, size, type, bit_offset?, bit_size?, layout? }] }`, with offsets and sizes in bytes |
| `offset_table@1` | `{ subject, base, entries: [{ name, offset (hex string like "0x1A0"), size? }] }` |
| `algorithm_params@1` | `{ algorithm, variant, site, params: [{ name, value (string, number, boolean, or null) }] }` |

A schema's shape changes only with a new version. A record written under another version, or one that
no longer validates, is reported rather than read as current.

### `note_query`
`{ schema, filter?, repo?, include_retracted?, limit?, offset? }` → the typed records of one schema
that match `filter`, data exactly as stored, sorted by id. Default limit 100. Retracted records are
left out unless asked for and counted in `excludedRetracted`. Records that don't validate are listed in
`invalid` with the reason and issues.

```json
{ "operator": "and", "conditions": [
  { "parameter": "fields[].type", "comparator": "STARTS_WITH", "value": "uint" },
  { "operator": "or", "conditions": [
    { "parameter": "size", "comparator": "GREATER_THAN", "value": 8 },
    { "parameter": "fields[].bit_size", "comparator": "EXISTS" }
  ] }
] }
```

- **Groups** are `{ operator: "and" | "or", conditions: [...] }` and nest. Empty `conditions` matches
  everything.
- **Parameters** are field names joined by `.`. `name[]` means any element of the list `name`. A
  parameter the schema doesn't have is an error that lists the valid fields.
- **Comparators:** `EQUAL` `NOT_EQUAL`, `LIKE` `NOTLIKE` (substring), `IN` `NOTIN` (a list),
  `STARTS_WITH` `NOT_STARTS_WITH`, `ENDS_WITH` `NOT_ENDS_WITH`, `REGEX` `NOT_REGEX`, `EXISTS`
  `MISSING` (no value), `LESS_THAN` `LESS_THAN_EQUAL` `GREATER_THAN` `GREATER_THAN_EQUAL`.
- **Through `[]`,** a condition holds when any element matches. The negated forms (`NOT_*`, `NOTLIKE`,
  `NOTIN`, `MISSING`) hold when no element matches.
- **Case:** string comparisons and regexes are case-insensitive. Ranges compare numbers numerically
  and strings as text, case-sensitively. A number never compares with a string.
- **Presence:** `EXISTS` needs a non-null value. A key present with `null` counts as `MISSING`; use
  `EQUAL null` to find nulls.

## Plans

Nested plans with tracked tasks, kept outside any repo so they carry across sessions, `/clear`,
`/compact`, and resume. Opening a child plan pauses its parent at a named task; closing the child
makes the parent active again there.

- **Storage.** One JSON file per plan under `plans.dir` (default `~/.config/stackmap/plans`).
  `scripts/plan-store.mjs` owns the format and the rules, for the server and the hooks alike. A file
  that can't be read as a plan is listed in `malformedFiles`, never skipped.
- **Identity.** The server can't tell which session is calling: its environment keeps the startup
  session id after `/clear`. The `plan-identity` hook stamps the current session (and subagent) into
  every `plan_*` call as `_stackmap`, replacing anything the model sent, and fails closed. The server
  refuses a call without the stamp. No permission decision is made, so your normal prompts apply.
- **Ownership.** A plan belongs to one session. Another session's changes are refused until it calls
  `plan_select` with `take_over: true`, which moves the plan's whole open tree. A subagent acts under
  its parent's session.
- **Tasks** are `todo`, `doing`, or final: `done` (needs `evidence`), or `not_needed`,
  `wont_deliver`, `already_done` (only through `plan_resolve_task`, which Claude Code asks you to
  approve on every call).
- **Closing** is refused while a task isn't final, a child plan is open, or the deliverable is
  missing: `in-place` needs nothing, `document` needs a readable file, `branch` needs the branch with
  commits beyond its base.

| Tool | Does |
|---|---|
| `plan_status` | this session's active plan, open tasks, parent chain, open children; paused, delivered, and draft plans |
| `plan_create` | a root plan, made active (refused if one is already active) |
| `plan_create_child` | a child of the active plan, pausing it at `from_task` (required) |
| `plan_select` | make a plan active, pausing the current one; `take_over` moves another session's plan here |
| `plan_get`, `plan_list` | one record with its parents; plans filtered by `status`, `project`, `owner` (`"me"`), `under` |
| `plan_add_task`, `plan_update_task` | add tasks; change text or move between `todo`, `doing`, `done` |
| `plan_resolve_task` | set `not_needed`, `wont_deliver`, or `already_done` with your quoted words |
| `plan_close` | close a plan and resume its parent |

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
- `scripts/guard <script.mjs>` (or `guard.cmd` on Windows) wraps every guardrail and accepts only
  `[a-z0-9-]+.mjs` names.
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

## Review, double-blind, and the auditor

- **`stackmap:adversarial-auditor`** tries to falsify one claim against the real code, commands,
  and tests. It runs in its own worktree (which Claude Code starts at the remote's default branch)
  and checks out the ref the brief names, or `main`. Its report ends with `Claim`, `Audited at: <ref>@<sha>`, `Verdict`
  (FALSIFIED, SURVIVED, or UNTESTED), one or more `Reproducer` groups (`Command`, `Expected`,
  `Actual`), `Tested`, `Grade`, `Unchecked`, and, for UNTESTED, `Needs`. FALSIFIED and SURVIVED must
  be graded PROVEN and carry at least one Reproducer; without one the verdict is UNTESTED.
- **`/review`** reviews along independent axes and sends its highest-severity and reasoning-only
  findings to the auditor. Its closing block adds an `Audited:` count.
- **`/double-blind`** has 2–3 agents answer one falsifiable claim by different methods, blind to
  each other, then always audits the leading answer. It closes with the claim, the base, each
  method's grade, the audit verdict, and what remains unverified.

Both skills ask which ref to use when none is named and the current branch isn't `main`.

`audit-check` (SubagentStop, auditor only) keeps the auditor running until its report is complete
and every Reproducer on a FALSIFIED or SURVIVED verdict matches its own transcript
(`agent_transcript_path`):
- the command must be one the auditor actually ran with Bash. Spacing, quoting style and line
  continuations may differ; words and arguments may not. The comparison uses the Bash guards' shell
  parser.
- `Actual` must be an exact run of whole lines from that command's recorded output. Failed commands
  count, and output saved to the session's `tool-results/` is read from the saved file.

What the auditor can't fix is surfaced to the user instead of blocking:
- a missing transcript path, or a transcript that can't be read;
- a command the shell parser rejects;
- `Actual` that fell in the part of a long failed command's output cut from the transcript;
- a result still unwritten after re-reading every 5 s for 50 s (the hook's timeout is 60 s).

The message includes the auditor's report and asks the user for the missing context. The hook proves a
command ran and printed those lines, not that it tests the claim.

`skill-arm` (UserPromptSubmit) arms a session marker when a prompt invokes `/review` or
`/double-blind`. Background-task notifications, which also arrive as prompts and carry an agent's
output, never arm it. `skill-check` (Stop) keeps the turn going until its closing block is complete.

Each hook blocks once and names what is missing; if the retry is still incomplete, the turn or agent
ends and the user is told what is missing.

## Informational hooks

`freshness` (SessionStart), `house-rules`, `fetch-sanity` (PostToolUse), `skill-arm` /
`skill-check` (UserPromptSubmit / Stop), and `audit-check` (SubagentStop) run through
`scripts/hook-open <script.mjs>` (or `hook-open.cmd` on Windows) and fail open: a failure exits 1 with a `systemMessage` for the
user and never blocks a session, prompt, tool result, or turn. A `git fetch` that fails at session
start is stated in the freshness context.

Per-session state (skill markers) lives in `~/.stackmap/sessions`, or under `$STACKMAP_STATE`
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
- **Per-process memoization.** The adapter memoizes within a server process. Changing a project's
  config (roots, rules, adapter, options) rebuilds it on the next query. Changed source files are
  not re-read until you restart or call `stackmap_indexes`.
- **Excludes also apply to configured directories.** An `include` directory ruled out by
  `globalExclude` or an adapter default exclude is not scanned, and a warning says so. The same
  contradiction within one entry's own lists is a config error. Include directories that don't
  exist, and ones that can't be read, are listed as warnings too.
- **A Ghidra export is a snapshot, and only as good as the analysis behind it.** A function Ghidra never
  found isn't in it, pseudocode reflects the project's state at export time (including any wrong
  `noreturn` flags), and a program saved since is answered with a stale caveat rather than re-read.
- **Pointer words are scanned in initialized, non-executable blocks only.** A pointer built at runtime,
  or held in code, is not among them, and the caveats say so on every string search.
- **No byte-pattern search for compiled programs.** An export carries instructions, strings, pointers
  and types, not raw memory.
- **A zero-length member is reported as such.** Ghidra can report a struct ending in a flexible array as
  shorter than its debug info says (4 bytes in a PDB, 3 in Ghidra, measured), so that member carries a
  caveat.
- **Hex strings range as text.** `note_query` compares `"0x9"` above `"0x10"` and `"0xA"` below
  `"0xa"`. Zero-pad hex values to one width and one case if you'll filter them by range.
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
npm run plugin-test        # hooks.json wiring, launcher twins and line endings, names, and closing-block drift
npm run shell-tokens-test  # the shell parser the Bash guards evaluate
npm run guard-test         # destructive-command and commit-message rules, plan-identity stamping, the guard launcher
npm run truncate-test      # no-truncate
npm run suppress-test      # no-suppress and the suppression catalog
npm run house-rules-test   # house rules: extend/replace/disable, and every failure path
npm run hooks-test         # the hook-open launcher, freshness, fetch sanity, config.example.json
npm run skill-check-test   # closing blocks for /review and /double-blind
npm run audit-test         # the auditor's report check
npm run cli-test           # every sm subcommand: output, counts, --json, exit codes
npm run config-test        # config resolution, per-entry validation, scope, detection, roots, caching, add-index
npm run extract-test       # PHP extractors + adapter wiring, including several roots, on inline fixtures
npm run notes-test         # note store and file format, stamps across roots, typed notes, note_query, the data tokenizer
npm run ghidra-test        # the export reader, the SQLite index, staleness, and the adapter, on inline fixtures
npm run plans-test         # the plan store: config section, validation, nesting, ownership, closing
npm run smoke              # every MCP tool over stdio on Laravel fixtures, including scope, aliases, plans, and failure paths
```

Every suite uses temporary config, state, and fixtures, so none needs or reads your own config.
`config-test`, `extract-test`, `notes-test`, and `smoke` need `npm run build` first. Suites run the
launchers through `cross-spawn`, which on Windows resolves an extensionless launcher to its `.cmd` twin
the same way Claude Code does for the MCP server.

## Layout

```
src/
  config.ts            config schema (per-entry validation), resolution, project and scope selection, adding a project
  index.ts             MCP server — tool definitions, argument checks, and dispatch
  args.ts              tool argument type checks: numbers, strings, string lists, booleans
  notes/store.ts       note files and typed data files, file stamping, drift, caching
  notes/search.ts      BM25 over an inverted index, and the data tokenizer
  notes/schemas.ts     the shipped typed-note schemas and record validation
  notes/query.ts       note_query filters: parsing against a schema, and matching
  notes/tools.ts       note_* tool handlers
  plans/tools.ts       plan_* tool handlers over scripts/plan-store.mjs
  types/layout.ts      the type layout shape struct_field_list stores
  php/psr4.ts          composer.json PSR-4 -> symbol/file mapping, both directions
  php/uses.ts          namespace + use-statement parsing, short-name expansion
  php/bindings.ts      container + contextual binding extraction
  php/declarations.ts  class/interface/trait/enum declarations and their extends/implements
  php/literals.ts      string and number literals, with where each is written (what a source xref searches)
  adapters/types.ts    StackAdapter, IndexedAdapter capabilities, roots and file refs — the seam new stacks implement
  adapters/laravel.ts  Laravel adapter, across a project's roots
  adapters/registry.ts stack detection, root resolution, adapter caching, capability checks
  adapters/scope.ts    runs a query across the projects in scope, one outcome each
  adapters/ghidra/     compiled programs: the export format, its streaming reader, the SQLite index, staleness, and the adapter
  adapters/walk.ts     directory walker honouring excludes, reporting what it couldn't walk
scripts/
  hook-lib.mjs         hook wire protocol: deny, block, context, visible errors, state dir
  hook-config.mjs      the `guard` and `houseRules` config sections, strictly validated
  shell-tokens.mjs     shell parser shared by the Bash guards
  guard.mjs            destructive commands and commit messages
  no-truncate.mjs      truncated command output
  no-suppress.mjs      check-silencing edits
  suppression-rules.mjs  the suppression catalog
  house-rules.mjs      house rules injection
  plan-store.mjs       plans: the `plans` config section, record format, lifecycle rules (a library; types in plan-store.d.mts)
  plan-identity.mjs    stamps the calling session into every plan_* call
  deliverables.mjs     closing blocks for the skills and the auditor, and their checks
  skill-arm.mjs / skill-check.mjs  closing-block enforcement for /review and /double-blind
  audit-check.mjs      the auditor's report check, Reproducers verified against its transcript
  agent-transcript.mjs reads a subagent transcript's Bash calls and results (a library, not a hook)
  guard, hook-open     fail-closed / fail-open wrappers (sh), each with a .cmd twin for Windows
  launch               MCP server launcher (sh), with launch.cmd
  find-node.sh / find-node.cmd  node resolution for the sh / .cmd launchers
  cli/                 the sm CLI
ghidra_scripts/
  StackmapExport.java  the read-only export script you run in Ghidra; stackmap only reads its output
agents/
  adversarial-auditor.md
skills/
  recall/, review/, double-blind/
house-rules/
  default.md           the shipped default ruleset
```

To add a stack, implement `StackAdapter` and register a factory in `adapters/registry.ts`.
