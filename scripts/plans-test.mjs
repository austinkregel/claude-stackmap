#!/usr/bin/env node
/**
 * Suite for scripts/plan-store.mjs: the `plans` config section, record validation, storage, and the
 * lifecycle rules (nesting, ownership, final states, closing). No build needed. Every check runs
 * against a temporary config, HOME, and plans directory.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};
/** The error a call throws, or null. */
const thrown = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
};

const sandbox = mkdtempSync(join(tmpdir(), "stackmap-plans-"));
const home = join(sandbox, "home");
mkdirSync(home);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.STACKMAP_CONFIG = join(sandbox, "config.json");
delete process.env.XDG_CONFIG_HOME;

const S = await import(pathToFileURL(join(scripts, "plan-store.mjs")).href);
const { PlanError } = S;
const { ConfigError } = await import(pathToFileURL(join(scripts, "hook-config.mjs")).href);
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const main = { session_id: "session-a", agent_id: null };
const other = { session_id: "session-b", agent_id: null };
const sub = { session_id: "session-a", agent_id: "agent-1" };
const inPlace = { kind: "in-place" };

try {
  console.log("-- plans config section --");
  {
    const cfg = (obj) => writeFileSync(process.env.STACKMAP_CONFIG, typeof obj === "string" ? obj : JSON.stringify(obj));
    check("no config file: the default under the home directory", S.plansDir() === join(home, ".config", "stackmap", "plans"), S.plansDir());
    cfg({});
    check("config without a plans section: the default", S.plansDir() === join(home, ".config", "stackmap", "plans"));
    cfg({ plans: { dir: join(sandbox, "p") } });
    check("an absolute plans.dir is used", S.plansDir() === join(sandbox, "p"));
    cfg({ plans: { dir: "~/plans-here" } });
    check("~/ is expanded", S.plansDir() === join(home, "plans-here"));
    cfg({ plans: {} });
    check("an empty plans section: the default", S.plansDir() === join(home, ".config", "stackmap", "plans"));
    for (const [label, body, pattern] of [
      ["a relative plans.dir", { plans: { dir: "plans" } }, /must be absolute or start with ~\//],
      ["an unknown key", { plans: { dir: "~/p", folder: "x" } }, /plans\.folder: unknown key/],
      ["plans not an object", { plans: "~/p" }, /plans: expected an object/],
      ["an empty plans.dir", { plans: { dir: "" } }, /expected a non-empty path/],
      ["invalid JSON", "{nope", /not valid JSON/],
    ]) {
      cfg(body);
      const err = thrown(() => S.plansDir());
      check(`${label}: a ConfigError naming it, never the default`, err instanceof ConfigError && pattern.test(err.message), err?.message ?? "(no error)");
    }
    cfg({});
  }

  console.log("\n-- storage --");
  const dir = join(sandbox, "plans");
  const store = S.openStore(dir);
  check("a missing plans directory is an empty store", store.list().plans.length === 0 && store.list().malformed.length === 0);
  check("a relative store directory is refused", thrown(() => new S.PlanStore("plans")) instanceof PlanError);
  check("an id that could leave the directory is refused", /invalid plan id/.test(thrown(() => store.get("../x"))?.message ?? ""));
  check("an unknown id is an error", /no plan "nope"/.test(thrown(() => store.get("nope"))?.message ?? ""));
  check("a call without identity names the hook", /plan-identity hook/.test(thrown(() => S.createPlan(store, { session_id: "" }, { title: "x", deliverable: inPlace }))?.message ?? ""));

  console.log("\n-- create and nest --");
  const root = S.createPlan(store, main, { title: "Ship the feature", deliverable: inPlace, tasks: ["design", "build", "test"] });
  check("a root plan is written and reads back identical", JSON.stringify(store.get(root.id)) === JSON.stringify(root));
  check("the root plan is active and owned by its session", root.status === "active" && root.owner.session_id === "session-a" && root.parent === null);
  check("tasks are numbered t1… and start as todo", root.tasks.map((t) => `${t.id}:${t.state}`).join() === "t1:todo,t2:todo,t3:todo");
  check("the file on disk is valid", S.validatePlan(JSON.parse(readFileSync(join(dir, `${root.id}.json`), "utf8"))).length === 0);
  check("a second root plan in the same session is refused", /already has active plan/.test(thrown(() => S.createPlan(store, main, { title: "Another", deliverable: inPlace }))?.message ?? ""));
  check("a plan needs a deliverable", /deliverable: required/.test(thrown(() => S.createPlan(store, other, { title: "No deliverable" }))?.message ?? ""));
  check("a deliverable of an unknown kind is refused", /deliverable\.kind/.test(thrown(() => S.createPlan(store, other, { title: "x", deliverable: { kind: "pr" } }))?.message ?? ""));
  check("a document deliverable needs an absolute path", /absolute file path/.test(thrown(() => S.createPlan(store, other, { title: "x", deliverable: { kind: "document", path: "notes.md" } }))?.message ?? ""));

  check("a child without from_task is refused (no default resume point)", /from_task: required/.test(thrown(() => S.createChild(store, main, { title: "Side quest", deliverable: inPlace }))?.message ?? ""));
  check("a child from an unknown task is refused", /has no task "t9"/.test(thrown(() => S.createChild(store, main, { title: "Side quest", deliverable: inPlace, from_task: "t9" }))?.message ?? ""));
  const { plan: child, parent } = S.createChild(store, main, { title: "Side quest", deliverable: inPlace, from_task: "t2", tasks: ["dig in"] });
  check("the child links to its parent task", child.parent?.plan === root.id && child.parent?.task === "t2");
  check("the parent is paused at that task and lists the child", parent.status === "paused" && parent.resume_at === "t2" && parent.tasks[1].children.includes(child.id));
  check("the child is now the session's active plan", S.activePlan(store, "session-a")?.id === child.id);

  console.log("\n-- tasks --");
  let r = S.addTasks(store, main, { id: child.id, tasks: ["write it up"] });
  check("tasks are appended with the next number", r.added.join() === "t2" && r.plan.tasks.map((t) => t.id).join() === "t1,t2");
  r = S.addTasks(store, main, { id: child.id, tasks: ["check first"], after: "t1" });
  check("tasks can be inserted after a task", r.plan.tasks.map((t) => t.id).join() === "t1,t3,t2");
  check("another session can't add tasks", /owned by session session-a/.test(thrown(() => S.addTasks(store, other, { id: child.id, tasks: ["x"] }))?.message ?? ""));
  check("done without evidence is refused", /needs evidence/.test(thrown(() => S.updateTask(store, main, { id: child.id, task: "t1", state: "done" }))?.message ?? ""));
  check("a user-only state is refused here", /use plan_resolve_task/.test(thrown(() => S.updateTask(store, main, { id: child.id, task: "t1", state: "not_needed" }))?.message ?? ""));
  check("evidence without done is refused", /only given when marking a task done/.test(thrown(() => S.updateTask(store, main, { id: child.id, task: "t1", state: "doing", evidence: "x" }))?.message ?? ""));
  S.updateTask(store, main, { id: child.id, task: "t1", state: "doing" });
  r = S.updateTask(store, main, { id: child.id, task: "t1", state: "done", evidence: "test run 12 passed" });
  check("done with evidence is recorded", r.task.state === "done" && r.task.evidence === "test run 12 passed");
  check("a final task doesn't change", /already done/.test(thrown(() => S.updateTask(store, main, { id: child.id, task: "t1", text: "renamed" }))?.message ?? ""));

  const resolveArgs = { id: child.id, tasks: ["t3"], state: "not_needed", reason: "covered by t1", user_quote: "skip the check", transcript_uuid: "uuid-1" };
  check("a subagent can't resolve tasks", /subagent can't/.test(thrown(() => S.resolveTasks(store, sub, resolveArgs))?.message ?? ""));
  check("resolving needs the user's quote", /user_quote: required/.test(thrown(() => S.resolveTasks(store, main, { ...resolveArgs, user_quote: "" }))?.message ?? ""));
  check("resolving to done is refused", /state: expected one of/.test(thrown(() => S.resolveTasks(store, main, { ...resolveArgs, state: "done" }))?.message ?? ""));
  const before = readFileSync(join(dir, `${child.id}.json`), "utf8");
  check("a batch containing a final task changes nothing", /already final: t1/.test(thrown(() => S.resolveTasks(store, main, { ...resolveArgs, tasks: ["t3", "t1"] }))?.message ?? "") && readFileSync(join(dir, `${child.id}.json`), "utf8") === before);
  r = S.resolveTasks(store, main, resolveArgs);
  check("a resolved task records the reason, quote and transcript uuid", r.plan.tasks.find((t) => t.id === "t3")?.resolution?.user_quote === "skip the check" && r.plan.tasks.find((t) => t.id === "t3").state === "not_needed");

  console.log("\n-- closing --");
  let err = thrown(() => S.closePlan(store, main, { id: root.id, summary: "done" }));
  check("a parent with an open child can't close, and the error names the child", err?.message.includes(`open child plans: ${child.id} (active)`), err?.message);
  check("…and names its open tasks", err?.message.includes("open tasks: t1 (todo), t2 (todo), t3 (todo)"), err?.message);
  check("closing needs a summary", /summary: required/.test(thrown(() => S.closePlan(store, main, { id: child.id, summary: "" }))?.message ?? ""));
  err = thrown(() => S.closePlan(store, main, { id: child.id, summary: "done" }));
  check("a plan with an open task can't close", err?.message.includes("open tasks: t2 (todo)"), err?.message);
  S.updateTask(store, main, { id: child.id, task: "t2", state: "done", evidence: "notes.md written" });
  const closed = S.closePlan(store, main, { id: child.id, summary: "side quest finished" });
  check("the child closes", closed.plan.status === "closed" && closed.plan.closed?.summary === "side quest finished");
  check("the parent resumes at its task", closed.resumed?.plan === root.id && closed.resumed?.task === "t2");
  const resumed = store.get(root.id);
  check("the parent is active again and its resume point is cleared", resumed.status === "active" && resumed.resume_at === null);
  check("a closed plan can't change", /is closed/.test(thrown(() => S.addTasks(store, main, { id: child.id, tasks: ["x"] }))?.message ?? ""));
  check("a closed plan can't be selected", /is closed/.test(thrown(() => S.selectPlan(store, main, { id: child.id }))?.message ?? ""));

  console.log("\n-- selecting and taking over --");
  const other1 = S.createPlan(store, other, { title: "Other work", deliverable: inPlace, tasks: ["a"] });
  const nested = S.createChild(store, other, { title: "Other child", deliverable: inPlace, from_task: "t1" }).plan;
  err = thrown(() => S.selectPlan(store, main, { id: nested.id }));
  check("another session's plan isn't taken without take_over, and the owner is named", /owned by session session-b/.test(err?.message ?? "") && /take_over/.test(err?.message ?? ""), err?.message);
  check("take_over must be a boolean", /take_over: expected true or false/.test(thrown(() => S.selectPlan(store, main, { id: nested.id, take_over: "yes" }))?.message ?? ""));
  check("a subagent can't take a plan over", /subagent can't take/.test(thrown(() => S.selectPlan(store, sub, { id: nested.id, take_over: true }))?.message ?? ""));
  const taken = S.selectPlan(store, main, { id: nested.id, take_over: true });
  check("take_over moves the whole open tree", taken.moved.sort().join() === [other1.id, nested.id].sort().join() && taken.movedFrom === "session-b", JSON.stringify(taken));
  check("the taken plan is active; this session's previous plan is paused", taken.plan.status === "active" && taken.paused === root.id && store.get(root.id).status === "paused");
  check("both plans now belong to this session", store.get(other1.id).owner.session_id === "session-a" && store.get(nested.id).owner.session_id === "session-a");
  check("the previous owner's next write is refused, naming the new owner", /owned by session session-a/.test(thrown(() => S.addTasks(store, other, { id: other1.id, tasks: ["x"] }))?.message ?? ""));
  check("the session has exactly one active plan", S.activePlan(store, "session-a")?.id === nested.id);
  const back = S.selectPlan(store, main, { id: root.id });
  check("selecting back pauses the other plan", back.plan.status === "active" && back.paused === nested.id && store.get(nested.id).status === "paused");

  console.log("\n-- deliverables --");
  {
    const docPath = join(sandbox, "findings.md");
    const docPlan = S.createPlan(store, { session_id: "session-doc", agent_id: null }, { title: "Research", deliverable: { kind: "document", path: docPath }, tasks: ["read"] });
    const docActor = { session_id: "session-doc", agent_id: null };
    S.updateTask(store, docActor, { id: docPlan.id, task: "t1", state: "done", evidence: "read the sources" });
    err = thrown(() => S.closePlan(store, docActor, { id: docPlan.id, summary: "findings" }));
    check("a missing document blocks closing", /findings\.md can't be read/.test(err?.message ?? ""), err?.message);
    writeFileSync(docPath, "# Findings\n");
    check("an existing document lets it close", S.closePlan(store, docActor, { id: docPlan.id, summary: "findings" }).plan.status === "closed");

    const repo = join(sandbox, "repo");
    mkdirSync(repo);
    git(["init", "-q", "-b", "trunk"], repo);
    git(["config", "user.email", "t@t"], repo);
    git(["config", "user.name", "t"], repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "a.txt"], repo);
    git(["commit", "-q", "-m", "first"], repo);
    const d = (branch, base = "trunk") => ({ kind: "branch", repo, base, branch });
    check("an unknown branch is reported", S.deliverableProblem(d(null)) === "the deliverable branch isn't known yet");
    check("a branch that doesn't exist is reported", /doesn't exist/.test(S.deliverableProblem(d("feature")) ?? ""));
    git(["branch", "feature"], repo);
    check("a branch with no commits beyond its base is reported", /no commits beyond trunk/.test(S.deliverableProblem(d("feature")) ?? ""));
    git(["checkout", "-q", "feature"], repo);
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(["add", "b.txt"], repo);
    git(["commit", "-q", "-m", "second"], repo);
    check("a branch with commits beyond its base is delivered", S.deliverableProblem(d("feature")) === null);
    check("an unknown base is reported, not treated as delivered", /can't compare feature with its base nope/.test(S.deliverableProblem(d("feature", "nope")) ?? ""));
  }

  console.log("\n-- handed-off plans --");
  {
    const actor = { session_id: "session-h", agent_id: null };
    const h = S.createPlan(store, actor, { title: "Handed off", deliverable: inPlace, tasks: ["x"] });
    h.executor = { kind: "subagent", agent_id: "agent-9", worktree: null, branch: null };
    h.tasks[0] = { ...h.tasks[0], state: "done", evidence: "commit abc" };
    store.save(h);
    check("the main conversation can't close a handed-off plan before delivery", /hasn't been delivered/.test(thrown(() => S.closePlan(store, actor, { id: h.id, summary: "x" }))?.message ?? ""));
    check("another agent can't change a handed-off plan", /handed to agent agent-9/.test(thrown(() => S.addTasks(store, { session_id: "session-h", agent_id: "agent-2" }, { id: h.id, tasks: ["y"] }))?.message ?? ""));
  }

  console.log("\n-- unreadable plan files are reported, never skipped --");
  {
    const bad = S.openStore(join(sandbox, "bad"));
    const good = S.createPlan(bad, main, { title: "Fine", deliverable: inPlace });
    const write = (name, body) => writeFileSync(join(bad.dir, name), typeof body === "string" ? body : JSON.stringify(body));
    write("broken.json", "{not json");
    write("extra-key.json", { ...good, id: "extra-key", color: "red" });
    write("wrong-id.json", good);
    write("notes.txt", "hello");
    write(".tmp-fine-1-abcd", "{}");
    write("done-no-evidence.json", { ...good, id: "done-no-evidence", tasks: [{ id: "t1", text: "x", state: "done", evidence: null, resolution: null, children: [] }] });
    const { plans, malformed } = bad.list();
    const why = (name) => malformed.find((m) => m.file.endsWith(name))?.error ?? "";
    check("the valid plan is listed", plans.length === 1 && plans[0].id === good.id, plans.map((p) => p.id).join());
    check("invalid JSON is reported", /can't be read/.test(why("broken.json")), why("broken.json"));
    check("an unknown key is reported", /plan\.color: unknown key/.test(why("extra-key.json")), why("extra-key.json"));
    check("an id that doesn't match the file name is reported", /does not match its file name/.test(why("wrong-id.json")), why("wrong-id.json"));
    check("a stray file is reported", /not a plan file name/.test(why("notes.txt")), why("notes.txt"));
    check("a leftover temporary file is reported", /temporary file/.test(why(".tmp-fine-1-abcd")), why(".tmp-fine-1-abcd"));
    check("a done task without evidence is reported", /needs evidence/.test(why("done-no-evidence.json")), why("done-no-evidence.json"));
    check("get() throws for an unreadable plan", /is invalid/.test(thrown(() => bad.get("extra-key"))?.message ?? ""));
    check("save() refuses an invalid plan", /refusing to save/.test(thrown(() => bad.save({ ...good, status: "open" }))?.message ?? ""));
    check("a user-only state without a resolution is invalid", S.validatePlan({ ...good, tasks: [{ id: "t1", text: "x", state: "wont_deliver", evidence: null, resolution: null, children: [] }] }).some((i) => /needs a resolution/.test(i)));
    check("status closed and the closed record agree", S.validatePlan({ ...good, status: "closed" }).some((i) => /set exactly when status is closed/.test(i)));
  }

  console.log("\n-- plan-store.d.mts declares every export --");
  {
    const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join();
    const js = names(readFileSync(join(scripts, "plan-store.mjs"), "utf8"), /^export (?:class|function|const) (\w+)/gm);
    const dts = names(readFileSync(join(scripts, "plan-store.d.mts"), "utf8"), /^export (?:class|function|const) (\w+)/gm);
    check("the export lists agree", js === dts, `js: ${js}\nd.mts: ${dts}`);
    check("the runtime exports match the source", Object.keys(S).sort().join() === js, Object.keys(S).sort().join());
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

check("the sandbox is removed", !existsSync(sandbox));
console.log(failed === 0 ? "\nall plan-store checks passed" : `\n${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
