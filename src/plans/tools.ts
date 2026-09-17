import * as store from "../../scripts/plan-store.mjs";
import type { Actor, Deliverable, Plan, PlanStore, Task } from "../../scripts/plan-store.mjs";
import { booleanArg, countArg, show, stringArg, stringListArg } from "../args.js";

/**
 * The plan_* tools. Every call acts for the session the plan-identity hook stamped into
 * `_stackmap`; the server has no reliable session identity of its own (its environment keeps the
 * startup session id after /clear), so a call without a stamp is refused, never guessed.
 */

interface Stamp extends Actor {
  cwd: string;
  transcript_path: string;
  /** Set only on plan_resolve_task, after the hook found the user's quote in the transcript. */
  transcript_uuid: string | null;
}

const STAMP_KEYS = ["session_id", "agent_id", "agent_type", "cwd", "transcript_path", "transcript_uuid"];

function stamp(tool: string, value: unknown): Stamp {
  if (value === undefined) {
    throw new Error(`${tool}: the call carries no _stackmap identity. The stackmap plan-identity hook adds it to every plan_* call; check that the plugin's hooks are loaded.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${tool}: '_stackmap' must be an object, got ${show(value)}.`);
  const v = value as Record<string, unknown>;
  const unknown = Object.keys(v).filter((k) => !STAMP_KEYS.includes(k));
  if (unknown.length) throw new Error(`${tool}: '_stackmap' has unknown key(s) ${unknown.join(", ")}.`);
  const req = (k: string) => {
    if (typeof v[k] !== "string" || (v[k] as string) === "") throw new Error(`${tool}: '_stackmap.${k}' must be a non-empty string, got ${show(v[k])}.`);
    return v[k] as string;
  };
  const opt = (k: string) => {
    if (v[k] !== null && (typeof v[k] !== "string" || v[k] === "")) throw new Error(`${tool}: '_stackmap.${k}' must be a non-empty string or null, got ${show(v[k])}.`);
    return v[k] as string | null;
  };
  opt("agent_type");
  return { session_id: req("session_id"), agent_id: opt("agent_id"), cwd: req("cwd"), transcript_path: req("transcript_path"), transcript_uuid: opt("transcript_uuid") };
}

const actorOf = (s: Stamp): Actor => ({ session_id: s.session_id, agent_id: s.agent_id });

function requireString(tool: string, name: string, value: unknown): string {
  const s = stringArg(tool, name, value);
  if (s === undefined) throw new Error(`${tool} requires '${name}'.`);
  return s;
}

function deliverableArg(tool: string, value: unknown): Deliverable {
  if (value === undefined) throw new Error(`${tool} requires 'deliverable'.`);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${tool}: 'deliverable' must be an object, got ${show(value)}.`);
  // The store validates the shape and names every problem.
  return value as Deliverable;
}

const openTasks = (p: Plan) => p.tasks.filter((t) => !store.FINAL_STATES.includes(t.state));
const taskLine = (t: Task) => ({ id: t.id, state: t.state, text: t.text, children: t.children });

function summary(p: Plan) {
  const done = p.tasks.filter((t) => store.FINAL_STATES.includes(t.state)).length;
  return { id: p.id, title: p.title, status: p.status, owner: p.owner.session_id, parent: p.parent, tasks: `${done}/${p.tasks.length} final`, updated: p.updated };
}

/** The ancestors of a plan, nearest first, each with the task it resumes at. */
function ancestors(s: PlanStore, p: Plan) {
  const out: Array<{ id: string; title: string; status: string; resume_at: string | null }> = [];
  let cur = p;
  while (cur.parent) {
    cur = s.get(cur.parent.plan);
    out.push({ id: cur.id, title: cur.title, status: cur.status, resume_at: cur.resume_at });
  }
  return out;
}

export function planStatus(s: PlanStore, args: any) {
  const who = stamp("plan_status", args._stackmap);
  const { plans, malformed } = s.list();
  const mine = plans.filter((p) => p.owner.session_id === who.session_id);
  const active = store.activePlan(s, who.session_id);
  return {
    plansDir: s.dir,
    session: who.session_id,
    active: active
      ? {
          ...summary(active),
          deliverable: active.deliverable,
          executor: active.executor,
          openTasks: openTasks(active).map(taskLine),
          ancestors: ancestors(s, active),
          openChildren: active.tasks.flatMap((t) => t.children).map((c) => s.get(c)).filter((c) => c.status !== "closed").map(summary),
        }
      : null,
    paused: mine.filter((p) => p.status === "paused").map(summary),
    delivered: mine.filter((p) => p.status === "delivered").map(summary),
    drafts: mine.filter((p) => p.status === "draft").map(summary),
    malformedFiles: malformed,
  };
}

export function planCreate(s: PlanStore, args: any) {
  const T = "plan_create";
  const who = stamp(T, args._stackmap);
  const plan = store.createPlan(s, actorOf(who), {
    title: requireString(T, "title", args.title),
    projects: stringListArg(T, "projects", args.projects),
    deliverable: deliverableArg(T, args.deliverable),
    tasks: stringListArg(T, "tasks", args.tasks),
  });
  return { created: plan.id, plan };
}

export function planCreateChild(s: PlanStore, args: any) {
  const T = "plan_create_child";
  const who = stamp(T, args._stackmap);
  const r = store.createChild(s, actorOf(who), {
    title: requireString(T, "title", args.title),
    from_task: requireString(T, "from_task", args.from_task),
    projects: stringListArg(T, "projects", args.projects),
    deliverable: deliverableArg(T, args.deliverable),
    tasks: stringListArg(T, "tasks", args.tasks),
  });
  return {
    created: r.plan.id,
    plan: r.plan,
    paused: { id: r.parent.id, resume_at: r.parent.resume_at },
    note: `When "${r.plan.id}" closes, "${r.parent.id}" becomes active again at task ${r.parent.resume_at}.`,
  };
}

export function planSelect(s: PlanStore, args: any) {
  const T = "plan_select";
  const who = stamp(T, args._stackmap);
  const r = store.selectPlan(s, actorOf(who), { id: requireString(T, "id", args.id), take_over: booleanArg(T, "take_over", args.take_over, false) });
  return { active: r.plan.id, paused: r.paused, takenOverFrom: r.movedFrom, moved: r.moved, plan: r.plan };
}

export function planGet(s: PlanStore, args: any) {
  const T = "plan_get";
  stamp(T, args._stackmap);
  const plan = s.get(requireString(T, "id", args.id));
  return { plan, ancestors: ancestors(s, plan) };
}

const LIST_STATUSES = store.PLAN_STATUSES as readonly string[];

export function planList(s: PlanStore, args: any) {
  const T = "plan_list";
  const who = stamp(T, args._stackmap);
  const statuses = stringListArg(T, "status", args.status);
  const bad = (statuses ?? []).filter((x) => !LIST_STATUSES.includes(x));
  if (bad.length) throw new Error(`${T}: unknown status ${bad.map(show).join(", ")}. Known: ${LIST_STATUSES.join(", ")}.`);
  const project = stringArg(T, "project", args.project);
  const owner = stringArg(T, "owner", args.owner);
  const under = stringArg(T, "under", args.under);
  const limit = countArg(T, "limit", args.limit, 50, 1);
  const offset = countArg(T, "offset", args.offset, 0, 0);
  const { plans, malformed } = s.list();
  if (under !== undefined) s.get(under); // an unknown root is an error, not an empty list
  const byId = new Map(plans.map((p) => [p.id, p]));
  const isUnder = (p: Plan) => {
    for (let cur = p.parent; cur; cur = byId.get(cur.plan)?.parent ?? null) if (cur.plan === under) return true;
    return false;
  };
  const ownerId = owner === "me" ? who.session_id : owner;
  const hits = plans.filter((p) =>
    (statuses === undefined ? p.status !== "closed" : statuses.includes(p.status)) &&
    (project === undefined || p.projects.includes(project)) &&
    (ownerId === undefined || p.owner.session_id === ownerId) &&
    (under === undefined || isUnder(p)));
  return {
    plansDir: s.dir,
    matched: hits.length,
    offset,
    limit,
    returned: Math.min(limit, Math.max(0, hits.length - offset)),
    plans: hits.slice(offset, offset + limit).map(summary),
    malformedFiles: malformed,
    note: statuses === undefined ? "Closed plans are left out unless 'status' names closed." : undefined,
  };
}

export function planAddTask(s: PlanStore, args: any) {
  const T = "plan_add_task";
  const who = stamp(T, args._stackmap);
  const tasks = stringListArg(T, "tasks", args.tasks);
  if (tasks === undefined) throw new Error(`${T} requires 'tasks'.`);
  const r = store.addTasks(s, actorOf(who), { id: requireString(T, "id", args.id), tasks, after: stringArg(T, "after", args.after) });
  return { added: r.added, tasks: r.plan.tasks.map(taskLine) };
}

const UPDATE_STATES = ["todo", "doing", "done"] as const;

export function planUpdateTask(s: PlanStore, args: any) {
  const T = "plan_update_task";
  const who = stamp(T, args._stackmap);
  const state = stringArg(T, "state", args.state);
  if (state !== undefined && !(UPDATE_STATES as readonly string[]).includes(state)) {
    throw new Error(`${T}: 'state' must be one of ${UPDATE_STATES.join(", ")}, got ${show(state)}. Final states other than done go through plan_resolve_task.`);
  }
  const r = store.updateTask(s, actorOf(who), {
    id: requireString(T, "id", args.id),
    task: requireString(T, "task", args.task),
    text: stringArg(T, "text", args.text),
    state: state as (typeof UPDATE_STATES)[number] | undefined,
    evidence: stringArg(T, "evidence", args.evidence),
  });
  return { task: r.task, openTasks: openTasks(r.plan).map(taskLine) };
}

export function planResolveTask(s: PlanStore, args: any) {
  const T = "plan_resolve_task";
  const who = stamp(T, args._stackmap);
  if (who.transcript_uuid === null) {
    throw new Error(`${T}: the plan-identity hook didn't record where the user said this; the call can't be verified.`);
  }
  const tasks = stringListArg(T, "tasks", args.tasks);
  if (tasks === undefined) throw new Error(`${T} requires 'tasks'.`);
  const state = requireString(T, "state", args.state);
  if (!(store.USER_RESOLVED_STATES as readonly string[]).includes(state)) {
    throw new Error(`${T}: 'state' must be one of ${store.USER_RESOLVED_STATES.join(", ")}, got ${show(state)}.`);
  }
  const r = store.resolveTasks(s, actorOf(who), {
    id: requireString(T, "id", args.id),
    tasks,
    state: state as (typeof store.USER_RESOLVED_STATES)[number],
    reason: requireString(T, "reason", args.reason),
    user_quote: requireString(T, "user_quote", args.user_quote),
    transcript_uuid: who.transcript_uuid,
  });
  return { resolved: r.resolved, state, openTasks: openTasks(r.plan).map(taskLine) };
}

export function planClose(s: PlanStore, args: any) {
  const T = "plan_close";
  const who = stamp(T, args._stackmap);
  const r = store.closePlan(s, actorOf(who), { id: requireString(T, "id", args.id), summary: requireString(T, "summary", args.summary) });
  return {
    closed: r.plan.id,
    resumed: r.resumed,
    note: r.resumed ? `"${r.resumed.plan}" is active again; continue at task ${r.resumed.task}.` : undefined,
  };
}
