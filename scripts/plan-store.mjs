/**
 * The plan store: nested plans and their tasks, one JSON file per plan under `plans.dir`.
 *
 * A library, not a hook: it never reads a payload. Hooks import it directly, and the MCP server
 * imports it at runtime (types in plan-store.d.mts), so there is one implementation of the record
 * format and the lifecycle rules. Dependency-free for the same reason as hook-config.mjs: a broken
 * TypeScript build must not change what the hooks see.
 *
 * This file is the only owner of the config file's `plans` section; src/config.ts and
 * hook-config.mjs do not model it. Validation is strict, as there: an unknown key is an error.
 *
 * Every refusal throws `PlanError` naming what is missing. A plan file that can't be read is
 * reported by `list()` and makes `get()` throw; it is never skipped.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ConfigError, configCandidates } from "./hook-config.mjs";

export class PlanError extends Error {}

export const PLAN_STATUSES = ["draft", "active", "paused", "delivered", "closed"];
export const TASK_STATES = ["todo", "doing", "done", "not_needed", "wont_deliver", "already_done"];
/** Final states only the user can authorize; `done` is final too, on evidence. */
export const USER_RESOLVED_STATES = ["not_needed", "wont_deliver", "already_done"];
export const FINAL_STATES = ["done", ...USER_RESOLVED_STATES];
export const DELIVERABLE_KINDS = ["in-place", "branch", "document"];

const DEFAULT_DIR = "~/.config/stackmap/plans";
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const TASK_ID = /^t[1-9][0-9]*$/;

function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Where plans live: the config file's `plans.dir`, else ~/.config/stackmap/plans. Resolution order
 * is the same as every other config reader (configCandidates). The path must be absolute or start
 * with ~/, because hooks run with the project as their working directory.
 */
export function plansDir() {
  for (const candidate of configCandidates()) {
    if (!existsSync(candidate)) continue;
    let raw;
    try {
      raw = JSON.parse(readFileSync(candidate, "utf8"));
    } catch (err) {
      throw new ConfigError(`config at ${candidate} is not valid JSON — ${err.message}`);
    }
    if (!isPlainObject(raw)) throw new ConfigError(`config at ${candidate} is not a JSON object`);
    if (raw.plans === undefined) return expandHome(DEFAULT_DIR);
    const issues = [];
    if (!isPlainObject(raw.plans)) {
      issues.push("plans: expected an object");
    } else {
      for (const key of Object.keys(raw.plans)) {
        if (key !== "dir") issues.push(`plans.${key}: unknown key (known: dir)`);
      }
      const dir = raw.plans.dir;
      if (dir !== undefined) {
        if (typeof dir !== "string" || dir.length === 0) issues.push("plans.dir: expected a non-empty path");
        else if (!(dir === "~" || dir.startsWith("~/") || isAbsolute(dir))) {
          issues.push(`plans.dir: must be absolute or start with ~/ (hooks run with the project as cwd), got "${dir}"`);
        }
      }
    }
    if (issues.length) {
      throw new ConfigError(`config at ${candidate} is invalid:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    }
    return expandHome(raw.plans.dir ?? DEFAULT_DIR);
  }
  return expandHome(DEFAULT_DIR);
}

// ---------------------------------------------------------------------------------------------
// Record validation. Every issue is collected; an unknown key is an issue.

function keysIn(obj, path, required, optional, issues) {
  if (!isPlainObject(obj)) {
    issues.push(`${path}: expected an object`);
    return false;
  }
  const known = [...required, ...optional];
  for (const k of Object.keys(obj)) if (!known.includes(k)) issues.push(`${path}.${k}: unknown key`);
  for (const k of required) if (!(k in obj)) issues.push(`${path}.${k}: missing`);
  return true;
}
const str = (v) => typeof v === "string" && v.length > 0;
const iso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const strOrNull = (v) => v === null || str(v);

function checkDeliverable(d, path, issues) {
  if (!isPlainObject(d) || !DELIVERABLE_KINDS.includes(d.kind)) {
    issues.push(`${path}.kind: expected one of ${DELIVERABLE_KINDS.join(", ")}`);
    return;
  }
  if (d.kind === "in-place") keysIn(d, path, ["kind"], [], issues);
  if (d.kind === "document") {
    if (keysIn(d, path, ["kind", "path"], [], issues) && !(str(d.path) && isAbsolute(d.path))) {
      issues.push(`${path}.path: expected an absolute file path`);
    }
  }
  if (d.kind === "branch") {
    if (keysIn(d, path, ["kind", "repo", "base", "branch"], [], issues)) {
      if (!(str(d.repo) && isAbsolute(d.repo))) issues.push(`${path}.repo: expected an absolute repository path`);
      if (!str(d.base)) issues.push(`${path}.base: expected the ref the work starts from`);
      if (!strOrNull(d.branch)) issues.push(`${path}.branch: expected a branch name or null`);
    }
  }
}

function checkTask(t, path, issues) {
  if (!keysIn(t, path, ["id", "text", "state", "evidence", "resolution", "children"], [], issues)) return;
  if (!(typeof t.id === "string" && TASK_ID.test(t.id))) issues.push(`${path}.id: expected t1, t2, …`);
  if (!str(t.text)) issues.push(`${path}.text: expected non-empty text`);
  if (!TASK_STATES.includes(t.state)) issues.push(`${path}.state: expected one of ${TASK_STATES.join(", ")}`);
  if (!strOrNull(t.evidence)) issues.push(`${path}.evidence: expected text or null`);
  if (t.state === "done" && !str(t.evidence)) issues.push(`${path}: a done task needs evidence`);
  if (t.resolution !== null) {
    if (keysIn(t.resolution, `${path}.resolution`, ["reason", "user_quote", "transcript_uuid", "at"], [], issues)) {
      for (const k of ["reason", "user_quote", "transcript_uuid"]) {
        if (!str(t.resolution[k])) issues.push(`${path}.resolution.${k}: expected non-empty text`);
      }
      if (!iso(t.resolution.at)) issues.push(`${path}.resolution.at: expected an ISO date-time`);
    }
  }
  const needsResolution = USER_RESOLVED_STATES.includes(t.state);
  if (needsResolution && t.resolution === null) issues.push(`${path}: state ${t.state} needs a resolution`);
  if (!needsResolution && t.resolution !== null) issues.push(`${path}: only ${USER_RESOLVED_STATES.join(", ")} carry a resolution`);
  if (!(Array.isArray(t.children) && t.children.every((c) => typeof c === "string" && ID.test(c)))) {
    issues.push(`${path}.children: expected a list of plan ids`);
  }
}

/** Every problem with a plan record, as `path: message` strings. An empty list means valid. */
export function validatePlan(p) {
  const issues = [];
  const keys = ["format", "id", "title", "status", "parent", "resume_at", "projects", "deliverable", "executor", "owner", "source", "tasks", "created", "updated", "closed"];
  if (!keysIn(p, "plan", keys, [], issues)) return issues;
  if (p.format !== 1) issues.push(`plan.format: expected 1, got ${JSON.stringify(p.format)}`);
  if (!(typeof p.id === "string" && ID.test(p.id))) issues.push("plan.id: expected lowercase letters, digits and dashes");
  if (!str(p.title)) issues.push("plan.title: expected non-empty text");
  if (!PLAN_STATUSES.includes(p.status)) issues.push(`plan.status: expected one of ${PLAN_STATUSES.join(", ")}`);
  if (p.parent !== null && keysIn(p.parent, "plan.parent", ["plan", "task"], [], issues)) {
    if (!(typeof p.parent.plan === "string" && ID.test(p.parent.plan))) issues.push("plan.parent.plan: expected a plan id");
    if (!(typeof p.parent.task === "string" && TASK_ID.test(p.parent.task))) issues.push("plan.parent.task: expected a task id");
  }
  if (!(p.resume_at === null || (typeof p.resume_at === "string" && TASK_ID.test(p.resume_at)))) {
    issues.push("plan.resume_at: expected a task id or null");
  }
  if (!(Array.isArray(p.projects) && p.projects.every(str))) issues.push("plan.projects: expected a list of project names");
  checkDeliverable(p.deliverable, "plan.deliverable", issues);
  if (keysIn(p.executor, "plan.executor", ["kind", "agent_id", "worktree", "branch"], [], issues)) {
    if (!["main", "subagent"].includes(p.executor.kind)) issues.push("plan.executor.kind: expected main or subagent");
    for (const k of ["agent_id", "worktree", "branch"]) if (!strOrNull(p.executor[k])) issues.push(`plan.executor.${k}: expected text or null`);
  }
  if (keysIn(p.owner, "plan.owner", ["session_id", "since"], [], issues)) {
    if (!str(p.owner.session_id)) issues.push("plan.owner.session_id: expected a session id");
    if (!iso(p.owner.since)) issues.push("plan.owner.since: expected an ISO date-time");
  }
  if (keysIn(p.source, "plan.source", ["kind", "revisions"], [], issues)) {
    if (!["tool", "plan-mode"].includes(p.source.kind)) issues.push("plan.source.kind: expected tool or plan-mode");
    if (!Array.isArray(p.source.revisions)) issues.push("plan.source.revisions: expected a list");
    else p.source.revisions.forEach((r, i) => {
      const at = `plan.source.revisions[${i}]`;
      if (keysIn(r, at, ["sha256", "text", "plan_file", "at"], [], issues)) {
        if (!(typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256))) issues.push(`${at}.sha256: expected a sha256 hex digest`);
        if (!str(r.text)) issues.push(`${at}.text: expected the plan text`);
        if (!str(r.plan_file)) issues.push(`${at}.plan_file: expected the plan file path`);
        if (!iso(r.at)) issues.push(`${at}.at: expected an ISO date-time`);
      }
    });
  }
  if (!Array.isArray(p.tasks)) issues.push("plan.tasks: expected a list");
  else {
    p.tasks.forEach((t, i) => checkTask(t, `plan.tasks[${i}]`, issues));
    const ids = p.tasks.map((t) => t?.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) issues.push(`plan.tasks: duplicate task id(s) ${[...new Set(dupes)].join(", ")}`);
    if (p.resume_at !== null && !ids.includes(p.resume_at)) issues.push(`plan.resume_at: ${p.resume_at} is not a task of this plan`);
  }
  if (!iso(p.created)) issues.push("plan.created: expected an ISO date-time");
  if (!iso(p.updated)) issues.push("plan.updated: expected an ISO date-time");
  if (p.closed !== null && keysIn(p.closed, "plan.closed", ["at", "by_session", "summary"], [], issues)) {
    if (!iso(p.closed.at)) issues.push("plan.closed.at: expected an ISO date-time");
    if (!str(p.closed.by_session)) issues.push("plan.closed.by_session: expected a session id");
    if (!str(p.closed.summary)) issues.push("plan.closed.summary: expected non-empty text");
  }
  if ((p.status === "closed") !== (p.closed !== null)) issues.push("plan.closed: set exactly when status is closed");
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Storage.

export class PlanStore {
  constructor(dir) {
    if (!isAbsolute(dir)) throw new PlanError(`the plans directory must be absolute, got "${dir}"`);
    this.dir = dir;
  }

  #file(id) {
    if (typeof id !== "string" || !ID.test(id)) throw new PlanError(`invalid plan id ${JSON.stringify(id)}`);
    return join(this.dir, `${id}.json`);
  }

  exists(id) {
    return existsSync(this.#file(id));
  }

  #read(file, id) {
    let plan;
    try {
      plan = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new PlanError(`plan file ${file} can't be read: ${err.message}`);
    }
    const issues = validatePlan(plan);
    if (plan?.id !== id) issues.push(`plan.id: "${plan?.id}" does not match its file name`);
    if (issues.length) throw new PlanError(`plan file ${file} is invalid:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    return plan;
  }

  /** The plan with this id. Throws for an unknown id or an unreadable file. */
  get(id) {
    const file = this.#file(id);
    if (!existsSync(file)) throw new PlanError(`no plan "${id}" in ${this.dir}`);
    return this.#read(file, id);
  }

  /**
   * Every plan, sorted by id, plus every file that couldn't be read as one. A missing directory
   * is an empty store; anything else in the directory that isn't a plan file is reported.
   */
  list() {
    const plans = [];
    const malformed = [];
    if (!existsSync(this.dir)) return { plans, malformed };
    for (const name of readdirSync(this.dir).sort()) {
      const file = join(this.dir, name);
      if (name.startsWith(".tmp-")) {
        malformed.push({ file, error: "temporary file from a write that hasn't finished, or was interrupted" });
        continue;
      }
      const m = /^(.+)\.json$/.exec(name);
      if (!m || !ID.test(m[1])) {
        malformed.push({ file, error: "not a plan file name (<id>.json)" });
        continue;
      }
      try {
        plans.push(this.#read(file, m[1]));
      } catch (err) {
        malformed.push({ file, error: err.message });
      }
    }
    return { plans, malformed };
  }

  /** Validate and write atomically: a temporary file in the same directory, then a rename. */
  save(plan) {
    const issues = validatePlan(plan);
    if (issues.length) throw new PlanError(`refusing to save an invalid plan:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    const file = this.#file(plan.id);
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.tmp-${plan.id}-${process.pid}-${randomBytes(4).toString("hex")}`);
    writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
    renameSync(tmp, file);
  }
}

export function openStore(dir = plansDir()) {
  return new PlanStore(dir);
}

// ---------------------------------------------------------------------------------------------
// Lifecycle. Every operation takes the caller's identity, `{ session_id, agent_id }` (agent_id is
// null in the main conversation), as stamped by the plan-identity hook. `now` is injectable so
// tests can pin timestamps.

function checkActor(actor) {
  if (!isPlainObject(actor) || !str(actor.session_id) || !(actor.agent_id === null || str(actor.agent_id))) {
    throw new PlanError("the call carries no caller identity (session_id, agent_id); is the plan-identity hook installed?");
  }
}

function slug(title) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60).replace(/-$/, "");
  return `${base || "plan"}-${randomBytes(3).toString("hex")}`;
}

function newTasks(texts, startAt) {
  if (!Array.isArray(texts) || !texts.every(str)) throw new PlanError("tasks: expected a list of non-empty task texts");
  return texts.map((text, i) => ({ id: `t${startAt + i}`, text, state: "todo", evidence: null, resolution: null, children: [] }));
}

const nextTaskNumber = (plan) => plan.tasks.reduce((n, t) => Math.max(n, Number(t.id.slice(1))), 0) + 1;

function findTask(plan, taskId) {
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) throw new PlanError(`plan "${plan.id}" has no task "${taskId}" (tasks: ${plan.tasks.map((t) => t.id).join(", ") || "none"})`);
  return task;
}

function requireOwner(plan, actor) {
  if (plan.owner.session_id !== actor.session_id) {
    throw new PlanError(`plan "${plan.id}" is owned by session ${plan.owner.session_id} since ${plan.owner.since}; use plan_select with take_over to move it here`);
  }
  if (plan.executor.kind === "subagent" && actor.agent_id !== null && plan.executor.agent_id !== actor.agent_id) {
    throw new PlanError(`plan "${plan.id}" is handed to agent ${plan.executor.agent_id ?? "(not yet claimed)"}; agent ${actor.agent_id} can't change it`);
  }
}

function requireOpen(plan) {
  if (plan.status === "closed") throw new PlanError(`plan "${plan.id}" is closed`);
}

/** The session's active plan, or null. More than one is a corrupted store and throws. */
export function activePlan(store, sessionId) {
  const { plans } = store.list();
  const active = plans.filter((p) => p.status === "active" && p.owner.session_id === sessionId);
  if (active.length > 1) throw new PlanError(`session ${sessionId} has ${active.length} active plans (${active.map((p) => p.id).join(", ")}); expected at most one`);
  return active[0] ?? null;
}

function checkDeliverableArg(deliverable) {
  const issues = [];
  checkDeliverable(deliverable, "deliverable", issues);
  if (issues.length) throw new PlanError(issues.join("; "));
}

function build(actor, { title, projects = [], deliverable, tasks = [] }, now) {
  if (!str(title)) throw new PlanError("title: expected non-empty text");
  if (!(Array.isArray(projects) && projects.every(str))) throw new PlanError("projects: expected a list of project names");
  if (deliverable === undefined) throw new PlanError("deliverable: required ({kind: in-place | branch | document, …})");
  checkDeliverableArg(deliverable);
  const at = now.toISOString();
  return {
    format: 1,
    id: slug(title),
    title,
    status: "active",
    parent: null,
    resume_at: null,
    projects,
    deliverable,
    executor: { kind: "main", agent_id: null, worktree: null, branch: null },
    owner: { session_id: actor.session_id, since: at },
    source: { kind: "tool", revisions: [] },
    tasks: newTasks(tasks, 1),
    created: at,
    updated: at,
    closed: null,
  };
}

/** A new root plan, active for the caller's session. */
export function createPlan(store, actor, args, now = new Date()) {
  checkActor(actor);
  const current = activePlan(store, actor.session_id);
  if (current) throw new PlanError(`session already has active plan "${current.id}"; open a child with plan_create_child, or close it first`);
  const plan = build(actor, args, now);
  store.save(plan);
  return plan;
}

/** A child of the session's active plan, opened from `from_task`; the parent is paused there. */
export function createChild(store, actor, args, now = new Date()) {
  checkActor(actor);
  const parent = activePlan(store, actor.session_id);
  if (!parent) throw new PlanError("session has no active plan to open a child from; use plan_create");
  requireOwner(parent, actor);
  if (!str(args.from_task)) throw new PlanError(`from_task: required — the task of "${parent.id}" to resume when the child closes`);
  const task = findTask(parent, args.from_task);
  if (FINAL_STATES.includes(task.state)) throw new PlanError(`task ${task.id} of "${parent.id}" is already ${task.state}`);
  const child = build(actor, args, now);
  child.parent = { plan: parent.id, task: task.id };
  task.children.push(child.id);
  parent.status = "paused";
  parent.resume_at = task.id;
  parent.updated = now.toISOString();
  // The child is written first: a parent listing a child that doesn't exist would be worse than
  // an orphaned child, which still names its parent.
  store.save(child);
  store.save(parent);
  return { plan: child, parent };
}

/** The plan, its open ancestors, and its open descendants. */
function tree(store, plan) {
  const out = new Map([[plan.id, plan]]);
  let cur = plan;
  while (cur.parent) {
    cur = store.get(cur.parent.plan);
    if (cur.status !== "closed") out.set(cur.id, cur);
  }
  const queue = [plan];
  while (queue.length) {
    const p = queue.shift();
    for (const t of p.tasks) for (const c of t.children) {
      const child = store.get(c);
      if (child.status !== "closed" && !out.has(child.id)) {
        out.set(child.id, child);
        queue.push(child);
      }
    }
  }
  return [...out.values()];
}

/**
 * Make a plan the session's active plan. A plan owned by another session moves here only with
 * `take_over`, and then its whole open tree moves with it. The previously active plan is paused.
 */
export function selectPlan(store, actor, { id, take_over = false }, now = new Date()) {
  checkActor(actor);
  if (typeof take_over !== "boolean") throw new PlanError("take_over: expected true or false");
  const plan = store.get(id);
  requireOpen(plan);
  if (plan.status === "draft") throw new PlanError(`plan "${id}" is an unapproved draft`);
  if (plan.status === "delivered") throw new PlanError(`plan "${id}" is delivered and waiting for review; close it with plan_close`);
  const at = now.toISOString();
  const moved = [];
  const previousOwner = plan.owner.session_id;
  if (previousOwner !== actor.session_id) {
    if (!take_over) throw new PlanError(`plan "${id}" is owned by session ${plan.owner.session_id} since ${plan.owner.since}; pass take_over: true to move it to this session`);
    if (actor.agent_id !== null) throw new PlanError("a subagent can't take a plan over from another session");
    for (const p of tree(store, plan)) {
      if (p.status === "active" && p.id !== id) p.status = "paused";
      p.owner = { session_id: actor.session_id, since: at };
      p.updated = at;
      moved.push(p);
    }
  }
  const current = activePlan(store, actor.session_id);
  const changed = new Map(moved.map((p) => [p.id, p]));
  if (current && current.id !== id) {
    current.status = "paused";
    current.updated = at;
    changed.set(current.id, current);
  }
  const target = changed.get(id) ?? plan;
  target.status = "active";
  target.updated = at;
  changed.set(id, target);
  for (const p of changed.values()) store.save(p);
  return { plan: target, paused: current && current.id !== id ? current.id : null, movedFrom: moved.length ? previousOwner : null, moved: moved.map((p) => p.id) };
}

/** Append tasks, or insert them after `after`. */
export function addTasks(store, actor, { id, tasks, after }, now = new Date()) {
  checkActor(actor);
  const plan = store.get(id);
  requireOpen(plan);
  requireOwner(plan, actor);
  const added = newTasks(tasks, nextTaskNumber(plan));
  if (added.length === 0) throw new PlanError("tasks: give at least one task");
  const at = after === undefined ? plan.tasks.length : plan.tasks.indexOf(findTask(plan, after)) + 1;
  plan.tasks.splice(at, 0, ...added);
  plan.updated = now.toISOString();
  store.save(plan);
  return { plan, added: added.map((t) => t.id) };
}

/** Change a task's text, or move it between todo, doing and done (done needs evidence). */
export function updateTask(store, actor, { id, task, text, state, evidence }, now = new Date()) {
  checkActor(actor);
  const plan = store.get(id);
  requireOpen(plan);
  requireOwner(plan, actor);
  const t = findTask(plan, task);
  if (FINAL_STATES.includes(t.state)) throw new PlanError(`task ${t.id} is already ${t.state}; final states don't change`);
  if (text === undefined && state === undefined) throw new PlanError("nothing to change: give text and/or state");
  if (text !== undefined) {
    if (!str(text)) throw new PlanError("text: expected non-empty text");
    t.text = text;
  }
  if (state !== undefined) {
    if (USER_RESOLVED_STATES.includes(state)) throw new PlanError(`state ${state} needs your approval; use plan_resolve_task`);
    if (!["todo", "doing", "done"].includes(state)) throw new PlanError(`state: expected todo, doing or done, got ${JSON.stringify(state)}`);
    if (state === "done") {
      if (!str(evidence)) throw new PlanError(`marking ${t.id} done needs evidence (a test run, a commit sha, a file)`);
      t.evidence = evidence;
    } else if (evidence !== undefined) {
      throw new PlanError("evidence: only given when marking a task done");
    }
    t.state = state;
  }
  plan.updated = now.toISOString();
  store.save(plan);
  return { plan, task: t };
}

/**
 * Set tasks to a state only the user can authorize. The plan-identity hook has already checked
 * that `user_quote` is the user's own words in this session's transcript and recorded its uuid;
 * this only enforces what the record needs and that the caller is the main conversation.
 */
export function resolveTasks(store, actor, { id, tasks, state, reason, user_quote, transcript_uuid }, now = new Date()) {
  checkActor(actor);
  if (actor.agent_id !== null) throw new PlanError("only the main conversation can resolve tasks this way; a subagent can't");
  if (!USER_RESOLVED_STATES.includes(state)) throw new PlanError(`state: expected one of ${USER_RESOLVED_STATES.join(", ")}`);
  for (const [k, v] of Object.entries({ reason, user_quote, transcript_uuid })) {
    if (!str(v)) throw new PlanError(`${k}: required`);
  }
  if (!Array.isArray(tasks) || tasks.length === 0) throw new PlanError("tasks: give at least one task id");
  const plan = store.get(id);
  requireOpen(plan);
  requireOwner(plan, actor);
  const at = now.toISOString();
  const targets = tasks.map((tid) => findTask(plan, tid));
  const final = targets.filter((t) => FINAL_STATES.includes(t.state));
  if (final.length) throw new PlanError(`already final: ${final.map((t) => `${t.id} (${t.state})`).join(", ")}; nothing was changed`);
  for (const t of targets) {
    t.state = state;
    t.resolution = { reason, user_quote, transcript_uuid, at };
  }
  plan.updated = at;
  store.save(plan);
  return { plan, resolved: targets.map((t) => t.id) };
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Why the deliverable isn't there, or null when it is. */
export function deliverableProblem(d) {
  if (d.kind === "in-place") return null;
  if (d.kind === "document") {
    try {
      if (!statSync(d.path).isFile()) return `document ${d.path} is not a file`;
      readFileSync(d.path);
      return null;
    } catch (err) {
      return `document ${d.path} can't be read: ${err.message}`;
    }
  }
  if (d.branch === null) return "the deliverable branch isn't known yet";
  try {
    git(d.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${d.branch}^{commit}`]);
  } catch {
    return `branch ${d.branch} doesn't exist in ${d.repo}`;
  }
  let count;
  try {
    count = Number(git(d.repo, ["rev-list", "--count", `${d.base}..refs/heads/${d.branch}`]));
  } catch (err) {
    return `can't compare ${d.branch} with its base ${d.base} in ${d.repo}: ${(err.stderr || err.message).trim()}`;
  }
  return count > 0 ? null : `branch ${d.branch} has no commits beyond ${d.base}`;
}

/**
 * Close a plan. Every task must be final, every child plan closed, and the deliverable must exist.
 * The parent, when this session paused it for this child, becomes active again.
 */
export function closePlan(store, actor, { id, summary }, now = new Date()) {
  checkActor(actor);
  if (!str(summary)) throw new PlanError("summary: required — what the plan delivered");
  const plan = store.get(id);
  requireOpen(plan);
  requireOwner(plan, actor);
  if (plan.status === "draft") throw new PlanError(`plan "${id}" is an unapproved draft`);
  if (plan.executor.kind === "subagent") {
    if (actor.agent_id !== null) throw new PlanError("a subagent delivers its plan for review; delivery isn't built yet");
    if (plan.status !== "delivered") throw new PlanError(`plan "${id}" is handed to a subagent and hasn't been delivered yet`);
  }
  const open = plan.tasks.filter((t) => !FINAL_STATES.includes(t.state));
  const problems = [];
  if (open.length) problems.push(`open tasks: ${open.map((t) => `${t.id} (${t.state})`).join(", ")}`);
  const openChildren = plan.tasks.flatMap((t) => t.children).map((c) => store.get(c)).filter((c) => c.status !== "closed");
  if (openChildren.length) problems.push(`open child plans: ${openChildren.map((c) => `${c.id} (${c.status})`).join(", ")}`);
  const missing = deliverableProblem(plan.deliverable);
  if (missing) problems.push(missing);
  if (problems.length) throw new PlanError(`plan "${id}" can't close:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

  const at = now.toISOString();
  plan.status = "closed";
  plan.closed = { at, by_session: actor.session_id, summary };
  plan.updated = at;
  store.save(plan);

  let resumed = null;
  if (plan.parent) {
    const parent = store.get(plan.parent.plan);
    const stillOpen = parent.tasks.flatMap((t) => t.children).filter((c) => c !== plan.id).map((c) => store.get(c)).filter((c) => c.status !== "closed");
    if (parent.status === "paused" && parent.owner.session_id === actor.session_id && stillOpen.length === 0 && activePlan(store, actor.session_id) === null) {
      resumed = { plan: parent.id, task: parent.resume_at };
      parent.status = "active";
      parent.resume_at = null;
      parent.updated = at;
      store.save(parent);
    }
  }
  return { plan, resumed };
}
