/**
 * note_query filters: nestable and/or groups of conditions, modelled on the comparator set of the
 * user's finance filter conditions. A filter is validated against the queried schema's JSON Schema
 * before it runs, so an unknown parameter or comparator is an error rather than a silent no-match.
 *
 *   group     = { operator: "and" | "or", conditions: [condition | group, ...] }   (empty = everything)
 *   condition = { parameter, comparator, value }
 *   parameter = segment ("." segment)*, segment = identifier ("[]")?   — "[]" means any element
 */

export const COMPARATORS = [
  "EQUAL", "NOT_EQUAL", "LIKE", "NOTLIKE", "IN", "NOTIN",
  "STARTS_WITH", "NOT_STARTS_WITH", "ENDS_WITH", "NOT_ENDS_WITH",
  "REGEX", "NOT_REGEX", "EXISTS", "MISSING",
  "LESS_THAN", "LESS_THAN_EQUAL", "GREATER_THAN", "GREATER_THAN_EQUAL",
] as const;
export type Comparator = (typeof COMPARATORS)[number];

interface Segment {
  key: string;
  each: boolean;
}

export interface Condition {
  kind: "condition";
  parameter: string;
  segments: Segment[];
  comparator: Comparator;
  value: unknown;
  regex: RegExp | null;
}

export interface Group {
  kind: "group";
  operator: "and" | "or";
  conditions: Array<Condition | Group>;
}

type Json = Record<string, unknown>;

const SEGMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\[\])?$/;
const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** Follow `$ref: "#"` and take the one non-null branch of a nullable `anyOf`; any other union can't be walked into. */
function settle(node: Json, root: Json, where: string): Json {
  let n = node;
  for (let guard = 0; guard < 16; guard++) {
    if (n.$ref === "#") n = root;
    else if (typeof n.$ref === "string" && n.$ref.startsWith("#/$defs/")) {
      const def = (root.$defs as Json | undefined)?.[n.$ref.slice("#/$defs/".length)];
      if (!isObject(def)) throw new Error(`filter: the schema's reference ${n.$ref} can't be resolved (at ${where})`);
      n = def;
    } else if (Array.isArray(n.anyOf)) {
      const branches = (n.anyOf as Json[]).filter((b) => b.type !== "null");
      if (branches.length !== 1) return n;
      n = branches[0]!;
    } else return n;
  }
  throw new Error(`filter: the schema's references at ${where} don't settle`);
}

function parsePath(parameter: string, root: Json): Segment[] {
  if (typeof parameter !== "string" || parameter === "") throw new Error("filter: a condition needs a non-empty 'parameter'");
  const segments: Segment[] = [];
  let node = root;
  let at = "(root)";
  for (const raw of parameter.split(".")) {
    const m = SEGMENT.exec(raw);
    if (!m) throw new Error(`filter: parameter "${parameter}" has an invalid segment "${raw}" — use field names, with [] for any element`);
    const [, key, each] = m;
    node = settle(node, root, at);
    const properties = node.properties as Json | undefined;
    if (node.type !== "object" || !isObject(properties)) {
      throw new Error(`filter: parameter "${parameter}": ${at} is not an object with fields`);
    }
    if (!(key! in properties)) {
      throw new Error(`filter: parameter "${parameter}": no field "${key}" at ${at}. Valid: ${Object.keys(properties).join(", ")}`);
    }
    node = settle(properties[key!] as Json, root, `${at}.${key}`);
    at = at === "(root)" ? key! : `${at}.${key}`;
    if (each) {
      if (node.type !== "array" || !isObject(node.items)) throw new Error(`filter: parameter "${parameter}": ${at} is not a list, so it can't take []`);
      node = node.items as Json;
      at = `${at}[]`;
    }
    segments.push({ key: key!, each: Boolean(each) });
  }
  return segments;
}

function parseCondition(raw: Json, root: Json, where: string): Condition {
  const known = new Set(["parameter", "comparator", "value"]);
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new Error(`filter: ${where} has an unknown key "${k}" (a condition takes parameter, comparator, value)`);
  const comparator = raw.comparator;
  if (typeof comparator !== "string" || !(COMPARATORS as readonly string[]).includes(comparator)) {
    throw new Error(`filter: ${where} has an unknown comparator ${JSON.stringify(comparator)}. Known: ${COMPARATORS.join(", ")}`);
  }
  const c = comparator as Comparator;
  const segments = parsePath(raw.parameter as string, root);
  const hasValue = "value" in raw;
  const value = raw.value;
  let regex: RegExp | null = null;
  const fail = (what: string) => {
    throw new Error(`filter: ${where} (${c} on "${raw.parameter}") ${what}`);
  };
  switch (c) {
    case "EXISTS":
    case "MISSING":
      if (hasValue) fail("takes no value");
      break;
    case "IN":
    case "NOTIN":
      if (!Array.isArray(value) || value.length === 0 || !value.every(isScalar)) fail("needs a non-empty list of strings, numbers, booleans, or null");
      break;
    case "LIKE":
    case "NOTLIKE":
    case "STARTS_WITH":
    case "NOT_STARTS_WITH":
    case "ENDS_WITH":
    case "NOT_ENDS_WITH":
      if (typeof value !== "string") fail("needs a string value");
      break;
    case "REGEX":
    case "NOT_REGEX":
      if (typeof value !== "string") fail("needs a string pattern");
      try {
        regex = new RegExp(value as string, "i");
      } catch (err) {
        fail(`has an invalid pattern: ${(err as Error).message}`);
      }
      break;
    case "LESS_THAN":
    case "LESS_THAN_EQUAL":
    case "GREATER_THAN":
    case "GREATER_THAN_EQUAL":
      if (typeof value !== "number" && typeof value !== "string") fail("needs a number or string value");
      break;
    case "EQUAL":
    case "NOT_EQUAL":
      if (!hasValue) fail("needs a value");
      break;
  }
  return { kind: "condition", parameter: raw.parameter as string, segments, comparator: c, value, regex };
}

function parseNode(raw: unknown, root: Json, where: string): Condition | Group {
  if (!isObject(raw)) throw new Error(`filter: ${where} must be an object (a group or a condition)`);
  if ("operator" in raw || "conditions" in raw) {
    for (const k of Object.keys(raw)) if (k !== "operator" && k !== "conditions") throw new Error(`filter: ${where} has an unknown key "${k}" (a group takes operator, conditions)`);
    if (raw.operator !== "and" && raw.operator !== "or") throw new Error(`filter: ${where} needs "operator": "and" or "or"`);
    if (!Array.isArray(raw.conditions)) throw new Error(`filter: ${where} needs a "conditions" list`);
    return { kind: "group", operator: raw.operator, conditions: raw.conditions.map((c, i) => parseNode(c, root, `${where}.conditions[${i}]`)) };
  }
  return parseCondition(raw, root, where);
}

/** Validate a filter against a schema's JSON Schema. An omitted filter matches everything. */
export function parseFilter(filter: unknown, schemaJson: Json): Group {
  if (filter === undefined) return { kind: "group", operator: "and", conditions: [] };
  const node = parseNode(filter, schemaJson, "filter");
  if (node.kind !== "group") throw new Error('filter: the top level must be a group: { "operator": "and" | "or", "conditions": [...] }');
  return node;
}

/** Every value a path reaches, branching at each []. A key that isn't there contributes nothing. */
function resolve(data: unknown, segments: Segment[]): unknown[] {
  let current: unknown[] = [data];
  for (const { key, each } of segments) {
    const next: unknown[] = [];
    for (const v of current) {
      if (!isObject(v) || !(key in v)) continue;
      const child = v[key];
      if (each) {
        if (Array.isArray(child)) next.push(...child);
      } else {
        next.push(child);
      }
    }
    current = next;
  }
  return current;
}

const fold = (s: string) => s.toLowerCase();

/** JSON equality, with strings compared case-insensitively. */
function looselyEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return fold(a) === fold(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => looselyEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && looselyEqual(a[k], b[k]));
  }
  return a === b;
}

function compare(v: unknown, bound: unknown): number | null {
  if (typeof v === "number" && typeof bound === "number") return v - bound;
  if (typeof v === "string" && typeof bound === "string") return v < bound ? -1 : v > bound ? 1 : 0;
  return null;
}

function positive(c: Condition, values: unknown[]): boolean {
  const str = (v: unknown): v is string => typeof v === "string";
  switch (c.comparator) {
    case "EQUAL":
    case "NOT_EQUAL":
      return values.some((v) => looselyEqual(v, c.value));
    case "IN":
    case "NOTIN":
      return values.some((v) => (c.value as unknown[]).some((w) => looselyEqual(v, w)));
    case "LIKE":
    case "NOTLIKE":
      return values.some((v) => str(v) && fold(v).includes(fold(c.value as string)));
    case "STARTS_WITH":
    case "NOT_STARTS_WITH":
      return values.some((v) => str(v) && fold(v).startsWith(fold(c.value as string)));
    case "ENDS_WITH":
    case "NOT_ENDS_WITH":
      return values.some((v) => str(v) && fold(v).endsWith(fold(c.value as string)));
    case "REGEX":
    case "NOT_REGEX":
      return values.some((v) => str(v) && c.regex!.test(v));
    case "EXISTS":
    case "MISSING":
      // A key present with a null value counts as missing.
      return values.some((v) => v !== null);
    case "LESS_THAN":
      return values.some((v) => compare(v, c.value) !== null && compare(v, c.value)! < 0);
    case "LESS_THAN_EQUAL":
      return values.some((v) => compare(v, c.value) !== null && compare(v, c.value)! <= 0);
    case "GREATER_THAN":
      return values.some((v) => compare(v, c.value) !== null && compare(v, c.value)! > 0);
    case "GREATER_THAN_EQUAL":
      return values.some((v) => compare(v, c.value) !== null && compare(v, c.value)! >= 0);
  }
}

const NEGATED = new Set<Comparator>(["NOT_EQUAL", "NOTLIKE", "NOTIN", "NOT_STARTS_WITH", "NOT_ENDS_WITH", "NOT_REGEX", "MISSING"]);

export function matches(data: unknown, node: Condition | Group): boolean {
  if (node.kind === "group") {
    if (node.conditions.length === 0) return true;
    return node.operator === "and" ? node.conditions.every((c) => matches(data, c)) : node.conditions.some((c) => matches(data, c));
  }
  const hit = positive(node, resolve(data, node.segments));
  return NEGATED.has(node.comparator) ? !hit : hit;
}
