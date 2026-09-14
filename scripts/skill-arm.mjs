#!/usr/bin/env node
/**
 * UserPromptSubmit hook: arm closing-block enforcement for each skill in ENFORCED_SKILLS that the
 * prompt explicitly invokes. Arming only on explicit invocation, never on output text, keeps it from
 * firing on ordinary work.
 *
 * Fails open, visibly: a failure to arm never blocks a prompt, but it is reported.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENFORCED_SKILLS } from "./deliverables.mjs";
import { readPayload, reportError, safeSessionId, sessionsDir } from "./hook-lib.mjs";

async function main() {
  const input = await readPayload();
  const prompt = String(input.prompt ?? input.user_prompt ?? "");
  const invoked = ENFORCED_SKILLS.filter((s) => s.trigger.test(prompt));
  if (invoked.length === 0) return;

  const names = invoked.map((s) => s.name).join(", ");
  const id = safeSessionId(input.session_id);
  if (!id) throw new Error(`${names} invoked, but the payload has no usable session_id; enforcement is NOT armed`);

  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  for (const skill of invoked) {
    writeFileSync(join(dir, `${id}.${skill.name}.json`), JSON.stringify({ armedAt: Date.now(), cwd: input.cwd ?? null }));
  }
}

main().catch((err) => reportError("skill-arm", `could not arm enforcement — ${err?.message ?? err}`));
