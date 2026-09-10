#!/usr/bin/env node
/** Regression suite for the PreToolUse guard, including its failure paths. */
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const guard = join(dirname(fileURLToPath(import.meta.url)), "guard.sh");
const BLOCK = 2, ALLOW = 0;
let failed = 0;

function run(payload, { raw = false } = {}) {
  const r = spawnSync(guard, { input: raw ? payload : JSON.stringify(payload), encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function check(label, expected, payload, opts) {
  const r = run(payload, opts);
  const ok = r.code === expected;
  if (!ok) failed++;
  const verdict = r.code === BLOCK ? "BLOCK" : r.code === ALLOW ? "allow" : `exit ${r.code}`;
  console.log(`${ok ? "PASS" : "FAIL"}  ${verdict.padEnd(5)} ${label}`);
  if (!ok) console.log(`        expected ${expected}, stderr: ${r.err.trim().slice(0, 160)}`);
}

const bash = (command, cwd = process.cwd()) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } });

console.log("-- precision: the read-only lookalikes must survive --");
check("git merge-base (read-only, must never be blocked)", ALLOW, bash("git merge-base origin/main HEAD"));
check("git merge-base --is-ancestor", ALLOW, bash("git merge-base --is-ancestor HEAD origin/main"));
check("push to a feature branch", ALLOW, bash("git push origin feature/some-work"));
check("force-with-lease is allowed", ALLOW, bash("git push --force-with-lease origin feature/x"));
check("ordinary migrate", ALLOW, bash("php artisan migrate --step"));
check("merge mentioned inside a string, not invoked", ALLOW, bash('echo "do not git merge here"'));
check("rm -rf on scratch (deliberately not blocked)", ALLOW, bash("rm -rf storage/tmp-3-output"));

console.log("\n-- the destructive forms must block --");
check("unrequested merge", BLOCK, bash("git merge origin/main --no-edit"));
check("merge inside a compound command", BLOCK, bash("cd /repo && git merge origin/main"));
check("push to develop via refspec", BLOCK, bash("git push origin HEAD:develop"));
check("push to main directly", BLOCK, bash("git push origin main"));
check("force push", BLOCK, bash("git push --force origin feature/x"));
check("force push short flag", BLOCK, bash("git push -f origin feature/x"));
check("hard reset", BLOCK, bash("git reset --hard HEAD~1"));
check("migrate:fresh (drops every table)", BLOCK, bash("php artisan migrate:fresh --seed"));
check("db:wipe", BLOCK, bash("php artisan db:wipe"));
check("DROP TABLE", BLOCK, bash("mysql -e 'DROP TABLE clients'"));

console.log("\n-- branch-aware rules --");
const repo = mkdtempSync(join(tmpdir(), "stackmap-guard-"));
try {
  execFileSync("git", ["init", "-q", "-b", "develop", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  check("commit while HEAD is on develop", BLOCK, bash("git commit -m wip", repo));
  check("implicit push while on develop", BLOCK, bash("git push", repo));
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature/x"]);
  check("commit on a feature branch", ALLOW, bash("git commit -m wip", repo));
  check("implicit push on a feature branch", ALLOW, bash("git push", repo));
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log("\n-- failure paths: the guard must fail CLOSED --");
check("malformed JSON on stdin", BLOCK, "{not json", { raw: true });
check("empty stdin", BLOCK, "", { raw: true });
check("null tool_input", BLOCK, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: null });

console.log("\n-- non-Bash tools are untouched --");
check("Read tool passes through", ALLOW, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } });

console.log(failed === 0 ? "\nall guard checks passed" : `\n${failed} guard check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
