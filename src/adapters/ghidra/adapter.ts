import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { IndexConfig } from "../../config.js";
import type {
  AdapterFactory,
  AdapterStats,
  CompiledFunction,
  CompiledTypeLayout,
  Detection,
  FunctionLookup,
  IndexedAdapter,
  IndexRoot,
  RootStats,
  TypeLayoutField,
  TypeLookup,
  XrefHit,
  XrefSearch,
} from "../types.js";
import { keyOf } from "./address.js";
import { exportFreshness, openIndex, type OpenIndex } from "./index-open.js";
import type { Freshness } from "./project.js";

/**
 * Serves a Ghidra project from the JSON export written beside its `.gpr`. stackmap never runs Ghidra:
 * the agent that owns the project runs `ghidra_scripts/StackmapExport.java` and stackmap reads the
 * result (see CLAUDE.md).
 *
 * Each root of the index — the main root and every alias — is a Ghidra project directory, and each may
 * hold several programs, so every answer names the program and the root it came from. An export whose
 * project has been saved since is still answered, with a `stale` caveat, because the old answer is
 * evidence of what the project said, not a guess.
 */
const EXPORT_DIR_SUFFIX = ".stackmap";

interface LoadedExport {
  root: IndexRoot;
  /** The export file, relative to its root, so no absolute path ends up in an answer. */
  file: string;
  path: string;
  program: string;
  index: OpenIndex;
  freshness: Freshness;
}

const gprFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".gpr")).sort();
  } catch {
    return [];
  }
};

/** Every `*.json` under an export directory, in path order. */
function exportFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".json")) out.push(path);
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  return out;
}

class GhidraAdapter implements IndexedAdapter {
  readonly id = "ghidra" as const;
  readonly resolve = null;
  private loaded: LoadedExport[] | null = null;
  private loadWarnings: string[] = [];

  constructor(private readonly cfg: IndexConfig, private readonly roots: IndexRoot[]) {}

  get functions(): FunctionLookup {
    return { getFunction: (q) => this.getFunction(q) };
  }
  get types(): TypeLookup {
    return { getType: (q) => this.getType(q) };
  }
  get xref(): XrefSearch {
    return { findRefs: (q) => this.findRefs(q) };
  }

  /** Open every export of every root once. Indexes are built here on first use. */
  private async exports(): Promise<LoadedExport[]> {
    if (this.loaded) return this.loaded;
    const loaded: LoadedExport[] = [];
    const warnings: string[] = [];
    for (const root of this.roots) {
      const projects = gprFiles(root.path);
      if (projects.length === 0) warnings.push(`${root.kind} ${root.configured}: no .gpr file, so it is not a Ghidra project directory`);
      for (const gpr of projects) {
        const dir = join(root.path, `${basename(gpr, ".gpr")}${EXPORT_DIR_SUFFIX}`);
        const files = exportFiles(dir);
        if (files.length === 0) {
          warnings.push(
            `${root.kind} ${root.configured}: ${gpr} has no export in ${basename(dir)}/. ` +
              `Run ghidra_scripts/StackmapExport.java on that project (read-only) to create one.`,
          );
          continue;
        }
        for (const path of files) {
          const index = await openIndex(path);
          const program = (index.meta.get("program") as { path?: string } | undefined)?.path;
          if (typeof program !== "string") throw new Error(`${path}: no program.path, so this export can't be attributed to a program`);
          loaded.push({ root, file: relative(root.path, path), path, program, index, freshness: exportFreshness(index.meta, path) });
        }
      }
    }
    this.loadWarnings = warnings;
    this.loaded = loaded;
    return loaded;
  }

  /** What a caller must be told about an export before trusting an answer from it. */
  private caveatsFor(e: LoadedExport): string[] {
    const out: string[] = [];
    if (e.freshness.state === "stale") out.push(`${e.program} (${e.root.configured}): ${e.freshness.reason}`);
    if (e.freshness.state === "unknown") out.push(`${e.program} (${e.root.configured}): the export's freshness can't be checked — ${e.freshness.reason}`);
    const counts = e.index.meta.get("counts") as { decompile_failed?: number; decompile_timeout?: number } | undefined;
    const failed = (counts?.decompile_failed ?? 0) + (counts?.decompile_timeout ?? 0);
    if (failed > 0) out.push(`${e.program}: ${failed} function(s) did not decompile in this export; their pseudocode is absent and each says why.`);
    return out;
  }

  stats(): AdapterStats {
    const roots: RootStats[] = this.roots.map((root) => {
      const mine = (this.loaded ?? []).filter((e) => e.root === root);
      const sum = (key: string) => mine.reduce((n, e) => n + Number(((e.index.meta.get("rows") as Record<string, number>) ?? {})[key] ?? 0), 0);
      return {
        kind: root.kind,
        configured: root.configured,
        path: root.path,
        filesScanned: mine.length,
        warnings: [...this.loadWarnings.filter((w) => w.startsWith(`${root.kind} ${root.configured}:`)), ...mine.flatMap((e) => this.caveatsFor(e))],
        projects: gprFiles(root.path).length,
        programs: mine.map((e) => e.program).join(", "),
        functions: sum("functions"),
        instructions: sum("instructions"),
        strings: sum("strings"),
        types: sum("types"),
      };
    });
    return {
      adapter: this.id,
      roots,
      exportsLoaded: (this.loaded ?? []).length,
      note: this.loaded === null ? "Counts appear once a lookup has opened the exports." : "",
    };
  }

  private async getFunction(query: { name?: string; address?: string; limit: number; context: number }): Promise<{ matches: CompiledFunction[]; total: number; caveats: string[] }> {
    const exports = await this.exports();
    const caveats = [...this.loadWarnings];
    const matches: CompiledFunction[] = [];
    let total = 0;
    for (const e of exports) {
      caveats.push(...this.caveatsFor(e));
      const db = e.index.db;
      // By address: the function starting there, or the one whose body contains it. By name: an exact
      // match first, then names containing it, since Ghidra names carry namespaces and templates.
      let rows: unknown[];
      if (query.address !== undefined) {
        rows = db.prepare("SELECT * FROM functions WHERE entry = ? OR entry IN (SELECT entry FROM function_bodies WHERE ? BETWEEN lo_key AND hi_key) ORDER BY entry_key")
          .all(query.address, keyOf(query.address, "stackmap_get_function: 'address'"));
      } else if (query.name !== undefined) {
        rows = db.prepare("SELECT * FROM functions WHERE name = ? OR name LIKE ? ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, entry_key").all(query.name, `%${query.name}%`, query.name);
      } else throw new Error("stackmap_get_function needs 'name' or 'address'.");
      total += rows.length;
      for (const row of rows.slice(0, Math.max(0, query.limit - matches.length)) as Record<string, unknown>[]) {
        const entry = row.entry as string;
        const name = (e: string) => (db.prepare("SELECT name FROM functions WHERE entry = ?").get(e) as { name?: string } | undefined)?.name ?? null;
        matches.push({
          program: e.program,
          root: e.root.configured,
          name: row.name as string,
          entry,
          size: row.size as number,
          signature: (row.signature as string) ?? null,
          calling_convention: (row.calling_convention as string) ?? null,
          noreturn: row.noreturn === 1,
          thunk_of: (row.thunk_of as string) ?? null,
          source: (row.source as string) ?? null,
          decompile: row.decompile as string,
          decompile_error: (row.decompile_error as string) ?? null,
          pseudocode: (row.pseudocode as string) ?? null,
          computed_calls_unresolved: row.computed_calls_unresolved as number,
          callers: (db.prepare("SELECT from_addr, from_fn FROM function_refs WHERE entry = ? AND is_call = 1 ORDER BY from_addr").all(entry) as Record<string, unknown>[])
            .map((r) => ({ from: r.from_addr as string, function: (r.from_fn as string) ?? null, name: r.from_fn ? name(r.from_fn as string) : null })),
          callees: (db.prepare("SELECT callee FROM function_callees WHERE entry = ? ORDER BY callee").all(entry) as { callee: string }[])
            .map((r) => ({ entry: r.callee, name: name(r.callee) })),
          data_refs: (db.prepare("SELECT from_addr, ref_type FROM function_refs WHERE entry = ? AND is_call = 0 ORDER BY from_addr").all(entry) as Record<string, unknown>[])
            .map((r) => ({ from: r.from_addr as string, type: r.ref_type as string })),
          disassembly: query.context === 0
            ? []
            : (db.prepare("SELECT addr, text FROM instructions WHERE fn = ? ORDER BY addr_key LIMIT ?").all(entry, query.context) as Record<string, unknown>[])
                .map((r) => ({ address: r.addr as string, text: r.text as string })),
        });
      }
    }
    return { matches, total, caveats: [...new Set(caveats)] };
  }

  private async getType(query: { name?: string; path?: string; limit: number; depth: number }): Promise<{ matches: CompiledTypeLayout[]; total: number; caveats: string[] }> {
    const exports = await this.exports();
    const caveats = [...this.loadWarnings];
    const matches: CompiledTypeLayout[] = [];
    let total = 0;
    for (const e of exports) {
      caveats.push(...this.caveatsFor(e));
      const info = (e.index.meta.get("program") as { info?: Record<string, string> } | undefined)?.info ?? {};
      const debug = Object.entries(info).filter(([k, v]) => /^(PDB|DWARF)/i.test(k) && v !== "false");
      let rows: unknown[];
      if (query.path !== undefined) rows = e.index.db.prepare("SELECT * FROM types WHERE path = ?").all(query.path);
      else if (query.name !== undefined) rows = e.index.db.prepare("SELECT * FROM types WHERE name = ? OR name LIKE ? ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, path").all(query.name, `%${query.name}%`, query.name);
      else throw new Error("stackmap_get_type needs 'name' or 'path'.");
      total += rows.length;
      if (rows.length === 0 && debug.length === 0) {
        caveats.push(
          `${e.program}: this program has no imported debug types (no PDB or DWARF in the export), ` +
            `so a type that only debug info would name cannot be found here.`,
        );
      }
      for (const row of rows.slice(0, Math.max(0, query.limit - matches.length)) as Record<string, unknown>[]) {
        matches.push(this.layoutOf(e, row, query.depth, new Set()));
      }
    }
    return { matches, total, caveats: [...new Set(caveats)] };
  }

  /** One type's layout, following by-value members while `depth` allows and guarding against cycles. */
  private layoutOf(e: LoadedExport, row: Record<string, unknown>, depth: number, seen: Set<string>): CompiledTypeLayout {
    const path = row.path as string;
    const caveats: string[] = [];
    const fields: TypeLayoutField[] = (e.index.db.prepare("SELECT * FROM type_fields WHERE path = ? ORDER BY ordinal").all(path) as Record<string, unknown>[]).map((f) => {
      const field: TypeLayoutField = {
        name: (f.name as string) ?? null,
        anonymous: f.name === null,
        offset: f.offset as number,
        size: f.size as number,
        type: (f.type as string) ?? null,
        comment: (f.comment as string) ?? null,
      };
      if (f.bit_offset !== null) field.bit_offset = f.bit_offset as number;
      if (f.bit_size !== null) field.bit_size = f.bit_size as number;
      if (field.size === 0) field.caveat = "Ghidra reports this member as zero length (a flexible array), and the containing type's size may be short by its element size.";
      const typePath = (f.type_path as string) ?? null;
      if (typePath && depth > 0 && !seen.has(typePath)) {
        const nested = e.index.db.prepare("SELECT * FROM types WHERE path = ?").get(typePath) as Record<string, unknown> | undefined;
        if (nested) field.layout = this.layoutOf(e, nested, depth - 1, new Set([...seen, path]));
      } else if (typePath && depth === 0 && (e.index.db.prepare("SELECT 1 FROM types WHERE path = ?").get(typePath) !== undefined)) {
        field.caveat = `${field.caveat ? `${field.caveat} ` : ""}Its own layout is not expanded here; ask for ${typePath} to see it.`;
      }
      return field;
    });
    if (fields.some((f) => f.anonymous)) {
      caveats.push("An anonymous member has no name; its own members are in its `layout`, at offsets relative to this type.");
    }
    if (row.zero_length === 1) caveats.push("Ghidra reports this type as zero length.");
    return {
      program: e.program,
      root: e.root.configured,
      name: row.name as string,
      path,
      kind: row.kind as string,
      size: row.size as number,
      align: (row.alignment as number) ?? null,
      packing: row.explicit_packing === -1 ? null : (row.explicit_packing as number),
      source_archive: (row.source_archive as string) ?? null,
      description: (row.description as string) ?? null,
      fields,
      caveats,
    };
  }

  private async findRefs(query: { constant?: string; string?: string; limit: number; context: number }): Promise<{ hits: XrefHit[]; total: number; caveats: string[] }> {
    const exports = await this.exports();
    const caveats = [...this.loadWarnings];
    const hits: XrefHit[] = [];
    let total = 0;
    for (const e of exports) {
      caveats.push(...this.caveatsFor(e));
      const db = e.index.db;
      // The matched instruction plus `context` instructions on each side of it, in address order.
      const context = (addr: string) => {
        if (query.context === 0) return [];
        const key = keyOf(addr, "an instruction address in the export");
        const before = db.prepare("SELECT addr, text, addr_key FROM instructions WHERE addr_key <= ? ORDER BY addr_key DESC LIMIT ?").all(key, query.context + 1) as Record<string, unknown>[];
        const after = db.prepare("SELECT addr, text, addr_key FROM instructions WHERE addr_key > ? ORDER BY addr_key LIMIT ?").all(key, query.context) as Record<string, unknown>[];
        return [...before.reverse(), ...after].map((r) => ({ address: r.addr as string, text: r.text as string }));
      };
      const fnOf = (addr: string) => {
        const row = db.prepare("SELECT f.entry, f.name FROM instructions i JOIN functions f ON f.entry = i.fn WHERE i.addr = ?").get(addr) as { entry?: string; name?: string } | undefined;
        return row?.entry ? { entry: row.entry, name: row.name as string } : null;
      };
      const push = (hit: XrefHit) => {
        total++;
        if (hits.length < query.limit) hits.push(hit);
      };

      if (query.constant !== undefined) {
        const forms = constantForms(query.constant);
        for (const row of db.prepare(`SELECT addr, scalar FROM instruction_scalars WHERE scalar IN (${forms.map(() => "?").join(",")}) ORDER BY addr`).all(...forms) as Record<string, unknown>[]) {
          push({ program: e.program, root: e.root.configured, kind: "constant", matched: row.scalar as string, value: row.scalar as string, address: row.addr as string, function: fnOf(row.addr as string), via: "instruction operand", context: context(row.addr as string) });
        }
      }

      if (query.string !== undefined) {
        const strings = db.prepare("SELECT address, value, defined FROM strings WHERE value = ? OR value LIKE ? ORDER BY CASE WHEN value = ? THEN 0 ELSE 1 END, address_key")
          .all(query.string, `%${query.string}%`, query.string) as Record<string, unknown>[];
        if (strings.length === 0) caveats.push(`${e.program}: no string matching ${JSON.stringify(query.string)} in this export.`);
        for (const s of strings) {
          const at = s.address as string;
          for (const row of db.prepare("SELECT r.addr, r.ref_type FROM instruction_refs r JOIN instructions i ON i.addr = r.addr WHERE r.to_addr = ? ORDER BY i.addr_key").all(at) as Record<string, unknown>[]) {
            push({ program: e.program, root: e.root.configured, kind: "string", matched: at, value: s.value as string, address: row.addr as string, function: fnOf(row.addr as string), via: `reference (${row.ref_type})`, context: context(row.addr as string) });
          }
          // One pointer hop: a data word holding the string's address, and any instruction that reads
          // that word. On PPC64 this is how a string is reached, with no direct reference at all.
          for (const hop of db.prepare("SELECT address, width FROM pointer_hits WHERE target = ? ORDER BY address_key").all(at) as Record<string, unknown>[]) {
            const word = hop.address as string;
            push({ program: e.program, root: e.root.configured, kind: "string", matched: at, value: s.value as string, address: word, function: null, via: `pointer word (${hop.width} bytes)`, context: [] });
            for (const row of db.prepare("SELECT r.addr, r.ref_type FROM instruction_refs r JOIN instructions i ON i.addr = r.addr WHERE r.to_addr = ? ORDER BY i.addr_key").all(word) as Record<string, unknown>[]) {
              push({ program: e.program, root: e.root.configured, kind: "string", matched: at, value: s.value as string, address: row.addr as string, function: fnOf(row.addr as string), via: `reference (${row.ref_type}) to the pointer word ${word}`, context: context(row.addr as string) });
            }
          }
        }
        const scanned = (e.index.meta.get("pointer_scan") as { blocks_scanned?: string[] } | undefined)?.blocks_scanned ?? [];
        caveats.push(`${e.program}: pointer words were scanned in ${scanned.length} initialized, non-executable block(s); a pointer built at runtime or held in code is not among them.`);
      }
    }
    return { hits, total, caveats: [...new Set(caveats)] };
  }
}

/** The forms a constant may appear as in an export's scalars, which are lower-case hex with no padding. */
export function constantForms(text: string): string[] {
  const trimmed = text.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  let value: bigint;
  try {
    value = /^0[xX]/.test(body) ? BigInt(body) : BigInt(body);
  } catch {
    throw new Error(`stackmap_xref: "${text}" is not a number; pass a decimal (4160) or hex (0x1040) constant.`);
  }
  if (negative) value = -value;
  const forms = new Set<string>();
  const add = (v: bigint) => {
    if (v >= 0n) forms.add(`0x${v.toString(16)}`);
  };
  add(value);
  // Ghidra records a scalar as an unsigned value of its operand's width, so a negative constant also
  // appears as its two's complement at 1, 2, 4 and 8 bytes.
  if (value < 0n) for (const bits of [8n, 16n, 32n, 64n]) add((1n << bits) + value);
  return [...forms];
}

export const ghidraFactory: AdapterFactory = {
  id: "ghidra",
  detect(root: string): Detection {
    const projects = gprFiles(root);
    if (projects.length === 0) return { matched: false, notes: [] };
    return { matched: true, notes: [`found ${projects.join(", ")}`] };
  },
  create(cfg: IndexConfig, roots: IndexRoot[]): IndexedAdapter {
    // A Ghidra root holds project files, not source, so include/exclude has nothing to act on.
    for (const key of ["include", "exclude"] as const) {
      if (cfg[key] !== undefined) throw new Error(`stackmap: index "${cfg.name}" is a Ghidra project, so "${key}" does not apply; remove it.`);
    }
    for (const alias of cfg.aliases) {
      if (alias.include !== undefined || alias.exclude !== undefined) {
        throw new Error(`stackmap: index "${cfg.name}" alias ${alias.path} is a Ghidra project, so "include"/"exclude" do not apply; remove them.`);
      }
    }
    return new GhidraAdapter(cfg, roots);
  },
};
