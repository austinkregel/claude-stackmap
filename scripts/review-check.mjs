#!/usr/bin/env node
/**
 * Stop hook: a review turn may not end without a SHA-stamped, falsifiable claim.
 *
 * A review that never prints the sha it read cannot be checked afterwards, and reviewing a
 * stale cached branch looks identical to reviewing the right one. Guidance in a skill is
 * advisory; this makes it a precondition for ending the turn. Fires only for turns armed by
 * review-arm.mjs.
 *
 * Runs through hook-open.sh and fails OPEN on internal errors, visibly: a Stop hook that throws
 * must never trap the session. The escape valves below are each pinned by review-test.mjs.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { blockStop, readPayload, reportError, safeSessionId, sessionsDir } from "./hook-lib.mjs";

const STAMP = /reviewed at\s+[`"']?[0-9a-f]{7,40}/i;
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // an arm older than this is stale, not an open review

async function main() {
  const input = await readPayload();
  const id = safeSessionId(input.session_id);
  if (!id) return; // nothing could have been armed for a session with no id

  const marker = join(sessionsDir(), `${id}.review.json`);
  if (!existsSync(marker)) return; // unarmed turns are untouched

  const clear = () => unlinkSync(marker);

  let armedAt = 0;
  try {
    armedAt = JSON.parse(readFileSync(marker, "utf8")).armedAt ?? 0;
  } catch {
    armedAt = 0; // a corrupt marker is treated as stale, never as an open review
  }
  if (!armedAt || Date.now() - armedAt > MAX_AGE_MS) return clear();

  // Another Stop hook already blocked this turn — do not block again, or the hooks bounce it forever.
  if (input.stop_hook_active === true) return clear();

  const finalText = String(input.last_assistant_message ?? "");
  if (STAMP.test(finalText)) return clear();

  // The marker deliberately survives a block, so the retry is still enforced.
  blockStop(
    "This turn was invoked as a review but the final message carries no SHA stamp, so its claims " +
      "are not falsifiable. Add a closing line in the form:\n\n" +
      "  Reviewed at <sha>, <N> uncommitted file(s) present, <timestamp>.\n" +
      "  Axes covered: <list>. Axes skipped: <list, with why>.\n" +
      "  Verification: <what was actually run>.\n\n" +
      "Get the sha with `git rev-parse --short HEAD`. If you reviewed a PR, confirm it matches the " +
      "PR head rather than a cached local branch.",
  );
}

main().catch((err) => reportError("review-check", `review enforcement did not run — ${err?.message ?? err}`));
