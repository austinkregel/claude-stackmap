/**
 * Tool argument checks. A value of the wrong type is an error that shows the value as JSON, never
 * coerced (an object must not become "[object Object]", a "false" string must not become true) and
 * never replaced by a default. Absent (undefined) is the only case that gets the default.
 */

/** An argument value as it was passed, for error messages. */
export function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/** A number argument of at least `min`, the default when absent. */
export function countArg(tool: string, name: string, value: unknown, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new Error(`${tool}: '${name}' must be a number of at least ${min}, got ${show(value)}.`);
  }
  return Math.trunc(value);
}

/** A string argument, undefined when absent. Blank strings are errors unless `allowBlank`. */
export function stringArg(tool: string, name: string, value: unknown, opts: { allowBlank?: boolean } = {}): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || (!opts.allowBlank && value.trim() === "")) {
    throw new Error(`${tool}: '${name}' must be a ${opts.allowBlank ? "" : "non-empty "}string, got ${show(value)}.`);
  }
  return value;
}

/** A list of non-empty strings, undefined when absent. Every bad entry is named. */
export function stringListArg(tool: string, name: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${tool}: '${name}' must be a list of non-empty strings, got ${show(value)}.`);
  const bad = value.flatMap((v, i) => (typeof v === "string" && v.trim() !== "" ? [] : [`${name}[${i}] = ${show(v)}`]));
  if (bad.length) throw new Error(`${tool}: every entry in '${name}' must be a non-empty string; ${bad.join(", ")}.`);
  return value as string[];
}

/** A boolean argument, the default when absent. */
export function booleanArg(tool: string, name: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${tool}: '${name}' must be true or false, got ${show(value)}.`);
  return value;
}
