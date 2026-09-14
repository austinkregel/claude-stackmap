#!/usr/bin/env node
/**
 * Suite for no-truncate.mjs: every allowance the rule promises, then every form it must block.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const guard = join(dirname(fileURLToPath(import.meta.url)), "guard.sh");
const BLOCK = 2, ALLOW = 0;
const RULE_BLOCK = /^Blocked:/m;
let failed = 0;

const sandbox = mkdtempSync(join(tmpdir(), "stackmap-truncate-"));
const configPath = join(sandbox, "config.json");
const env = { ...process.env, STACKMAP_CONFIG: configPath, STACKMAP_STATE: join(sandbox, "state") };
const setConfig = (obj) => writeFileSync(configPath, JSON.stringify(obj));

function check(label, expected, payload, { raw = false, reason } = {}) {
  const r = spawnSync(guard, ["no-truncate.mjs"], { input: raw ? payload : JSON.stringify(payload), encoding: "utf8", env });
  const want = reason ?? (expected === BLOCK ? RULE_BLOCK : null);
  const ok = r.status === expected && (!want || want.test(r.stderr ?? ""));
  if (!ok) failed++;
  const verdict = r.status === BLOCK ? "BLOCK" : r.status === ALLOW ? "allow" : `exit ${r.status}`;
  console.log(`${ok ? "PASS" : "FAIL"}  ${verdict.padEnd(5)} ${label}`);
  if (!ok) console.log(`        expected ${expected}${want ? ` matching ${want}` : ""}, stderr: ${(r.stderr ?? "").trim().slice(0, 240)}`);
}

const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: sandbox, tool_input: { command } });

try {
  setConfig({});

  console.log("-- allowed: files, tee first, data, and non-truncating tools --");
  check("grep searching a FILE, not a pipe", ALLOW, bash("grep -rn pattern src/"));
  check("tail on a saved log file", ALLOW, bash("tail -50 build.log"));
  check("sed editing a file in place", ALLOW, bash("sed -i.bak s/a/b/ notes.txt"));
  check("tee captures the full output", ALLOW, bash("npm test 2>&1 | tee /tmp/t.log"));
  check("tee first, then a filter", ALLOW, bash("npm test 2>&1 | tee /tmp/t.log | tail -5"));
  check("tee first with |&", ALLOW, bash("npm test |& tee /tmp/t.log | grep FAIL"));
  check("tee, then reading the saved FILE in a later command", ALLOW, bash("npm test 2>&1 | tee /tmp/t.log && tail -20 /tmp/t.log"));
  check("a pipe inside double quotes is text", ALLOW, bash('echo "do not run cmd | tail here"'));
  check("a pipe inside single quotes is text", ALLOW, bash("printf '%s' 'npm test | head -5'"));
  check("a pipe in a quoted heredoc body is text", ALLOW, bash("cat <<'EOF' > doc.md\nnpm test | tail -20\nEOF"));
  check("|| is logical OR, not a pipe", ALLOW, bash("npm test || tail -5 /tmp/x.log"));
  check("an escaped pipe is not a pipeline", ALLOW, bash("echo a \\| tail"));
  check("a trailing comment is not a command", ALLOW, bash("npm run build # | tail"));
  check("wc is not a truncating filter", ALLOW, bash("git ls-files | wc -l"));
  check("sort is not a truncating filter", ALLOW, bash("cat names.txt | sort -u"));
  check("jq is not a truncating filter", ALLOW, bash("curl -s https://example.test/api | jq .name"));
  check("diff over process substitutions (diff is not a filter)", ALLOW, bash("diff <(sort a) <(sort b)"));
  check("ordinary command with no pipe", ALLOW, bash("npm run build --silent"));
  check("empty command is a no-op", ALLOW, bash("   "));

  console.log("\n-- blocked: the plain violations --");
  check("pipe into tail", BLOCK, bash("npm test | tail -20"));
  check("pipe into head", BLOCK, bash("cat package.json | head -5"));
  check("pipe into grep", BLOCK, bash("ls -la | grep node"));
  check("pipe into less", BLOCK, bash("dmesg | less"));
  check("pipe into cut", BLOCK, bash("cat data.csv | cut -d, -f1"));
  check("pipe into awk", BLOCK, bash("ps aux | awk '{print $2}'"));
  check("powershell Select-Object", BLOCK, bash("Get-Process | Select-Object -First 5"));
  check("filter named by path", BLOCK, bash("npm test | /usr/bin/tail -5"));
  check("real pipe after a quoted decoy", BLOCK, bash('echo "a | tail b" | tail -3'));
  check("violation on a heredoc marker line", BLOCK, bash("cat <<'EOF' | tail -5\nbody\nEOF"));

  console.log("\n-- blocked: a filter before tee, |&, and substitutions --");
  check("truncating BEFORE tee", BLOCK, bash("npm test | tail -5 | tee /tmp/x"));
  check("bash |& pipe", BLOCK, bash("npm test |& tail -5"));
  check("command substitution inside double quotes", BLOCK, bash('echo "$(npm test | tail -5)"'));
  check("process substitution read by a filter", BLOCK, bash("tail -5 <(npm test)"));
  check("process substitution through a redirect", BLOCK, bash("tail -5 < <(npm test)"));

  console.log("\n-- blocked: tee must come first, and in the same pipeline --");
  check("a non-filter before tee does not count as tee first", BLOCK, bash("npm test | sort | tee /tmp/x | tail"));
  check("tee in a separate && command does not count", BLOCK, bash("npm test && tee /tmp/x < /dev/null | tail"));
  check("tee in a separate ; command does not count", BLOCK, bash("make | tee /tmp/a.log; make test | tail"));

  console.log("\n-- blocked: nested and compound forms --");
  check("subshell output piped into a filter", BLOCK, bash("(make; make test) | tail"));
  check("loop output piped into a filter", BLOCK, bash("for f in a b; do cat $f; done | head"));
  check("a filter inside a subshell consumer", BLOCK, bash("npm test | (grep FAIL)"));
  check("pipe inside bash -c", BLOCK, bash("bash -c 'npm test | tail'"));
  check("pipe inside an unquoted heredoc expansion", BLOCK, bash("cat <<EOF\n$(npm test | tail)\nEOF"));
  check("pipe inside ${…} default", BLOCK, bash('echo "${OUT:-$(npm test | tail)}"'));

  console.log("\n-- configuration --");
  setConfig({ guard: { noTruncate: { consumers: ["wc"] } } });
  check("configured consumer list is used", BLOCK, bash("git ls-files | wc -l"));
  check("…and replaces the default list", ALLOW, bash("npm test | tail -5"));
  setConfig({ guard: { noTruncate: { enabled: false } } });
  check("noTruncate.enabled=false turns the rule off", ALLOW, bash("npm test | tail -5"));
  setConfig({});

  console.log("\n-- failure paths: fail CLOSED --");
  check("malformed JSON on stdin", BLOCK, "{not json", { raw: true, reason: /unreadable hook payload/ });
  check("empty stdin", BLOCK, "", { raw: true, reason: /unreadable hook payload/ });
  check("Bash call with null tool_input", BLOCK, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: null }, { reason: /no readable command/ });
  check("Bash call with a non-string command", BLOCK, bash(42), { reason: /no readable command/ });
  check("unterminated quote (the shell would reject it)", BLOCK, bash('echo "unterminated | tail -5'), { reason: /cannot evaluate/ });
  check("a filter whose name is only known at runtime", BLOCK, bash("npm test | $PAGER"), { reason: /only known at runtime/ });
  setConfig({ guard: { noTruncate: { consumers: "tail" } } });
  check("invalid config blocks", BLOCK, bash("ls"), { reason: /expected an array of program names/ });
  setConfig({});

  console.log("\n-- tools this guard does not own pass through --");
  check("Read tool", ALLOW, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } });
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall no-truncate checks passed" : `\n${failed} no-truncate check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
