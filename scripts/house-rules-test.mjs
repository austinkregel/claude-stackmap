#!/usr/bin/env node
/**
 * Suite for house-rules.mjs: what is injected under each config, and that every failure injects
 * nothing while telling the user why. Checks inspect the injected output, not just the exit code.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const runner = join(scripts, "hook-open.sh");
let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};

const sandbox = mkdtempSync(join(tmpdir(), "stackmap-house-rules-"));
const configPath = join(sandbox, "config.json");
const env = { ...process.env, STACKMAP_CONFIG: configPath, STACKMAP_STATE: join(sandbox, "state") };
const setConfig = (obj) => writeFileSync(configPath, JSON.stringify(obj));

function inject(event = "SessionStart", hookRunner = runner) {
  const r = spawnSync(hookRunner, ["house-rules.mjs"], {
    input: JSON.stringify({ hook_event_name: event, session_id: "t", cwd: sandbox, source: "startup" }),
    encoding: "utf8",
    env,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // left null; checks below report it
  }
  return {
    code: r.status,
    context: json?.hookSpecificOutput?.additionalContext ?? null,
    eventName: json?.hookSpecificOutput?.hookEventName ?? null,
    systemMessage: json?.systemMessage ?? null,
    stdout: r.stdout,
  };
}

const defaultText = readFileSync(join(scripts, "..", "house-rules", "default.md"), "utf8");
const defaultIds = [...defaultText.matchAll(/<!--\s*id:\s*([a-z0-9-]+)\s*-->/g)].map((m) => m[1]);
const enforcedSections = [...defaultText.matchAll(/<!--\s*enforced-by:[^>]*-->\n## /g)].length;
const enforcementList = (context) => context?.slice(context.indexOf("## Enforced by stackmap hooks")) ?? "";

try {
  console.log("-- defaults --");
  setConfig({});
  {
    const r = inject();
    check("exits 0", r.code === 0, `exit ${r.code}`);
    check("emits SessionStart additionalContext", r.eventName === "SessionStart" && typeof r.context === "string", r.stdout.slice(0, 200));
    check("starts with the default ruleset", r.context?.startsWith("# Working agreement"), r.context?.slice(0, 80));
    const headings = (r.context?.match(/^## /gm) ?? []).length;
    const expected = defaultIds.length - enforcedSections + 1;
    check("every unenforced default section is present (plus the enforcement list)", defaultIds.length > 5 && enforcedSections > 0 && headings === expected, `${headings} headings, expected ${expected}`);
    check("id markers are metadata, not injected text", !r.context?.includes("<!-- id:"));
    check("enforced-by markers are metadata, not injected text", !r.context?.includes("enforced-by"));
    check("ends with the enforcement list", /tee is the command straight after the pipe/.test(enforcementList(r.context)));
    check("stays under Claude Code's 10,000-character limit", (r.context?.length ?? Infinity) <= 10000, `${r.context?.length} chars`);
  }
  {
    const r = inject("SubagentStart");
    check("SubagentStart gets the same rules, under its own event name", r.eventName === "SubagentStart" && r.context?.startsWith("# Working agreement"));
  }

  console.log("\n-- rule text a guard enforces is left out while that guard is on --");
  setConfig({});
  {
    const r = inject();
    check("noTruncate on: the command-output section is left out", !r.context?.includes("## Command output"));
    check("dead-code category on: the dead-code bullet is left out", !r.context?.includes("Dead code is deleted"));
    check("…and the rest of its section stays", r.context?.includes("## Never narrow the problem") && r.context?.includes("A green result obtained by narrowing"));
    check("commitMessage on: the commands bullet is left out", !r.context?.includes("Don't paste commands"));
    check("…and the untagged bullet next to it stays", r.context?.includes("- Describe the change in prose."));
  }
  setConfig({ guard: { noTruncate: { enabled: false }, noSuppress: { disableCategories: ["dead-code"] }, commitMessage: { enabled: false } } });
  {
    const r = inject();
    check("noTruncate off: the command-output section comes back", r.context?.includes("## Command output"));
    check("dead-code category off: the dead-code bullet comes back", r.context?.includes("Dead code is deleted, not annotated"));
    check("commitMessage off: the commands bullet comes back", r.context?.includes("- Don't paste commands into commit messages."));
    check("a returned section keeps its wrapped lines", /the command may not be safe to run again/.test(r.context ?? ""));
  }
  setConfig({ guard: { noSuppress: { enabled: false } } });
  check("noSuppress off entirely: the dead-code bullet comes back", inject().context?.includes("Dead code is deleted"));

  console.log("\n-- houseRules.subagents --");
  setConfig({ houseRules: { subagents: false } });
  {
    const sub = inject("SubagentStart");
    check("subagents=false: SubagentStart injects nothing, quietly", sub.code === 0 && sub.stdout.trim() === "", `exit ${sub.code}, stdout ${sub.stdout.slice(0, 80)}`);
    check("subagents=false: SessionStart still injects", inject().context?.startsWith("# Working agreement"));
  }

  console.log("\n-- extend, disable, replace --");
  const orgRules = join(sandbox, "org-rules.md");
  writeFileSync(orgRules, "# Org rules\n\n## Tickets\n- Reference the ticket in every commit.\n");
  setConfig({ houseRules: { files: [orgRules] } });
  {
    const r = inject();
    check("extend: defaults come first", r.context?.startsWith("# Working agreement"));
    check("extend: the configured file follows the defaults", r.context?.indexOf("# Org rules") > r.context?.indexOf("## Write it down"));
  }
  setConfig({ houseRules: { disable: ["commits", "sub-agents"] } });
  {
    const r = inject();
    check("disable: the named sections are gone", !r.context?.includes("## Commits") && !r.context?.includes("## Sub-agents"));
    check("disable: the other sections remain", r.context?.includes("## Ask") && r.context?.includes("## Write it down"));
  }
  setConfig({ houseRules: { mode: "replace", files: [orgRules] } });
  {
    const r = inject();
    check("replace: only the configured file (plus the enforcement list)", r.context?.startsWith("# Org rules") && !r.context?.includes("# Working agreement"));
    check("replace: the enforcement list is still appended", r.context?.includes("## Enforced by stackmap hooks"));
  }

  console.log("\n-- the enforcement list follows the guard config --");
  setConfig({ guard: { noTruncate: { enabled: false }, noSuppress: { disableCategories: ["coverage"] }, allowMerge: true } });
  {
    const r = inject();
    check("a disabled guard is not claimed as enforced", !enforcementList(r.context).includes("tee is the command straight after the pipe"));
    check("a disabled suppression category is not listed", r.context?.includes("check-silencing directive") && !/check-silencing directive[^\n]*coverage/.test(r.context ?? ""));
    check("allowMerge drops git merge from the destructive list", /Destructive commands are blocked: force push/.test(r.context ?? ""));
  }
  setConfig({ guard: { enabled: false, noTruncate: { enabled: false }, noSuppress: { enabled: false }, commitMessage: { enabled: false } } });
  check("with every guard off, the rules say they are guidance only", inject().context?.includes("every rule above is guidance only"));

  console.log("\n-- failures inject NOTHING and say why --");
  const expectVisibleFailure = (label, pattern) => {
    const r = inject();
    check(`${label}: no context injected`, r.context === null, r.stdout.slice(0, 120));
    check(`${label}: the user is told why`, pattern.test(r.systemMessage ?? ""), r.systemMessage ?? "(no systemMessage)");
    check(`${label}: exits non-blocking (1), not 0`, r.code === 1, `exit ${r.code}`);
  };
  setConfig({ houseRules: { files: [join(sandbox, "missing.md")] } });
  expectVisibleFailure("missing rules file", /could not be read \(ENOENT\)/);
  writeFileSync(join(sandbox, "blank.md"), "  \n\n");
  setConfig({ houseRules: { files: [join(sandbox, "blank.md")] } });
  expectVisibleFailure("empty rules file", /is empty/);
  setConfig({ houseRules: { disable: ["no-such-section"] } });
  expectVisibleFailure("unknown disable id", /unknown section id\(s\) no-such-section/);
  writeFileSync(join(sandbox, "huge.md"), `# Huge\n${"- a rule that goes on and on\n".repeat(400)}`);
  setConfig({ houseRules: { files: [join(sandbox, "huge.md")] } });
  expectVisibleFailure("over the 10,000-character limit", /over Claude Code's 10000-character hook output limit/);
  setConfig({ houseRules: { files: ["relative/rules.md"] } });
  expectVisibleFailure("relative path in config", /must be absolute or start with ~\//);
  setConfig({ houseRules: { mode: "replace" } });
  expectVisibleFailure("replace with no files", /needs at least one entry/);
  writeFileSync(configPath, "{broken");
  expectVisibleFailure("invalid JSON config", /not valid JSON/);
  setConfig({ houseRules: { subagents: "no" } });
  expectVisibleFailure("non-boolean subagents", /houseRules\.subagents: expected true or false/);

  // Defects in the shipped default are exercised on a copy of the plugin with an edited default.md.
  const plugin = join(sandbox, "plugin");
  cpSync(scripts, join(plugin, "scripts"), { recursive: true });
  cpSync(join(scripts, "..", "house-rules"), join(plugin, "house-rules"), { recursive: true });
  const pluginRunner = join(plugin, "scripts", "hook-open.sh");
  const withDefault = (text) => writeFileSync(join(plugin, "house-rules", "default.md"), text);
  const expectDefaultDefect = (label, pattern) => {
    const r = inject("SessionStart", pluginRunner);
    check(`${label}: no context injected`, r.context === null, r.stdout.slice(0, 120));
    check(`${label}: the user is told why`, pattern.test(r.systemMessage ?? ""), r.systemMessage ?? "(no systemMessage)");
  };
  setConfig({});
  withDefault(defaultText.replace("enforced-by: noTruncate", "enforced-by: noTrunc"));
  expectDefaultDefect("unknown enforced-by name", /unknown enforced-by name "noTrunc"/);
  withDefault(defaultText.replace("enforced-by: noSuppress:dead-code", "enforced-by: noSuppress:deadcode"));
  expectDefaultDefect("unknown suppression category in enforced-by", /unknown enforced-by name "noSuppress:deadcode"/);
  setConfig({ houseRules: { disable: ["command-output"] } });
  withDefault(defaultText.replace("enforced-by: noTruncate", "enforced-by: noTrunc"));
  expectDefaultDefect("unknown enforced-by name in a disabled section", /unknown enforced-by name "noTrunc"/);
  setConfig({});
  withDefault(defaultText.replace("<!-- enforced-by: commitMessage -->\n- Don't", "<!-- enforced-by: commitMessage -->\n\n- Don't"));
  expectDefaultDefect("enforced-by line not directly above a heading or bullet", /must be directly above a "## " heading or a "- " bullet/);

  console.log("\n-- disabled --");
  setConfig({ houseRules: { enabled: false } });
  {
    const r = inject();
    check("enabled=false injects nothing, quietly", r.code === 0 && r.stdout.trim() === "", `exit ${r.code}, stdout ${r.stdout.slice(0, 80)}`);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall house-rules checks passed" : `\n${failed} house-rules check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
