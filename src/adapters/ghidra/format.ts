/**
 * The contract with `ghidra_scripts/StackmapExport.java`. FORMAT_VERSION must equal the constant of
 * the same name in that file; plugin-test compares them, so a change to either without the other
 * fails the suite rather than producing an export stackmap misreads.
 */
export const FORMAT_VERSION = 2;

/** Sections of an export that hold one row each, in the order the script writes them. */
export const ROW_SECTIONS = ["memory_blocks", "strings", "pointer_hits", "types", "instructions", "functions"] as const;

/** Everything else at the top level: single values or small objects. */
export const VALUE_KEYS = [
  "format_version",
  "exporter",
  "project",
  "program_database",
  "program",
  "undefined_string_min_length",
  "pointer_scan",
  "counts",
  "export_seconds",
] as const;

export type RowSection = (typeof ROW_SECTIONS)[number];
