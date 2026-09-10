#!/usr/bin/env node
/**
 * Stop hook: a review turn may not end without a SHA-stamped, falsifiable claim.
 *
 * A review that never prints the sha it read cannot be checked afterwards, and reviewing a
 * stale cached branch looks identical to reviewing the right one. Guidance in a skill is
 * advisory; this makes it a precondition for ending the turn. Fires only for turns armed by
 * review-arm.mjs.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".config", "stackmap", "sessions");
const STAMP = /reviewed at\s+[`"']?[0-9a-f]{7,40}/i;
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // an arm older than this is stale, not an open review

async function main() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  const input = JSON.parse(raw);
  const id = String(input.session_id ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return;
  const marker = join(DIR, `${id}.review.json`);
  if (!existsSync(marker)) return;

  const clear = () => { try { unlinkSync(marker); } catch { /* already gone */ } };

  let armedAt = 0;
  try { armedAt = JSON.parse(readFileSync(marker, "utf8")).armedAt ?? 0; } catch { /* treat as stale */ }
  if (!armedAt || Date.now() - armedAt > MAX_AGE_MS) { clear(); return; }

  // Another Stop hook already blocked this turn — do not block again.
  if (input.stop_hook_active === true) { clear(); return; }

  const finalText = String(input.last_assistant_message ?? "");
  if (STAMP.test(finalText)) { clear(); return; } // requirement satisfied

  const reason =
    "This turn was invoked as a review but the final message carries no SHA stamp, so its claims " +
    "are not falsifiable. Add a closing line in the form:\n\n" +
    "  Reviewed at <sha>, <N> uncommitted file(s) present, <timestamp>.\n" +
    "  Axes covered: <list>. Axes skipped: <list, with why>.\n" +
    "  Verification: <what was actually run>.\n\n" +
    "Get the sha with `git rev-parse --short HEAD`. If you reviewed a PR, confirm it matches the " +
    "PR head rather than a cached local branch.";

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "Stop", block: true, blockReason: reason },
  }));
  process.stderr.write(reason + "\n");
  process.exit(2);
}
main().catch(() => process.exit(0)); // a broken check must not trap the session
