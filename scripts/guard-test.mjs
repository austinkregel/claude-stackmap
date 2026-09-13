#!/usr/bin/env node
/**
 * Regression suite for the destructive-command guard (guard.mjs) and the guard.sh wrapper,
 * including every fail-closed path.
 *
 * Runs against a temporary config ($STACKMAP_CONFIG) and state directory ($STACKMAP_STATE), so it
 * never reads or writes the real ones.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const guard = join(dirname(fileURLToPath(import.meta.url)), "guard.sh");
const BLOCK = 2, ALLOW = 0;
let failed = 0;

const sandbox = mkdtempSync(join(tmpdir(), "stackmap-guard-"));
const configPath = join(sandbox, "config.json");
const env = { ...process.env, STACKMAP_CONFIG: configPath, STACKMAP_STATE: join(sandbox, "state") };
const setConfig = (obj) => writeFileSync(configPath, JSON.stringify(obj));

function run(payload, { raw = false, script = "guard.mjs" } = {}) {
  const args = script === null ? [] : [script];
  const r = spawnSync(guard, args, { input: raw ? payload : JSON.stringify(payload), encoding: "utf8", env });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// A block must be the rule firing, not a crash that happens to exit 2: rule blocks start with
// "Blocked:", and every fail-closed check passes its own `reason`.
const RULE_BLOCK = /^Blocked:/m;

function check(label, expected, payload, opts = {}) {
  const r = run(payload, opts);
  const reason = opts.reason ?? (expected === BLOCK ? RULE_BLOCK : null);
  let ok = r.code === expected;
  if (ok && reason) ok = reason.test(r.err);
  if (!ok) failed++;
  const verdict = r.code === BLOCK ? "BLOCK" : r.code === ALLOW ? "allow" : `exit ${r.code}`;
  console.log(`${ok ? "PASS" : "FAIL"}  ${verdict.padEnd(5)} ${label}`);
  if (!ok) console.log(`        expected ${expected}${reason ? ` matching ${reason}` : ""}, stderr: ${r.err.trim().slice(0, 240)}`);
}

const bash = (command, cwd = sandbox) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } });

try {
  setConfig({});

  console.log("-- precision: the read-only lookalikes must survive --");
  check("git merge-base (read-only, must never be blocked)", ALLOW, bash("git merge-base origin/main HEAD"));
  check("git merge-base --is-ancestor", ALLOW, bash("git merge-base --is-ancestor HEAD origin/main"));
  check("push to a feature branch", ALLOW, bash("git push origin feature/some-work"));
  check("force-with-lease is allowed", ALLOW, bash("git push --force-with-lease origin feature/x"));
  check("ordinary migrate", ALLOW, bash("php artisan migrate --step"));
  check("merge mentioned inside a string, not invoked", ALLOW, bash('echo "do not git merge here"'));
  check("rm -rf on scratch (deliberately not blocked)", ALLOW, bash("rm -rf storage/tmp-3-output"));
  check("regression: a quoted ; no longer splits into a fake command", ALLOW, bash('echo "wip; git merge later"'));
  check("reset without --hard", ALLOW, bash("git reset HEAD~1"));
  check("--hard mentioned in a commit message is not a reset", ALLOW, bash('git log --grep "--hard"'));

  console.log("\n-- the destructive forms must block --");
  check("unrequested merge", BLOCK, bash("git merge origin/main --no-edit"));
  check("merge inside a compound command", BLOCK, bash("cd /repo && git merge origin/main"));
  check("merge with a global option before the subcommand", BLOCK, bash("git -c core.pager=cat merge origin/main"));
  check("merge inside $( )", BLOCK, bash("echo $(git merge origin/main)"));
  check("merge inside bash -c", BLOCK, bash("bash -c 'git merge origin/main'"));
  check("push to develop via refspec", BLOCK, bash("git push origin HEAD:develop"));
  check("push to main directly", BLOCK, bash("git push origin main"));
  check("force push", BLOCK, bash("git push --force origin feature/x"));
  check("force push short flag", BLOCK, bash("git push -f origin feature/x"));
  check("hard reset", BLOCK, bash("git reset --hard HEAD~1"));
  check("migrate:fresh (drops every table)", BLOCK, bash("php artisan migrate:fresh --seed"));
  check("db:wipe", BLOCK, bash("php artisan db:wipe"));
  check("DROP TABLE in a quoted -e", BLOCK, bash("mysql -e 'DROP TABLE clients'"));
  check("regression: DROP TABLE in a heredoc fed to a client", BLOCK, bash("mysql app <<'SQL'\nDROP TABLE clients;\nSQL"));

  console.log("\n-- branch-aware rules --");
  const repo = join(sandbox, "repo");
  execFileSync("git", ["init", "-q", "-b", "develop", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  check("commit while HEAD is on develop", BLOCK, bash("git commit -m wip", repo));
  check("implicit push while on develop", BLOCK, bash("git push", repo));
  check("push -u origin (one positional) while on develop is implicit", BLOCK, bash("git push -u origin", repo));
  check("git -C <repo> commit uses that repo's branch", BLOCK, bash(`git -C ${repo} commit -m wip`, sandbox));
  check("regression: git -C \"$DIR\" status does not need the directory, so it passes", ALLOW, bash('git -C "$DIR" status'));
  check("git -C \"$DIR\" commit needs the branch, so it fails closed", BLOCK, bash('git -C "$DIR" commit -m wip'), { reason: /branch is unknown/ });
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature/x"]);
  check("commit on a feature branch", ALLOW, bash("git commit -m wip", repo));
  check("implicit push on a feature branch", ALLOW, bash("git push", repo));

  console.log("\n-- commit messages must not contain commands --");
  check("the reported case: a command inside -m", BLOCK, bash('git commit -m "wip; git merge later"', repo), { reason: /contains the command 'git merge'/ });
  check("prose instead of the command passes", ALLOW, bash('git commit -m "wip; merge later"', repo));
  check("'git is implied' is prose, not a subcommand", ALLOW, bash('git commit -m "Merge later; git is implied"', repo));
  check("a word that merely starts like a subcommand", ALLOW, bash('git commit -m "Fix git mergeable check"', repo));
  check("legit (a word ending in git) is not the tool", ALLOW, bash('git commit -m "legit merge of the two lists"', repo));
  check("--message= form", BLOCK, bash('git commit --message="run git rebase after"', repo));
  check("clustered -am form", BLOCK, bash('git commit -am "then git push"', repo));
  check("attached -mTEXT form", BLOCK, bash("git commit '-mgit stash first'", repo));
  check(
    "heredoc message via $(cat <<EOF)",
    BLOCK,
    bash('git commit -m "$(cat <<\'EOF\'\nSubject\n\nRemember to git push\nEOF\n)"', repo),
  );
  check(
    "heredoc message without a command passes",
    ALLOW,
    bash('git commit -m "$(cat <<\'EOF\'\nSubject\n\nPlain prose body.\nEOF\n)"', repo),
  );
  writeFileSync(join(repo, "MSG"), "Subject\n\nthen git reset the branch\n");
  check("-F <file> is read and checked", BLOCK, bash("git commit -F MSG", repo));
  check("-F - with a heredoc", BLOCK, bash("git commit -F - <<'EOF'\nsee git log\nEOF", repo));
  check("-F - from a pipe cannot be checked, so it fails closed", BLOCK, bash("printf 'x' | git commit -F -", repo), { reason: /cannot be checked/ });
  check("-F with a missing file fails closed", BLOCK, bash("git commit -F NOPE", repo), { reason: /could not read commit message file/ });
  check("-C reuses an existing message and is not checked", ALLOW, bash("git commit -C HEAD", repo));

  setConfig({ guard: { commitMessage: { commands: [{ name: "npm", subcommands: ["install", "test"] }] } } });
  check("configured tool with an explicit subcommand list", BLOCK, bash('git commit -m "then npm test"', repo));
  check("configured list replaces the default (git no longer checked)", ALLOW, bash('git commit -m "then git push"', repo));
  setConfig({ guard: { commitMessage: { commands: [{ name: "git", listCommand: ["false"] }] } } });
  check("a failing listCommand fails closed", BLOCK, bash('git commit -m "then git push"', repo), { reason: /could not list git subcommands/ });
  setConfig({ guard: { commitMessage: { enabled: false } } });
  check("commitMessage.enabled=false turns the rule off", ALLOW, bash('git commit -m "then git push"', repo));
  setConfig({ guard: { enabled: false } });
  check("guard.enabled=false turns off destructive rules", ALLOW, bash("git merge origin/main"));
  check("…but not the separately-enabled commit-message rule", BLOCK, bash('git commit -m "then git push"', repo));
  setConfig({});

  console.log("\n-- failure paths: the guard must fail CLOSED --");
  check("malformed JSON on stdin", BLOCK, "{not json", { raw: true, reason: /unreadable hook payload/ });
  check("empty stdin", BLOCK, "", { raw: true, reason: /unreadable hook payload/ });
  check("null tool_input", BLOCK, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: null }, { reason: /no readable command/ });
  check("a command the shell would reject", BLOCK, bash('echo "unterminated'), { reason: /cannot evaluate/ });
  check("a git subcommand built at runtime", BLOCK, bash('git "$SUB" origin/main'), { reason: /built at runtime/ });
  writeFileSync(configPath, "{not json");
  check("invalid JSON config blocks instead of silently using defaults", BLOCK, bash("ls"), { reason: /not valid JSON/ });
  setConfig({ guard: { alowMerge: true } });
  check("regression: a misspelled config key blocks instead of doing nothing", BLOCK, bash("ls"), { reason: /unknown key/ });
  setConfig({});

  console.log("\n-- the wrapper must fail CLOSED --");
  check("guard.sh with no script named", BLOCK, bash("ls"), { script: null, reason: /no hook script named/ });
  check("guard.sh with a path-escaping name", BLOCK, bash("ls"), { script: "../bin/sm.mjs", reason: /invalid hook script name/ });
  check("guard.sh with a missing script", BLOCK, bash("ls"), { script: "does-not-exist.mjs", reason: /missing/ });

  console.log("\n-- non-Bash tools are untouched --");
  check("Read tool passes through", ALLOW, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } });
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall guard checks passed" : `\n${failed} guard check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
