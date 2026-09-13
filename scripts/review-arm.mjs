#!/usr/bin/env node
/**
 * UserPromptSubmit hook: arm review enforcement when the review skill is invoked.
 *
 * Arming on an explicit invocation (rather than guessing from output text) is what keeps this
 * precise. The guard fires only for turns the user actually asked to be reviews, so it cannot
 * misfire on ordinary work — the same precision lesson as excluding `git merge-base`.
 *
 * Informational: a failure to arm must never block a prompt, but it is reported visibly rather
 * than swallowed, because an unarmed review looks identical to an armed one until it ends.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPayload, reportError, safeSessionId, sessionsDir } from "./hook-lib.mjs";

const TRIGGER = /(^|\s)\/(stackmap:)?review(\s|$)/i;

async function main() {
  const input = await readPayload();
  const prompt = String(input.prompt ?? input.user_prompt ?? "");
  if (!TRIGGER.test(prompt)) return;

  const id = safeSessionId(input.session_id);
  if (!id) throw new Error("review invoked, but the payload has no usable session_id; enforcement is NOT armed");

  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.review.json`), JSON.stringify({ armedAt: Date.now(), cwd: input.cwd ?? null }));
}

main().catch((err) => reportError("review-arm", `could not arm review enforcement — ${err?.message ?? err}`));
