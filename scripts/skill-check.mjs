#!/usr/bin/env node
/**
 * Stop hook: a turn armed by skill-arm.mjs may not end until the final message carries the closing
 * block of every skill it armed.
 *
 * A marker older than 6 hours, or corrupt, is stale and cleared. After one block
 * (`stop_hook_active`), the turn ends and the user is told what is still missing, so hooks never
 * bounce a turn forever. Fails open, visibly, on internal errors.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ENFORCED_SKILLS } from "./deliverables.mjs";
import { blockStop, notifyUser, readPayload, reportError, safeSessionId, sessionsDir } from "./hook-lib.mjs";

const HOOK = "skill-check";
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

async function main() {
  const input = await readPayload();
  const id = safeSessionId(input.session_id);
  if (!id) return; // nothing could have been armed for a session with no id

  const finalText = String(input.last_assistant_message ?? "");
  const unmet = [];
  for (const skill of ENFORCED_SKILLS) {
    const marker = join(sessionsDir(), `${id}.${skill.name}.json`);
    if (!existsSync(marker)) continue;

    let armedAt = 0;
    try {
      armedAt = JSON.parse(readFileSync(marker, "utf8")).armedAt ?? 0;
    } catch {
      armedAt = 0; // a corrupt marker is treated as stale, never as an open turn
    }
    if (!armedAt || Date.now() - armedAt > MAX_AGE_MS) {
      unlinkSync(marker);
      continue;
    }

    const missing = skill.problems(finalText);
    if (missing.length === 0 || input.stop_hook_active === true) unlinkSync(marker);
    if (missing.length) unmet.push({ skill, missing });
  }
  if (unmet.length === 0) return;

  if (input.stop_hook_active === true) {
    return notifyUser(
      HOOK,
      `the turn ended without a complete closing block — ${unmet.map((u) => `/${u.skill.name} still missing: ${u.missing.join("; ")}`).join(" | ")}`,
    );
  }

  // Markers survive a block, so the retry is still enforced.
  blockStop(
    unmet
      .map(
        (u) =>
          `This turn was invoked as /${u.skill.name}, but its final message is missing:\n\n` +
          u.missing.map((m) => `  - ${m}`).join("\n") +
          "\n\nClose the turn with:\n\n" +
          u.skill.form.split("\n").map((l) => `  ${l}`).join("\n"),
      )
      .join("\n\n"),
  );
}

main().catch((err) => reportError(HOOK, `closing-block enforcement did not run — ${err?.message ?? err}`));
