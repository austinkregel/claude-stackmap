#!/usr/bin/env node
/**
 * stackmap PreToolUse guard — blocks a narrow set of destructive, hard-to-reverse commands, and
 * commit messages that contain a command.
 *
 *  - Fails closed: anything that prevents evaluation (unreadable payload, invalid config, a command
 *    the shell itself would reject) blocks.
 *  - Evaluates the parsed command (shell-tokens.mjs), never its raw text.
 *  - Rules are narrow on purpose: `git merge-base` is not blocked, and neither is `rm -rf`.
 *
 * Stated limits: a command whose name is built at runtime (`$GIT push --force`) is not
 * recognised, and neither is a refspec built at runtime (`git push origin "$BRANCH"`). Commit
 * message text that only exists at runtime (`-m "$MSG"`) is not checked; literal text and heredoc
 * bodies are.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { deny, failClosed, readPayload } from "./hook-lib.mjs";
import { loadHookConfig } from "./hook-config.mjs";
import {
  commandName, commandWords, literalTextIgnoringExpansions, parse, ShellParseError, staticText, walkStages,
} from "./shell-tokens.mjs";

const HOOK = "guard";

/** git options that come before the subcommand and take a separate value. */
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source"]);

class CannotEvaluate extends Error {}

/**
 * `git [global options] <subcommand> [args]` → { sub, args, dirs } or null when not git.
 * A `-C` directory built at runtime is kept as null: most rules never need it, and the ones that do
 * (branch detection, a relative `-F` file) fail closed when they reach it.
 */
function gitInvocation(stage) {
  if (commandName(stage).name !== "git") return null;
  const words = commandWords(stage).slice(1);
  const dirs = [];
  let i = 0;
  for (; i < words.length; i++) {
    const text = staticText(words[i]);
    if (text === null) throw new CannotEvaluate(`git with a subcommand or option built at runtime (${words[i].raw})`);
    if (!text.startsWith("-")) break;
    if (GIT_GLOBAL_WITH_VALUE.has(text)) {
      if (text === "-C") dirs.push(words[i + 1] ? staticText(words[i + 1]) : null);
      i++;
    }
  }
  if (i >= words.length) return { sub: null, args: [], dirs };
  return { sub: staticText(words[i]), args: words.slice(i + 1), dirs };
}

function currentBranch(cwd) {
  // `symbolic-ref` first: `rev-parse --abbrev-ref HEAD` prints "HEAD" on an unborn branch.
  const attempts = [
    ["symbolic-ref", "--short", "HEAD"],
    ["rev-parse", "--abbrev-ref", "HEAD"],
  ];
  for (const args of attempts) {
    try {
      const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
      if (out && out !== "HEAD") return out; // "HEAD" means detached, not a branch name
    } catch {
      // not a repo, or this form failed; try the next form
    }
  }
  return null; // not a repo, detached HEAD, or git unavailable — branch rules don't fire
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Everything a script feeds as data through heredocs and here-strings (a message built with `$(cat <<EOF …)`). */
function dataTextOf(script) {
  const out = [];
  walkStages(script, (stage) => {
    for (const doc of stage.heredocs) out.push(doc.body);
    for (const hs of stage.herestrings) out.push(literalTextIgnoringExpansions(hs));
  });
  return out.join("\n");
}

/** A word's known text: literal parts, plus heredoc/here-string data inside its substitutions. */
function knownText(parts) {
  return parts
    .map((p) => {
      if (p.kind === "lit") return p.text;
      if (p.kind === "cmdsub" || p.kind === "procsub") return dataTextOf(p.script);
      return ""; // $VAR, ${…}, $((…)): only known at runtime
    })
    .join("");
}

/** The parts of `word` after its first `n` literal characters (for `-mfoo`, `--message=foo`). */
function partsAfter(word, n) {
  const [first, ...rest] = word.parts;
  if (!first || first.kind !== "lit" || first.text.length < n) return null;
  return [{ ...first, text: first.text.slice(n) }, ...rest];
}

const leadingLiteral = (word) => (word.parts[0]?.kind === "lit" ? word.parts[0].text : "");

/**
 * Commit message text supplied on this `git commit` invocation: `-m`, `--message`, `-F`, `--file`,
 * including clustered short options (`-am msg`). Messages reused from another commit (`-C`, `-c`)
 * or opened in an editor are not authored here and are not checked.
 */
function commitMessageTexts(inv, stage, cwd) {
  const texts = [];
  const fileText = (word) => {
    const path = staticText(word);
    if (path === null) throw new CannotEvaluate(`git commit -F with a path built at runtime (${word.raw})`);
    if (path === "-") {
      if (stage.heredocs.length === 0 && stage.herestrings.length === 0) {
        throw new CannotEvaluate("git commit -F - reads the message from a pipe, which cannot be checked; use -m or a heredoc");
      }
      return [...stage.heredocs.map((d) => d.body), ...stage.herestrings.map(literalTextIgnoringExpansions)].join("\n");
    }
    if (inv.dirs.includes(null) && !isAbsolute(path)) {
      throw new CannotEvaluate(`git -C with a directory built at runtime, so the message file ${path} cannot be located`);
    }
    const full = resolve(cwd, ...inv.dirs, path);
    try {
      return readFileSync(full, "utf8");
    } catch (err) {
      throw new CannotEvaluate(`could not read commit message file ${full} (${err.code ?? err.message})`);
    }
  };

  const args = inv.args;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    const lead = leadingLiteral(word);
    if (lead === "--" && word.parts.length === 1) break;

    const long = /^--(message|file)(=)?/.exec(lead);
    if (long) {
      const [matched, option, eq] = long;
      if (!eq && lead !== `--${option}`) continue; // e.g. --messagefoo: not this option
      const valueParts = eq ? partsAfter(word, matched.length) : args[++i]?.parts;
      if (!valueParts) throw new CannotEvaluate(`git commit --${option} with no value`);
      texts.push(option === "message" ? knownText(valueParts) : fileText({ parts: valueParts, raw: word.raw }));
      continue;
    }

    if (/^-[A-Za-z]/.test(lead)) {
      for (let j = 1; j < lead.length; j++) {
        const ch = lead[j];
        if (!"mFCct".includes(ch)) {
          if (ch === "S" || ch === "u") break; // optional value, attached only: -S<keyid>, -u<mode>
          continue;
        }
        // `-mfoo` / `-m"$(…)"` carry the value in the same word; bare `-m` takes the next word.
        const attached = partsAfter(word, j + 1);
        const hasAttached = attached !== null && !(attached.length === 1 && attached[0].text === "");
        const valueParts = hasAttached ? attached : args[++i]?.parts;
        if (!valueParts) throw new CannotEvaluate(`git commit -${ch} with no value`);
        if (ch === "m") texts.push(knownText(valueParts));
        if (ch === "F") texts.push(fileText({ parts: valueParts, raw: word.raw }));
        break; // the value consumed the rest of the cluster
      }
    }
  }
  return texts;
}

/** Subcommand names for a configured tool, from its config entry. Cached per process. */
const subcommandCache = new Map();
function subcommandsFor(entry) {
  if (entry.subcommands) return new Set(entry.subcommands);
  if (subcommandCache.has(entry.name)) return subcommandCache.get(entry.name);
  const [program, ...rest] = entry.listCommand;
  let out;
  try {
    out = execFileSync(program, rest, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000 });
  } catch (err) {
    throw new CannotEvaluate(`could not list ${entry.name} subcommands with \`${entry.listCommand.join(" ")}\` (${err.code ?? err.message})`);
  }
  const set = new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  if (set.size === 0) throw new CannotEvaluate(`\`${entry.listCommand.join(" ")}\` listed no ${entry.name} subcommands`);
  subcommandCache.set(entry.name, set);
  return set;
}

function commandInMessage(text, commands) {
  for (const entry of commands) {
    const re = new RegExp(`(?<![\\w.-])${escapeRe(entry.name)}[ \\t]+([A-Za-z0-9][A-Za-z0-9-]*)`, "g");
    let m;
    let subs = null;
    while ((m = re.exec(text))) {
      subs ??= subcommandsFor(entry);
      if (subs.has(m[1])) return `${entry.name} ${m[1]}`;
    }
  }
  return null;
}

const DESTRUCTIVE_ARTISAN = ["migrate:fresh", "migrate:refresh", "migrate:reset", "db:wipe"];
const DESTRUCTIVE_SQL = /\b(DROP\s+(?:DATABASE|TABLE)|TRUNCATE\s+TABLE)\b/i;

/** Returns a reason string when the stage should be blocked, else null. */
function evaluate(stage, cfg, ctx) {
  const inv = gitInvocation(stage);
  const guard = cfg.guard;

  if (guard.enabled) {
    if (inv) {
      const argText = inv.args.map(staticText);
      const positional = argText.filter((t) => t !== null && !t.startsWith("-"));

      // 1. Unrequested merge. `git merge-base` is a different subcommand and stays allowed.
      if (!guard.allowMerge && inv.sub === "merge") {
        return `Blocked: 'git merge' is denied by the stackmap guard. An unrequested merge is hard to unwind. Run it yourself, or set guard.allowMerge=true in the stackmap config.`;
      }

      // 2. Force push (data loss on a shared ref). --force-with-lease is a different flag.
      if (inv.sub === "push" && argText.some((t) => t === "--force" || t === "-f")) {
        return `Blocked: force-push is denied by the stackmap guard. Use --force-with-lease if you must rewrite a remote branch.`;
      }

      // 3. Any push whose destination is a protected branch.
      if (inv.sub === "push") {
        const dst = new RegExp(`^(?:[^:]+:)?(?:refs/heads/)?(${guard.protectedBranches.map(escapeRe).join("|")})$`);
        const hit = positional.find((t) => dst.test(t));
        if (hit) return `Blocked: push targets protected branch '${hit.match(dst)[1]}'. Push to a feature branch and open a PR.`;
        if (positional.length < 2) {
          const branch = ctx.branch(inv);
          if (branch && guard.protectedBranches.includes(branch)) {
            return `Blocked: implicit push while HEAD is on protected branch '${branch}'. Switch to a feature branch first.`;
          }
        }
      }

      // 4. Commit while sitting on a protected branch.
      if (inv.sub === "commit") {
        const branch = ctx.branch(inv);
        if (branch && guard.protectedBranches.includes(branch)) {
          return `Blocked: commit on protected branch '${branch}'. Create a feature branch first.`;
        }
      }

      // 5. Hard reset (discards uncommitted work).
      if (inv.sub === "reset" && argText.includes("--hard")) {
        return `Blocked: 'git reset --hard' discards uncommitted work. Use 'git stash' or reset without --hard.`;
      }
    }

    // 6. Destructive database operations.
    const words = commandWords(stage).map(staticText);
    const artisan = DESTRUCTIVE_ARTISAN.find((v) => words.includes(v));
    if (artisan) return `Blocked: '${artisan}' drops tables and is not reversible. Run it yourself if you mean it.`;

    const sqlText = [
      stage.words.map(literalTextIgnoringExpansions).join(" "),
      ...stage.heredocs.map((d) => d.body),
      ...stage.herestrings.map(literalTextIgnoringExpansions),
    ].join("\n");
    const sql = DESTRUCTIVE_SQL.exec(sqlText);
    if (sql) return `Blocked: destructive SQL (${sql[1].replace(/\s+/g, " ")}) against a live connection.`;
  }

  // 7. A command inside a commit message.
  if (guard.commitMessage.enabled && inv?.sub === "commit") {
    for (const text of commitMessageTexts(inv, stage, ctx.cwd())) {
      const found = commandInMessage(text, guard.commitMessage.commands);
      if (found) {
        return `Blocked: the commit message contains the command '${found}'. A command inside a commit message is usually a mis-type — describe the change in prose instead (for example "merge later"; the tool is implied).`;
      }
    }
  }
  return null;
}

async function main() {
  let input;
  try {
    input = await readPayload();
  } catch (err) {
    return failClosed(HOOK, `unreadable hook payload (${err.message})`);
  }
  if (input.tool_name !== "Bash") return;

  let cfg;
  try {
    cfg = loadHookConfig();
  } catch (err) {
    return failClosed(HOOK, err.message);
  }
  if (!cfg.guard.enabled && !cfg.guard.commitMessage.enabled) return;

  const command = input?.tool_input?.command;
  if (typeof command !== "string") return failClosed(HOOK, "Bash call with no readable command string");
  if (!command.trim()) return;

  const branchCache = new Map();
  const ctx = {
    cwd() {
      if (typeof input.cwd !== "string" || !input.cwd) throw new CannotEvaluate("payload has no cwd, so the branch and relative paths are unknown");
      return input.cwd;
    },
    branch(inv) {
      if (inv.dirs.includes(null)) throw new CannotEvaluate("git -C with a directory built at runtime, so the branch is unknown");
      const dir = resolve(this.cwd(), ...inv.dirs);
      if (!branchCache.has(dir)) branchCache.set(dir, currentBranch(dir));
      return branchCache.get(dir);
    },
  };

  try {
    const script = parse(command);
    const reason = walkStages(
      script,
      (stage) => evaluate(stage, cfg, ctx) ?? undefined,
      (unknown) => {
        throw new CannotEvaluate(unknown);
      },
    );
    if (reason) return deny(reason);
  } catch (err) {
    if (err instanceof CannotEvaluate || err instanceof ShellParseError) {
      return failClosed(HOOK, `cannot evaluate this command: ${err.message}`);
    }
    throw err;
  }
}

main().catch((err) => failClosed(HOOK, `internal error (${err?.message ?? err})`));
