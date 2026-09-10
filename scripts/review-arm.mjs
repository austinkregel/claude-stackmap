#!/usr/bin/env node
/**
 * UserPromptSubmit hook: arm review enforcement when the review skill is invoked.
 *
 * Arming on an explicit invocation (rather than guessing from output text) is what keeps this
 * precise. The guard fires only for turns the user actually asked to be reviews, so it cannot
 * misfire on ordinary work — the same precision lesson as excluding `git merge-base`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".config", "stackmap", "sessions");
const TRIGGER = /(^|\s)\/(stackmap:)?review(\s|$)/i;

async function main() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  const input = JSON.parse(raw);
  const prompt = String(input.prompt ?? input.user_prompt ?? "");
  if (!TRIGGER.test(prompt)) return;
  const id = String(input.session_id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${id}.review.json`), JSON.stringify({ armedAt: Date.now(), cwd: input.cwd ?? null }));
}
main().catch(() => process.exit(0)); // arming is best-effort; never block a prompt
