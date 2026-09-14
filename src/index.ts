#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { addIndex, loadConfig, selectIndex, selectScope, configCandidates, duplicateCaveats, expandPath, type Config } from "./config.js";
import { getAdapter, clearAdapterCache, detectAdapter, requireCapability, resolveRoots } from "./adapters/registry.js";
import { acrossScope } from "./adapters/scope.js";
import type { EdgeKind, ResolutionEdge } from "./adapters/types.js";
import { existsSync } from "node:fs";
import { NoteStore, type RootsLookup } from "./notes/store.js";
import { noteWrite, noteSearch, noteGet, noteSupersede } from "./notes/tools.js";

const SCOPE_ARG = {
  scope: {
    type: "array",
    items: { type: "string" },
    minItems: 1,
    description: "Project names to search, in order; every root of each project is searched. Omit to use defaultIndex, or the only enabled project.",
  },
} as const;

const TOOLS = [
  {
    name: "stackmap_indexes",
    description:
      "List the configured projects, their roots, their detected stack, and structure counts, plus any config entries that were not loaded. Use this first when unsure which project to query.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "stackmap_add_index",
    description:
      "Add a project to the stackmap config file (created if none exists). Refuses a name already used by any entry. Other config sections are kept as written.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique project name." },
        root: { type: "string", description: "The project's main root directory. `~` is expanded." },
        include: { type: "array", items: { type: "string" }, description: "Directories to scan, relative to each root. Adapter defaults when omitted." },
        exclude: { type: "array", items: { type: "string" }, description: "Directory names (or root-relative paths with a /) never scanned." },
        aliases: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, include: { type: "array", items: { type: "string" } }, exclude: { type: "array", items: { type: "string" } } },
            required: ["path"],
            additionalProperties: false,
          },
          description: "Extra roots of the same project; without their own include/exclude they inherit the project's.",
        },
      },
      required: ["name", "root"],
      additionalProperties: false,
    },
  },
  {
    name: "stackmap_resolve",
    description:
      "Resolve a class/interface name to its files and every edge stackmap has for it, per project in scope, kept in separate fields because they are different kinds of evidence: " +
      "`implementedBy`/`implements` are container bindings only; `subtypes`/`supertypes` are PHP `extends`/`implements` declarations; " +
      "`injections`/`injectedInto` are contextual when()->needs()->give() overrides. Every file carries the root it belongs to. " +
      "Read `caveats` before treating any empty list as 'nothing does this' — runtime-computed binding sites and unscanned directories are reported there.",
    inputSchema: {
      type: "object",
      properties: {
        ...SCOPE_ARG,
        symbol: { type: "string", description: "Class or interface name, fully qualified (e.g. App\\\\Contracts\\\\FooContract)." },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
  {
    name: "stackmap_bindings",
    description:
      "Return the resolution table as abstract -> concrete -> root/declaringFile:line, across every project in scope, each edge tagged with its project. Defaults to the container binding table: global bindings plus " +
      "contextual when()->needs()->give() overrides (which carry a `context` — the class being resolved). " +
      "Pass kind='declaration' for PHP extends/implements edges, or kind='contextual' to answer 'what gets injected into X'. " +
      "Edges with `computedAbstract: true` are sites whose abstract is decided at runtime; `inferredFrom` marks an edge derived from an iterated const rather than written literally.",
    inputSchema: {
      type: "object",
      properties: {
        ...SCOPE_ARG,
        kind: {
          type: "string",
          enum: ["bindings", "container", "contextual", "declaration", "all"],
          description: "Which edge kinds to return. Default 'bindings' = container + contextual.",
        },
        filter: { type: "string", description: "Case-insensitive substring matched against abstract, concrete, context, and declaring file." },
        limit: { type: "number", description: "Max rows to return (default 100)." },
        offset: { type: "number", description: "Rows to skip in the joined list, for paging (default 0)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "note_write",
    description:
      "Record a durable cross-session conclusion. Stamps the content hash of every file the conclusion is about, so a later search can report whether the code has changed underneath it. Use this instead of leaving a finding only in the current conversation.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short statement of the conclusion." },
        body: { type: "string", description: "The conclusion, the evidence for it, and how it was verified." },
        files: { type: "array", items: { type: "string" }, description: "Files this conclusion is about; each is content-hashed at write time. Relative paths resolve against the roots of the project named by 'repo'." },
        tags: { type: "array", items: { type: "string" } },
        repo: { type: "string", description: "Project this applies to (a configured project name)." },
        status: { type: "string", enum: ["current", "superseded", "retracted"], description: "Default current. Use retracted for a recorded wrong turn — it is kept at low weight so it is not repeated." },
        supersedes: { type: "array", items: { type: "string" }, description: "Note ids this replaces; they are demoted and back-linked automatically." },
        id: { type: "string", description: "Stable id. Omit to derive from the title; pass an existing id to update." },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "note_search",
    description:
      "Search prior cross-session conclusions. Results are ranked by standing (current > superseded > retracted) and demoted when the files a conclusion describes have changed since it was written. Check this BEFORE re-investigating something.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free text. Omit to list everything by standing." },
        repo: { type: "string" },
        include_retracted: { type: "boolean", description: "Include recorded wrong turns (default false)." },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "note_get",
    description: "Fetch one note by id, with a per-file report of whether its subject files have changed since it was written.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "note_supersede",
    description: "Mark one note as superseded by another. The old note is demoted, not deleted — the earlier belief is still evidence.",
    inputSchema: {
      type: "object",
      properties: { old_id: { type: "string" }, new_id: { type: "string" } },
      required: ["old_id", "new_id"], additionalProperties: false,
    },
  },
] as const;

const KIND_SETS: Record<string, EdgeKind[]> = {
  bindings: ["container", "contextual"],
  container: ["container"],
  contextual: ["contextual"],
  declaration: ["declaration"],
  all: ["container", "contextual", "declaration"],
};

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}
function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Arguments a tool doesn't declare are errors, never ignored; `index` gets its own message. */
function checkArguments(tool: string, args: Record<string, unknown>) {
  const def = TOOLS.find((t) => t.name === tool);
  if (!def) return;
  const known = Object.keys(def.inputSchema.properties);
  for (const key of Object.keys(args)) {
    if (known.includes(key)) continue;
    if (key === "index" && known.includes("scope")) throw new Error(`${tool}: "index" was replaced by "scope", a list of project names (e.g. "scope": ["my-app"]).`);
    throw new Error(`${tool}: unknown argument "${key}". Known: ${known.join(", ") || "(none)"}.`);
  }
}

/** A non-negative integer argument, the default when absent; anything else is an error. */
function countArg(tool: string, name: string, value: unknown, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new Error(`${tool}: '${name}' must be a number of at least ${min}, got ${JSON.stringify(value)}.`);
  }
  return Math.trunc(value);
}

/** The roots of a named project (or the default one), or why they can't be found. */
function rootsFor(config: Config, repo: string | null): RootsLookup {
  try {
    return { roots: resolveRoots(selectIndex(config, repo ?? undefined)) };
  } catch (err) {
    return { roots: null, reason: (err as Error).message };
  }
}

const server = new Server(
  { name: "stackmap", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as any[] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, any>;
  try {
    checkArguments(req.params.name, args);

    if (req.params.name === "stackmap_add_index") {
      const entry: Record<string, unknown> = { name: args.name, root: args.root };
      for (const key of ["include", "exclude", "aliases"]) if (args[key] !== undefined) entry[key] = args[key];
      if (typeof args.name === "string" && typeof args.root === "string") {
        // Check the directories now, so a bad root is reported when it's added rather than on first use.
        resolveRoots({ name: args.name, root: args.root, adapter: "auto", options: {}, enabled: true, aliases: Array.isArray(args.aliases) ? args.aliases : [] });
      }
      return text(addIndex(entry));
    }

    const { config, path } = loadConfig();

    if (req.params.name === "stackmap_indexes") {
      clearAdapterCache();
      if (config.indexes.length === 0 && config.indexErrors.length === 0) {
        return text({
          configPath: path,
          searched: configCandidates(),
          indexes: [],
          hint: `No indexes configured. Create ${configCandidates().at(-1)} — see config.example.json in the stackmap repo.`,
        });
      }
      const rows = config.indexes.map((idx) => {
        const root = expandPath(idx.root);
        if (!existsSync(root)) return { name: idx.name, root, enabled: idx.enabled, error: "root does not exist" };
        if (!idx.enabled) return { name: idx.name, root, enabled: false, detected: detectAdapter(root) };
        try {
          return { name: idx.name, enabled: true, ...getAdapter(config, idx).stats() };
        } catch (err) {
          return { name: idx.name, root, enabled: true, detected: detectAdapter(root), error: (err as Error).message };
        }
      });
      return text({ configPath: path, defaultIndex: config.defaultIndex ?? null, indexes: rows, notLoaded: config.indexErrors });
    }

    if (req.params.name.startsWith("note_")) {
      const store = NoteStore.fromConfig(config.notesDir);
      const lookup = (repo: string | null) => rootsFor(config, repo);
      if (req.params.name === "note_write") return text(noteWrite(store, args, lookup(args.repo ?? null)));
      if (req.params.name === "note_search") return text(noteSearch(store, args, lookup));
      if (req.params.name === "note_get") return text(noteGet(store, args, lookup));
      if (req.params.name === "note_supersede") return text(noteSupersede(store, args));
    }

    const scope = selectScope(config, args.scope);
    const caveats = duplicateCaveats(config);

    if (req.params.name === "stackmap_resolve") {
      if (typeof args.symbol !== "string" || !args.symbol.trim()) return failure("stackmap_resolve requires a non-empty 'symbol'.");
      const results = acrossScope(config, scope, (adapter, idx) => {
        const hit = requireCapability(adapter, "resolve", idx.name, "stackmap_resolve").resolveSymbol(args.symbol);
        const edgeCount =
          hit.implementedBy.length + hit.implements.length + hit.subtypes.length +
          hit.supertypes.length + hit.injections.length + hit.injectedInto.length;
        if (!hit.exists && edgeCount === 0) {
          return {
            ...hit,
            note: `No file and no edge found for "${hit.symbol}" in project "${idx.name}". ` +
              `Check the namespace, or run stackmap_indexes to confirm the project covers this code. ` +
              `This is not a claim that nothing implements it — see caveats.`,
          };
        }
        return hit;
      }).map((r) => ("value" in r ? { index: r.index, ...r.value } : r));
      return text({ scope: scope.map((s) => s.name), caveats, results });
    }

    if (req.params.name === "stackmap_bindings") {
      const kindArg = typeof args.kind === "string" ? args.kind : "bindings";
      const kinds = KIND_SETS[kindArg];
      if (!kinds) return failure(`stackmap_bindings: unknown kind "${kindArg}". Known: ${Object.keys(KIND_SETS).join(", ")}.`);
      const limit = countArg("stackmap_bindings", "limit", args.limit, 100, 1);
      const offset = countArg("stackmap_bindings", "offset", args.offset, 0, 0);
      const needle = typeof args.filter === "string" ? args.filter.toLowerCase() : null;
      const outcomes = acrossScope(config, scope, (adapter, idx) => requireCapability(adapter, "resolve", idx.name, "stackmap_bindings").resolutionTable(kinds));

      const totalByIndex: Record<string, number> = {};
      const matchedByIndex: Record<string, number> = {};
      const errors: Array<{ index: string; error: string }> = [];
      const matched: Array<ResolutionEdge & { index: string }> = [];
      for (const o of outcomes) {
        if ("error" in o) {
          errors.push(o);
          continue;
        }
        totalByIndex[o.index] = o.value.length;
        const hits = needle
          ? o.value.filter((e) =>
              e.abstract.toLowerCase().includes(needle) ||
              (e.concrete?.toLowerCase().includes(needle) ?? false) ||
              (e.context?.toLowerCase().includes(needle) ?? false) ||
              e.declaredIn.toLowerCase().includes(needle))
          : o.value;
        matchedByIndex[o.index] = hits.length;
        matched.push(...hits.map((e) => ({ index: o.index, ...e })));
      }
      const byKind: Record<string, number> = {};
      for (const e of matched) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      return text({
        scope: scope.map((s) => s.name),
        kind: kindArg,
        caveats,
        errors,
        total: Object.values(totalByIndex).reduce((a, b) => a + b, 0),
        totalByIndex,
        matched: matched.length,
        matchedByIndex,
        matchedByKind: byKind,
        computedAbstract: matched.filter((e) => e.computedAbstract).length,
        offset,
        limit,
        returned: Math.min(limit, Math.max(0, matched.length - offset)),
        edges: matched.slice(offset, offset + limit),
      });
    }

    return failure(`stackmap: unknown tool "${req.params.name}".`);
  } catch (err) {
    return failure((err as Error).message);
  }
});

await server.connect(new StdioServerTransport());
