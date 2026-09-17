// Types for plan-store.mjs, which the TypeScript server imports at runtime. Keep in lockstep with
// that file: every export there is declared here, and plans-test checks the two lists agree.

export class PlanError extends Error {}

export type PlanStatus = "draft" | "active" | "paused" | "delivered" | "closed";
export type TaskState = "todo" | "doing" | "done" | "not_needed" | "wont_deliver" | "already_done";
export type UserResolvedState = "not_needed" | "wont_deliver" | "already_done";

export const PLAN_STATUSES: readonly PlanStatus[];
export const TASK_STATES: readonly TaskState[];
export const USER_RESOLVED_STATES: readonly UserResolvedState[];
export const FINAL_STATES: readonly TaskState[];
export const DELIVERABLE_KINDS: readonly Deliverable["kind"][];

export type Deliverable =
  | { kind: "in-place" }
  | { kind: "document"; path: string }
  | { kind: "branch"; repo: string; base: string; branch: string | null };

export interface Resolution {
  reason: string;
  user_quote: string;
  transcript_uuid: string;
  at: string;
}

export interface Task {
  id: string;
  text: string;
  state: TaskState;
  evidence: string | null;
  resolution: Resolution | null;
  children: string[];
}

export interface Revision {
  sha256: string;
  text: string;
  plan_file: string;
  at: string;
}

export interface Plan {
  format: 1;
  id: string;
  title: string;
  status: PlanStatus;
  parent: { plan: string; task: string } | null;
  resume_at: string | null;
  projects: string[];
  deliverable: Deliverable;
  executor: { kind: "main" | "subagent"; agent_id: string | null; worktree: string | null; branch: string | null };
  owner: { session_id: string; since: string };
  source: { kind: "tool" | "plan-mode"; revisions: Revision[] };
  tasks: Task[];
  created: string;
  updated: string;
  closed: { at: string; by_session: string; summary: string } | null;
}

export interface Actor {
  session_id: string;
  agent_id: string | null;
}

export interface Malformed {
  file: string;
  error: string;
}

export function plansDir(): string;
export function validatePlan(plan: unknown): string[];
export function deliverableProblem(deliverable: Deliverable): string | null;

export class PlanStore {
  constructor(dir: string);
  readonly dir: string;
  exists(id: string): boolean;
  get(id: string): Plan;
  list(): { plans: Plan[]; malformed: Malformed[] };
  save(plan: Plan): void;
}

export function openStore(dir?: string): PlanStore;
export function activePlan(store: PlanStore, sessionId: string): Plan | null;

export interface NewPlanArgs {
  title: string;
  projects?: string[];
  deliverable: Deliverable;
  tasks?: string[];
}

export function createPlan(store: PlanStore, actor: Actor, args: NewPlanArgs, now?: Date): Plan;
export function createChild(store: PlanStore, actor: Actor, args: NewPlanArgs & { from_task: string }, now?: Date): { plan: Plan; parent: Plan };
export function selectPlan(
  store: PlanStore,
  actor: Actor,
  args: { id: string; take_over?: boolean },
  now?: Date,
): { plan: Plan; paused: string | null; movedFrom: string | null; moved: string[] };
export function addTasks(store: PlanStore, actor: Actor, args: { id: string; tasks: string[]; after?: string }, now?: Date): { plan: Plan; added: string[] };
export function updateTask(
  store: PlanStore,
  actor: Actor,
  args: { id: string; task: string; text?: string; state?: "todo" | "doing" | "done"; evidence?: string },
  now?: Date,
): { plan: Plan; task: Task };
export function resolveTasks(
  store: PlanStore,
  actor: Actor,
  args: { id: string; tasks: string[]; state: UserResolvedState; reason: string; user_quote: string; transcript_uuid: string },
  now?: Date,
): { plan: Plan; resolved: string[] };
export function closePlan(
  store: PlanStore,
  actor: Actor,
  args: { id: string; summary: string },
  now?: Date,
): { plan: Plan; resumed: { plan: string; task: string | null } | null };
