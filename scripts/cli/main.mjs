#!/usr/bin/env node
import { jsonl } from "./jsonl.mjs";
import { csv } from "./csv.mjs";
import { slice } from "./slice.mjs";
import { wait } from "./wait.mjs";
import { dupes } from "./dupes.mjs";

const COMMANDS = { jsonl, csv, slice, wait, dupes };

const USAGE = `sm — stackmap CLI

  sm jsonl <file...>  [--where k=v] [--pick a,b] [--count] [--limit N] [--jq-ish path]
  sm csv   <file...>  [--where k=v] [--select a,b] [--count] [--limit N] [--delim ,]
  sm slice <file>     --lines A-B | --bytes A-B | --head N | --tail N
  sm wait  --cmd '<shell>' [--until '<regex>'] [--fail '<regex>'] [--every S] [--timeout S]
  sm dupes <dir>      detect byte-identical / signature-identical .jsonl files

Every command reports counts (read, matched, skipped, errors) so a filter can never
silently drop rows the way a hand-typed one-liner does.
Use --json for machine-readable output on any command.`;

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || cmd === "-h" || cmd === "--help" || !COMMANDS[cmd]) {
  console.log(USAGE);
  process.exit(cmd && !COMMANDS[cmd] ? 2 : 0);
}
try {
  const code = await COMMANDS[cmd](argv.slice(1));
  process.exit(code ?? 0);
} catch (err) {
  console.error(`sm ${cmd}: ${err?.message ?? err}`);
  process.exit(1);
}
