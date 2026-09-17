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
import { noteWrite, noteSearch, noteGet, noteSupersede, noteQuery, noteSchemas } from "./notes/tools.js";
import { NOTE_SCHEMAS } from "./notes/schemas.js";
import { countArg, stringArg } from "./args.js";
import { COMPARATORS } from "./notes/query.js";
import { openStore } from "../scripts/plan-store.mjs";
import {
  planAddTask, planClose, planCreate, planCreateChild, planGet, planList, planResolveTask, planSelect, planStatus, planUpdateTask,
} from "./plans/tools.js";

const SCOPE_ARG = {
  scope: {
    type: "array",
    items: { type: "string" },
    minItems: 1,
    description: "Project names to search, in order; every root of each project is searched. Omit to use defaultIndex, or the only enabled project.",
  },
} as const;

/** Declared on every plan_* tool so the hook's stamp passes argument checking. Never set it yourself. */
const STAMP_ARG = {
  _stackmap: {
    type: "object",
    description: "Caller identity, set by the stackmap plan-identity hook on every call. Do not set it; any value you pass is replaced.",
  },
} as const;

const DELIVERABLE_ARG = {
  type: "object",
  description:
    'What closing the plan produces: {"kind": "in-place"} for changes in the working copy; {"kind": "document", "path": "<absolute path>"} for a file for the user; ' +
    '{"kind": "branch", "repo": "<absolute repo path>", "base": "<ref the work starts from>", "branch": "<name>" | null} for a feature branch. Checked when the plan closes.',
} as const;

const PLAN_TOOLS = [
  {
    name: "plan_status",
    description:
      "This session's plans: the active plan with its open tasks, the parent plans above it (each with the task it resumes at), open child plans, and plans that are paused, delivered, or drafts. " +
      "The plan records are the source of truth; check this instead of relying on memory of the conversation.",
    inputSchema: { type: "object", properties: { ...STAMP_ARG }, additionalProperties: false },
  },
  {
    name: "plan_create",
    description: "Create a root plan and make it this session's active plan. Refused when the session already has an active plan: open a child with plan_create_child instead.",
    inputSchema: {
      type: "object",
      properties: {
        ...STAMP_ARG,
        title: { type: "string", description: "What the plan delivers." },
        deliverable: DELIVERABLE_ARG,
        tasks: { type: "array", items: { type: "string" }, description: "Steps, in order. More can be added with plan_add_task." },
        projects: { type: "array", items: { type: "string" }, description: "stackmap project names the plan touches." },
      },
      required: ["title", "deliverable"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_create_child",
    description:
      "Open a child plan when something discovered mid-plan deserves its own plan. The active plan is paused at 'from_task' and becomes active again when the child closes. " +
      "Use this instead of silently widening the current plan's scope.",
    inputSchema: {
      type: "object",
      properties: {
        ...STAMP_ARG,
        title: { type: "string", description: "What the child plan delivers." },
        from_task: { type: "string", description: "The active plan's task (e.g. t3) to resume at when the child closes. Required." },
        deliverable: DELIVERABLE_ARG,
        tasks: { type: "array", items: { type: "string" } },
        projects: { type: "array", items: { type: "string" } },
      },
      required: ["title", "from_task", "deliverable"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_select",
    description:
      "Make a plan this session's active plan; the currently active one is paused. A plan owned by another session moves here only with take_over: true, and then its whole open tree (parents and children) moves with it.",
    inputSchema: {
      type: "object",
      properties: {
        ...STAMP_ARG,
        id: { type: "string" },
        take_over: { type: "boolean", description: "Take ownership from another session (default false)." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_get",
    description: "Fetch one plan's full record, with its parent plans.",
    inputSchema: { type: "object", properties: { ...STAMP_ARG, id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "plan_list",
    description: "List plans, newest state per file, sorted by id. Closed plans are left out unless 'status' names closed. Unreadable plan files are listed in 'malformedFiles'.",
    inputSchema: {
      type: "object",
      properties: {
        ...STAMP_ARG,
        status: { type: "array", items: { type: "string", enum: ["draft", "active", "paused", "delivered", "closed"] } },
        project: { type: "string", description: "Only plans that list this project." },
        owner: { type: "string", description: 'A session id, or "me" for this session.' },
        under: { type: "string", description: "Only plans below this plan id (children, grandchildren, …)." },
        limit: { type: "number", description: "Max plans (default 50)." },
        offset: { type: "number", description: "Plans to skip, for paging (default 0)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "plan_add_task",
    description: "Add tasks to a plan you own, at the end or after a given task. Record every step here rather than only in the conversation.",
    inputSchema: {
      type: "object",
      properties: {
        ...STAMP_ARG,
        id: { type: "string", description: "Plan id." },
        tasks: { type: "array", items: { type: "string" }, minItems: 1 },
        after: { type: "string", description: "Insert after this task id; default is the end." },
      },
      required: ["id", "tasks"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_update_task",
    description:
      "Change a task's text, or move it between todo, doing, and done. Done needs 'evidence' (a test run, a commit sha, a file). " +
      "Final states other than done (not_needed, wont_deliver, already_done) go through plan_resolve_task, and only after the user says so.",
    inputSchema: {
      type: "object",
      properties: {
        ...STAMP_ARG,
        id: { type: "string", description: "Plan id." },
        task: { type: "string", description: "Task id, e.g. t2." },
        text: { type: "string" },
        state: { type: "string", enum: ["todo", "doing", "done"] },
        evidence: { type: "string", description: "Required with state done." },
      },
      required: ["id", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_resolve_task",
    description:
      "Mark tasks not_needed, wont_deliver, or already_done. Only after discussing it with the user and the user explicitly saying so: " +
      "'user_quote' must be the user's own words from this session, copied exactly, and the user is asked to approve every call. Never call this on your own initiative.",
    inputSchema: {
      type: "object",
      properties: {
        ...STAMP_ARG,
        id: { type: "string", description: "Plan id." },
        tasks: { type: "array", items: { type: "string" }, minItems: 1, description: "Task ids; all get the same state and reason." },
        state: { type: "string", enum: ["not_needed", "wont_deliver", "already_done"] },
        reason: { type: "string", description: "Why, in a sentence." },
        user_quote: { type: "string", description: "The user's words authorizing this, copied exactly from their message." },
      },
      required: ["id", "tasks", "state", "reason", "user_quote"],
      additionalProperties: false,
    },
    _meta: { "anthropic/requiresUserInteraction": true },
  },
  {
    name: "plan_close",
    description:
      "Close a plan. Refused while any task isn't final, any child plan is open, or the deliverable doesn't exist. When a child plan closes, its parent becomes active again at the task it was paused on.",
    inputSchema: {
      type: "object",
      properties: {
        ...STAMP_ARG,
        id: { type: "string" },
        summary: { type: "string", description: "What the plan delivered." },
      },
      required: ["id", "summary"],
      additionalProperties: false,
    },
  },
] as const;

const TOOLS = [
  ...PLAN_TOOLS,
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
        supersedes: { type: "array", items: { type: "string" }, description: "Note ids this replaces; they must exist, and they are demoted and back-linked automatically." },
        id: { type: "string", description: "Stable id. Omit to derive from the title; pass an existing id to update. Can't contain '/', '\\', or '..'." },
        verified_on: { type: "string", description: "ISO 8601 date or date-time the conclusion was verified. Default: now." },
        schema: {
          type: "string",
          enum: NOTE_SCHEMAS.map((s) => s.name),
          description: "Makes this a typed note: the record in 'data' is validated against this shipped schema (see note_schemas) and stored beside the note. Requires 'data'. An existing typed note can't change schema.",
        },
        data: { type: "object", description: "The typed record for 'schema', returned exactly as stored. Requires 'schema'. Omit both to keep an existing note's record." },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "note_query",
    description:
      "Return typed records of one schema that match a filter, exactly as stored, sorted by id. Unranked, unlike note_search. " +
      "Records that no longer validate are listed in 'invalid', and unreadable note files in 'malformedFiles' — neither is dropped silently.",
    inputSchema: {
      type: "object",
      properties: {
        schema: { type: "string", enum: NOTE_SCHEMAS.map((s) => s.name) },
        filter: {
          type: "object",
          description:
            'A group: { "operator": "and" | "or", "conditions": [condition | group, ...] } (empty conditions match everything). ' +
            'A condition: { "parameter": "fields[].type", "comparator": "EQUAL", "value": "u32" }. A parameter is dotted field names; "name[]" means any element of list "name". ' +
            `Comparators: ${COMPARATORS.join(", ")}. EXISTS/MISSING take no value; IN/NOTIN take a list. ` +
            "A value at any [] element counts; NOT_* and MISSING mean no element matches. Strings and REGEX are case-insensitive; ranges compare numbers numerically and strings as text. An unknown parameter or comparator is an error.",
        },
        repo: { type: "string", description: "Only records for this project (records with no repo also match, as in note_search)." },
        include_retracted: { type: "boolean", description: "Include retracted records (default false)." },
        limit: { type: "number", description: "Max records (default 100)." },
        offset: { type: "number", description: "Records to skip, for paging (default 0)." },
      },
      required: ["schema"],
      additionalProperties: false,
    },
  },
  {
    name: "note_schemas",
    description: "List the typed-note schemas shipped with stackmap, each with its version, description, and the JSON Schema a record must satisfy.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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

/** The roots of a named project (or the default one), or why they can't be found. */
function rootsFor(config: Config, repo: string | null): RootsLookup {
  try {
    return { roots: resolveRoots(selectIndex(config, repo ?? undefined)) };
  } catch (err) {
    return { roots: null, reason: (err as Error).message };
  }
}

/**
 * One note store per notes directory for the life of the process, so its caches actually serve
 * repeat calls. The config is re-read on every call; a changed notesDir gets a new store and the old
 * one's watcher is closed.
 */
let notes: { dir: string; store: NoteStore } | null = null;
function noteStoreFor(notesDir: string): NoteStore {
  const dir = expandPath(notesDir);
  if (notes?.dir === dir) return notes.store;
  notes?.store.close();
  notes = { dir, store: new NoteStore(dir) };
  return notes.store;
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

    if (req.params.name.startsWith("plan_")) {
      // The store reads its own config section on every call, so a changed plans.dir takes effect at once.
      const plans = openStore();
      if (req.params.name === "plan_status") return text(planStatus(plans, args));
      if (req.params.name === "plan_create") return text(planCreate(plans, args));
      if (req.params.name === "plan_create_child") return text(planCreateChild(plans, args));
      if (req.params.name === "plan_select") return text(planSelect(plans, args));
      if (req.params.name === "plan_get") return text(planGet(plans, args));
      if (req.params.name === "plan_list") return text(planList(plans, args));
      if (req.params.name === "plan_add_task") return text(planAddTask(plans, args));
      if (req.params.name === "plan_update_task") return text(planUpdateTask(plans, args));
      if (req.params.name === "plan_resolve_task") return text(planResolveTask(plans, args));
      if (req.params.name === "plan_close") return text(planClose(plans, args));
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

    if (req.params.name === "note_schemas") return text(noteSchemas());

    if (req.params.name.startsWith("note_")) {
      const store = noteStoreFor(config.notesDir);
      const lookup = (repo: string | null) => rootsFor(config, repo);
      if (req.params.name === "note_write") return text(noteWrite(store, args, lookup));
      if (req.params.name === "note_search") return text(noteSearch(store, args, lookup));
      if (req.params.name === "note_get") return text(noteGet(store, args, lookup));
      if (req.params.name === "note_supersede") return text(noteSupersede(store, args));
      if (req.params.name === "note_query") return text(noteQuery(store, args, lookup));
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
      const kindArg = stringArg("stackmap_bindings", "kind", args.kind) ?? "bindings";
      const kinds = KIND_SETS[kindArg];
      if (!kinds) return failure(`stackmap_bindings: unknown kind "${kindArg}". Known: ${Object.keys(KIND_SETS).join(", ")}.`);
      const limit = countArg("stackmap_bindings", "limit", args.limit, 100, 1);
      const offset = countArg("stackmap_bindings", "offset", args.offset, 0, 0);
      const needle = stringArg("stackmap_bindings", "filter", args.filter)?.toLowerCase() ?? null;
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
