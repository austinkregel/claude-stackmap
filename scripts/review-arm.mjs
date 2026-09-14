#!/usr/bin/env node
/**
 * UserPromptSubmit hook: arm review enforcement when the prompt explicitly invokes the review skill.
 * Arming only on explicit invocation, never on output text, keeps it from firing on ordinary work.
 *
 * Fails open, visibly: a failure to arm never blocks a prompt, but it is reported.
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
