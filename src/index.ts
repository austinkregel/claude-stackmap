#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, selectIndex, configCandidates, expandPath } from "./config.js";
import { getAdapter, clearAdapterCache, detectAdapter } from "./adapters/registry.js";
import type { EdgeKind } from "./adapters/types.js";
import { existsSync } from "node:fs";
import { NoteStore } from "./notes/store.js";
import { noteWrite, noteSearch, noteGet, noteSupersede } from "./notes/tools.js";

const INDEX_ARG = {
  index: { type: "string", description: "Configured index name. Optional when only one index exists or defaultIndex is set." },
} as const;

const TOOLS = [
  {
    name: "stackmap_indexes",
    description:
      "List the configured code indexes, their detected stack, and structure counts. Use this first when unsure which index to query.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "stackmap_resolve",
    description:
      "Resolve a class/interface name to its file and every edge stackmap has for it, kept in separate fields because they are different kinds of evidence: " +
      "`implementedBy`/`implements` are container bindings only; `subtypes`/`supertypes` are PHP `extends`/`implements` declarations; " +
      "`injections`/`injectedInto` are contextual when()->needs()->give() overrides. " +
      "Read `caveats` before treating any empty list as 'nothing does this' — runtime-computed binding sites and unscanned directories are reported there.",
    inputSchema: {
      type: "object",
      properties: {
        ...INDEX_ARG,
        symbol: { type: "string", description: "Class or interface name, fully qualified (e.g. App\\\\Contracts\\\\FooContract)." },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
  {
    name: "stackmap_bindings",
    description:
      "Return the resolution table as abstract -> concrete -> declaringFile:line. Defaults to the container binding table: global bindings plus " +
      "contextual when()->needs()->give() overrides (which carry a `context` — the class being resolved). " +
      "Pass kind='declaration' for PHP extends/implements edges, or kind='contextual' to answer 'what gets injected into X'. " +
      "Edges with `computedAbstract: true` are sites whose abstract is decided at runtime; `inferredFrom` marks an edge derived from an iterated const rather than written literally.",
    inputSchema: {
      type: "object",
      properties: {
        ...INDEX_ARG,
        kind: {
          type: "string",
          enum: ["bindings", "container", "contextual", "declaration", "all"],
          description: "Which edge kinds to return. Default 'bindings' = container + contextual.",
        },
        filter: { type: "string", description: "Case-insensitive substring matched against abstract, concrete, context, and declaring file." },
        limit: { type: "number", description: "Max rows to return (default 100)." },
        offset: { type: "number", description: "Rows to skip, for paging (default 0)." },
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
        files: { type: "array", items: { type: "string" }, description: "Files this conclusion is about; each is content-hashed at write time." },
        tags: { type: "array", items: { type: "string" } },
        repo: { type: "string", description: "Repo this applies to." },
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

const server = new Server(
  { name: "stackmap", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as any[] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, any>;
  try {
    const { config, path } = loadConfig();

    if (req.params.name === "stackmap_indexes") {
      clearAdapterCache();
      if (config.indexes.length === 0) {
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
      return text({ configPath: path, defaultIndex: config.defaultIndex ?? null, indexes: rows });
    }

    if (req.params.name.startsWith("note_")) {
      const store = NoteStore.fromConfig(config.notesDir);
      // Stamp against the selected index's repo root so relative note paths resolve identically later.
      let repoRoot: string | null = null;
      try { repoRoot = expandPath(selectIndex(config, args.repo).root); } catch { repoRoot = null; }
      if (req.params.name === "note_write") return text(noteWrite(store, args, repoRoot));
      if (req.params.name === "note_search") return text(noteSearch(store, args, repoRoot));
      if (req.params.name === "note_get") return text(noteGet(store, args, repoRoot));
      if (req.params.name === "note_supersede") return text(noteSupersede(store, args));
    }

    const idx = selectIndex(config, args.index);
    const adapter = getAdapter(config, idx);

    if (req.params.name === "stackmap_resolve") {
      if (typeof args.symbol !== "string" || !args.symbol.trim()) return failure("stackmap_resolve requires a non-empty 'symbol'.");
      const hit = adapter.resolveSymbol(args.symbol);
      const edgeCount =
        hit.implementedBy.length + hit.implements.length + hit.subtypes.length +
        hit.supertypes.length + hit.injections.length + hit.injectedInto.length;
      if (!hit.exists && edgeCount === 0) {
        return text({
          index: idx.name,
          ...hit,
          note: `No file and no edge found for "${hit.symbol}" in index "${idx.name}". ` +
            `Check the namespace, or run stackmap_indexes to confirm the index covers this repo. ` +
            `This is not a claim that nothing implements it — see caveats.`,
        });
      }
      return text({ index: idx.name, ...hit });
    }

    if (req.params.name === "stackmap_bindings") {
      const kindArg = typeof args.kind === "string" ? args.kind : "bindings";
      const kinds = KIND_SETS[kindArg];
      if (!kinds) return failure(`stackmap_bindings: unknown kind "${kindArg}". Known: ${Object.keys(KIND_SETS).join(", ")}.`);
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.trunc(args.limit)) : 100;
      const offset = Number.isFinite(args.offset) ? Math.max(0, Math.trunc(args.offset)) : 0;
      const all = adapter.resolutionTable(kinds);
      const needle = typeof args.filter === "string" ? args.filter.toLowerCase() : null;
      const matched = needle
        ? all.filter((e) =>
            e.abstract.toLowerCase().includes(needle) ||
            (e.concrete?.toLowerCase().includes(needle) ?? false) ||
            (e.context?.toLowerCase().includes(needle) ?? false) ||
            e.declaredIn.toLowerCase().includes(needle))
        : all;
      const byKind: Record<string, number> = {};
      for (const e of matched) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      return text({
        index: idx.name,
        kind: kindArg,
        total: all.length,
        matched: matched.length,
        matchedByKind: byKind,
        computedAbstract: matched.filter((e) => e.computedAbstract).length,
        offset,
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
