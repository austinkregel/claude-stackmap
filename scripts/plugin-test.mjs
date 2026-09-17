#!/usr/bin/env node
/**
 * Plugin wiring and drift suite: hooks.json points at real scripts through the right wrapper, every
 * launcher has a POSIX file and a Windows .cmd twin with the right line endings, every hook script is wired, names agree across the manifest, agents, skills, and hooks, and the closing
 * blocks written in the skill and agent files match the ones the hooks enforce. No build needed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIT_BLOCK, AUDITOR_AGENT, ENFORCED_SKILLS } from "./deliverables.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const root = join(scripts, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};

/** Scripts that fail closed; everything else fails open. */
const GUARDS = ["guard.mjs", "no-truncate.mjs", "no-suppress.mjs", "plan-identity.mjs"];
const EVENTS = ["PreToolUse", "PostToolUse", "SessionStart", "SubagentStart", "SubagentStop", "UserPromptSubmit", "Stop"];
/** Exec form: the extensionless launcher, which is the sh file on macOS/Linux and resolves to its .cmd twin on Windows. */
const COMMAND = /^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/(guard|hook-open)$/;
const SCRIPT = /^[a-z0-9-]+\.mjs$/;
/** Every launcher: an extensionless POSIX sh file plus a .cmd twin for Windows. */
const LAUNCHERS = ["scripts/launch", "scripts/guard", "scripts/hook-open", "bin/sm"];

/** Every `{ event, matcher, wrapper, script, timeout }` in hooks.json. */
function hookEntries() {
  const out = [];
  for (const [event, groups] of Object.entries(JSON.parse(read("hooks/hooks.json")).hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const m = COMMAND.exec(hook.command ?? "");
        const script = m && Array.isArray(hook.args) && hook.args.length === 1 && SCRIPT.test(hook.args[0]) ? hook.args[0] : undefined;
        out.push({ event, matcher: group.matcher, type: hook.type, command: JSON.stringify([hook.command, hook.args]), wrapper: m?.[1], script, timeout: hook.timeout });
      }
    }
  }
  return out;
}

/** The label a closing-block line starts with: `Label:` or `Reviewed at <`. */
function labelOf(line) {
  const m = /^(?:\*\*)?([A-Z][A-Za-z-]*(?: [a-z][A-Za-z-]*)*)(?::|\*\*:| <)/.exec(line.trim());
  return m ? m[1] : null;
}
const labels = (lines) => [...new Set(lines.map(labelOf).filter(Boolean))].sort();
/** Labels inside the fenced code blocks of a markdown file. */
function fencedLabels(markdown) {
  const out = [];
  for (const m of markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) out.push(...m[1].split("\n"));
  return labels(out);
}
function frontmatter(markdown) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  const out = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

console.log("-- hooks.json --");
const entries = hookEntries();
check("hooks.json has entries", entries.length > 0);
for (const e of entries) {
  const where = `${e.event}${e.matcher ? ` [${e.matcher}]` : ""} ${e.script ?? e.command}`;
  check(`${where}: a known event`, EVENTS.includes(e.event), e.event);
  check(`${where}: an exec-form command through scripts/guard or scripts/hook-open, with the script as its one argument`, e.type === "command" && Boolean(e.script), e.command);
  if (!e.script) continue;
  check(`${where}: the script exists`, existsSync(join(scripts, e.script)));
  const expected = GUARDS.includes(e.script) ? "guard" : "hook-open";
  check(`${where}: runs through ${expected}`, e.wrapper === expected, e.wrapper);
  check(`${where}: sets a timeout of 1–60 seconds`, Number.isFinite(e.timeout) && e.timeout >= 1 && e.timeout <= 60, String(e.timeout));
  if (e.matcher !== undefined) {
    let ok = true;
    try {
      new RegExp(e.matcher);
    } catch {
      ok = false;
    }
    check(`${where}: the matcher is a valid regular expression`, ok, e.matcher);
  }
}
check("guards run only before a tool call", entries.filter((e) => GUARDS.includes(e.script)).every((e) => e.event === "PreToolUse"));

const wired = new Set(entries.map((e) => e.script));
const IMPORTS_READ_PAYLOAD = /^import \{[^}]*\breadPayload\b[^}]*\} from "\.\/hook-lib\.mjs";$/m;
const hookScripts = readdirSync(scripts).filter((f) => f.endsWith(".mjs") && IMPORTS_READ_PAYLOAD.test(readFileSync(join(scripts, f), "utf8")));
check("hook scripts are found by importing readPayload", hookScripts.length >= 9, hookScripts.join(", "));
for (const f of hookScripts) check(`${f} is wired in hooks.json`, wired.has(f));

const on = (script) => entries.filter((e) => e.script === script).map((e) => e.event).sort().join();
check("house-rules runs on SessionStart and SubagentStart", on("house-rules.mjs") === "SessionStart,SubagentStart", on("house-rules.mjs"));
check("skill-arm runs on UserPromptSubmit", on("skill-arm.mjs") === "UserPromptSubmit", on("skill-arm.mjs"));
check("skill-check runs on Stop", on("skill-check.mjs") === "Stop", on("skill-check.mjs"));
const audit = entries.find((e) => e.script === "audit-check.mjs");
check("audit-check runs on SubagentStop", audit?.event === "SubagentStop", JSON.stringify(audit));
if (audit?.matcher) {
  const re = new RegExp(audit.matcher);
  check("the audit-check matcher matches the auditor exactly", re.test(AUDITOR_AGENT) && !re.test(`${AUDITOR_AGENT}-2`) && !re.test("Explore") && !re.test(`x${AUDITOR_AGENT}`), audit.matcher);
}

const identity = entries.filter((e) => e.script === "plan-identity.mjs");
check("plan-identity runs once, before a tool call", identity.length === 1 && identity[0].event === "PreToolUse", JSON.stringify(identity));
if (identity[0]?.matcher) {
  const re = new RegExp(identity[0].matcher);
  const pluginName = JSON.parse(read(".claude-plugin/plugin.json")).name;
  const toolName = (tool) => `mcp__plugin_${pluginName}_stackmap__${tool}`;
  check("the plan-identity matcher covers every plan tool of this plugin's server and nothing else",
    re.test(toolName("plan_status")) && re.test(toolName("plan_resolve_task")) && !re.test(toolName("note_get")) && !re.test("mcp__plugin_other_stackmap__plan_status") && !re.test(`x${toolName("plan_status")}`),
    identity[0].matcher);
}
check("plan-store.mjs is a library, not a hook (never reads a payload)", !/readPayload/.test(read("scripts/plan-store.mjs")));

console.log("\n-- launchers --");
// Git records the executable bit, so it's read from the index: that works on a Windows checkout too.
const indexModes = new Map(
  execFileSync("git", ["ls-files", "-s", "--", ...LAUNCHERS], { cwd: root, encoding: "utf8" })
    .split("\n").filter(Boolean).map((line) => [line.split("\t")[1], line.split(" ")[0]]),
);
for (const launcher of LAUNCHERS) {
  const sh = join(root, launcher);
  const cmd = `${sh}.cmd`;
  check(`${launcher}: the POSIX launcher exists`, existsSync(sh));
  check(`${launcher}.cmd: the Windows twin exists`, existsSync(cmd));
  if (!existsSync(sh) || !existsSync(cmd)) continue;
  const shText = readFileSync(sh, "utf8");
  const cmdBytes = readFileSync(cmd, "latin1");
  check(`${launcher}: a #!/bin/sh script`, shText.startsWith("#!/bin/sh\n"), JSON.stringify(shText.slice(0, 20)));
  check(`${launcher}: committed as executable`, indexModes.get(launcher) === "100755", indexModes.get(launcher) ?? "(not in the index)");
  check(`${launcher}: LF line endings (sh fails on CR)`, !shText.includes("\r"));
  check(`${launcher}.cmd: CRLF line endings on every line`, cmdBytes.split("\n").slice(0, -1).every((l) => l.endsWith("\r")) && cmdBytes.endsWith("\r\n"));
  check(`${launcher}.cmd: plain ASCII (cmd.exe reads batch files in the OEM code page)`, /^[\t\r\n\x20-\x7e]*$/.test(cmdBytes));
}
check("find-node.cmd exists beside find-node.sh", existsSync(join(scripts, "find-node.cmd")) && existsSync(join(scripts, "find-node.sh")));
check("no .sh launcher remains", !["launch.sh", "guard.sh", "hook-open.sh"].some((f) => existsSync(join(scripts, f))));
const gitattributes = read(".gitattributes");
check(".gitattributes checks text out as LF, and .cmd as CRLF", /^\* text=auto eol=lf$/m.test(gitattributes) && /^\*\.cmd text eol=crlf$/m.test(gitattributes), gitattributes);

console.log("\n-- manifest, agents, skills --");
const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
check("plugin.json has no agents key (agents/ is auto-discovered)", !("agents" in plugin));
check("plugin.json points at .mcp.json", plugin.mcpServers === "./.mcp.json" && existsSync(join(root, ".mcp.json")));
const mcp = JSON.parse(read(".mcp.json"));
check(".mcp.json starts the server through the extensionless launcher, with no shell syntax",
  mcp.mcpServers?.stackmap?.command === "${CLAUDE_PLUGIN_ROOT}/scripts/launch" && mcp.mcpServers.stackmap.args === undefined, JSON.stringify(mcp));

const agentFiles = readdirSync(join(root, "agents")).filter((f) => f.endsWith(".md"));
const auditorFile = agentFiles.find((f) => `${plugin.name}:${frontmatter(read(`agents/${f}`)).name}` === AUDITOR_AGENT);
check(`an agent file is named ${AUDITOR_AGENT}`, Boolean(auditorFile), agentFiles.join(", "));
if (auditorFile) {
  const md = read(`agents/${auditorFile}`);
  const fm = frontmatter(md);
  check("the auditor runs in its own worktree", fm.isolation === "worktree", JSON.stringify(fm));
  check("the auditor has a description", (fm.description ?? "").length > 20, JSON.stringify(fm));
  // Exact text, not just labels: the Reproducer sub-fields' indentation is part of what the hook parses.
  const fenced = [...md.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1].replace(/\n$/, ""));
  check("the auditor's report block is exactly AUDIT_BLOCK", fenced.includes(AUDIT_BLOCK.join("\n")), `fenced blocks:\n${fenced.join("\n---\n")}`);
}
check("agent-transcript.mjs is a library, not a hook (never reads a payload)", !IMPORTS_READ_PAYLOAD.test(read("scripts/agent-transcript.mjs")) && !/readPayload/.test(read("scripts/agent-transcript.mjs")));

const skillDirs = readdirSync(join(root, "skills")).filter((d) => existsSync(join(root, "skills", d, "SKILL.md")));
for (const skill of ENFORCED_SKILLS) {
  const path = `skills/${skill.name}/SKILL.md`;
  check(`${skill.name}: ${path} exists`, existsSync(join(root, path)));
  if (!existsSync(join(root, path))) continue;
  check(`${skill.name}: the trigger matches /${skill.name} and /stackmap:${skill.name} only`,
    skill.trigger.test(`/${skill.name} x`) && skill.trigger.test(`/stackmap:${skill.name}`) && !skill.trigger.test(`/${skill.name}x`) && !skill.trigger.test(`docs/${skill.name}`));
  const md = read(path);
  const expected = labels(skill.blocks.flat());
  check(`${skill.name}: the closing block in SKILL.md matches the enforced block`, fencedLabels(md).join() === expected.join(), `${fencedLabels(md)} vs ${expected}`);
}
for (const d of skillDirs) {
  const enforced = /\*\*Enforced\.\*\*/.test(read(`skills/${d}/SKILL.md`));
  check(`${d}: says it is enforced exactly when it is in ENFORCED_SKILLS`, enforced === ENFORCED_SKILLS.some((s) => s.name === d));
}

console.log("\n-- package.json --");
const pkg = JSON.parse(read("package.json"));
const suites = readdirSync(scripts).filter((f) => f.endsWith("-test.mjs"));
const testRuns = pkg.scripts.test.split("&&").map((s) => s.trim().replace(/^npm run /, ""));
for (const f of suites) {
  const name = Object.entries(pkg.scripts).find(([, cmd]) => cmd === `node scripts/${f}`)?.[0];
  check(`${f} has an npm script run by npm test`, Boolean(name) && testRuns.includes(name), name ?? "(no script)");
}
check("npm test also runs the end-to-end suite", testRuns.includes("smoke") && pkg.scripts.smoke === "node scripts/smoke.mjs");
for (const [name, cmd] of Object.entries(pkg.scripts)) {
  const file = /^node (scripts\/\S+\.mjs)$/.exec(cmd)?.[1];
  if (file) check(`npm run ${name} points at an existing file`, existsSync(join(root, file)), file);
}

console.log(failed === 0 ? "\nall plugin checks passed" : `\n${failed} plugin check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
