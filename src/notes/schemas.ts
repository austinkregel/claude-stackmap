import { z } from "zod";
import { TypeLayoutSchema } from "../types/layout.js";

/**
 * The typed-note schemas shipped with the plugin. A schema's shape never changes under the same
 * version: notes-test pins a fingerprint of each name@version's JSON Schema, so a change without a
 * version bump fails. Records written under another version are reported, never re-read as current.
 */
export interface NoteSchema {
  name: string;
  version: number;
  description: string;
  zod: z.ZodType;
}

const HEX = /^0x[0-9a-fA-F]+$/;

export const NOTE_SCHEMAS: readonly NoteSchema[] = [
  {
    name: "struct_field_list",
    version: 1,
    description: "A type's layout: name, size and align (null when unknown), and fields {name, offset, size, type, bit_offset?, bit_size?, layout?}, recursing into by-value nested types. Offsets and sizes are byte counts.",
    zod: TypeLayoutSchema,
  },
  {
    name: "offset_table",
    version: 1,
    description: "Named offsets into a region: subject (what the offsets index into), base (what offset 0 is relative to), and entries {name, offset (hex string, e.g. \"0x1A0\"), size? (byte count)}.",
    zod: z.strictObject({
      subject: z.string().min(1),
      base: z.string().min(1),
      entries: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            offset: z.string().regex(HEX, "must be a hex string like 0x1A0"),
            size: z.number().int().nonnegative().optional(),
          }),
        )
        .min(1),
    }),
  },
  {
    name: "algorithm_params",
    version: 1,
    description: "An algorithm as used somewhere: algorithm (name), variant (which spec/variant), site (function, symbol, or address where it is used), and params {name, value (string, number, boolean, or null)}.",
    zod: z.strictObject({
      algorithm: z.string().min(1),
      variant: z.string().min(1),
      site: z.string().min(1),
      params: z.array(z.strictObject({ name: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) })),
    }),
  },
];

export function noteSchema(name: string): NoteSchema {
  const hit = NOTE_SCHEMAS.find((s) => s.name === name);
  if (!hit) throw new Error(`note schema "${name}" is unknown. Known: ${NOTE_SCHEMAS.map((s) => s.name).join(", ")}.`);
  return hit;
}

const jsonCache = new Map<string, Record<string, unknown>>();

/** The schema as JSON Schema, for the model to read and for filter paths to be checked against. */
export function schemaJson(schema: NoteSchema): Record<string, unknown> {
  const key = `${schema.name}@${schema.version}`;
  let json = jsonCache.get(key);
  if (!json) {
    json = z.toJSONSchema(schema.zod) as Record<string, unknown>;
    jsonCache.set(key, json);
  }
  return json;
}

export interface RecordIssue {
  path: string;
  message: string;
}

export type RecordCheck =
  | { valid: true }
  | { valid: false; reason: "unknown-schema" | "other-version" | "fails-validation"; message: string; issues: RecordIssue[] };

const issuesOf = (error: z.ZodError): RecordIssue[] => error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));

/** Whether stored data is a valid record of the shipped schema, at the version it was written under. */
export function checkRecord(name: string, version: number, data: unknown): RecordCheck {
  const schema = NOTE_SCHEMAS.find((s) => s.name === name);
  if (!schema) return { valid: false, reason: "unknown-schema", message: `schema "${name}" is not shipped with this plugin`, issues: [] };
  if (version !== schema.version) {
    return { valid: false, reason: "other-version", message: `written under ${name}@${version}; this plugin ships ${name}@${schema.version}`, issues: [] };
  }
  const parsed = schema.zod.safeParse(data);
  if (!parsed.success) return { valid: false, reason: "fails-validation", message: `does not validate against ${name}@${version}`, issues: issuesOf(parsed.error) };
  return { valid: true };
}

/** Validate data for a write; throws listing every issue plus the schema, so the caller can fix it. */
export function validateForWrite(name: string, data: unknown): NoteSchema {
  const schema = noteSchema(name);
  const parsed = schema.zod.safeParse(data);
  if (!parsed.success) {
    const issues = issuesOf(parsed.error).map((i) => `  - ${i.path}: ${i.message}`).join("\n");
    throw new Error(`note_write: data does not validate against ${name}@${schema.version}:\n${issues}\nSchema:\n${JSON.stringify(schemaJson(schema))}`);
  }
  return schema;
}
