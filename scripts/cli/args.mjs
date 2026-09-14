/** Minimal flag parser. Returns { flags, positionals }. */
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positionals.push(a);
  }
  return { flags, positionals };
}

/**
 * A numeric flag, or undefined when absent. Anything that isn't a finite number at or above `min`
 * (and a whole number when `integer`) throws, so a typo can't silently disable a limit.
 */
export function numberFlag(flags, name, { min = 0, integer = false } = {}) {
  if (!(name in flags)) return undefined;
  const raw = flags[name];
  const n = raw === true ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new Error(`--${name} expects ${integer ? "a whole number" : "a number"} of at least ${min}, got ${raw === true ? "no value" : `"${raw}"`}`);
  }
  return n;
}

/** `--where k=v` (repeatable via comma) -> predicate over a row object. */
export function buildPredicate(where) {
  if (!where || where === true) return () => true;
  const clauses = String(where).split(",").map((c) => {
    const m = /^([^=!~]+)(=|!=|~)(.*)$/.exec(c.trim());
    if (!m) throw new Error(`bad --where clause "${c.trim()}" (expected key=value, key!=value, or key~regex)`);
    const [, k, op, v] = m;
    return { k: k.trim(), op, v };
  });
  return (row) => clauses.every(({ k, op, v }) => {
    const actual = row?.[k];
    const s = actual === undefined || actual === null ? "" : String(actual);
    if (op === "=") return s === v;
    if (op === "!=") return s !== v;
    return new RegExp(v).test(s);
  });
}

export function project(row, pick) {
  if (!pick || pick === true) return row;
  const keys = String(pick).split(",").map((k) => k.trim()).filter(Boolean);
  const out = {};
  for (const k of keys) out[k] = row?.[k];
  return out;
}

/** Uniform stats footer. */
export function report(stats, asJson) {
  if (asJson) { console.log(JSON.stringify({ _stats: stats })); return; }
  const parts = Object.entries(stats).map(([k, v]) => `${k}=${v}`);
  console.error(`-- ${parts.join(" ")}`);
}
