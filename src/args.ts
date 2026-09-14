/** A number argument of at least `min`, the default when absent; anything else is an error, not a silent default. */
export function countArg(tool: string, name: string, value: unknown, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new Error(`${tool}: '${name}' must be a number of at least ${min}, got ${JSON.stringify(value)}.`);
  }
  return Math.trunc(value);
}
