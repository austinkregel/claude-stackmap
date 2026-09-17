#!/usr/bin/env node
/**
 * PreToolUse(stackmap plan_* tools): stamp the caller's identity into the call as `_stackmap`.
 *
 * The MCP server can't tell which session is calling: its environment keeps the startup session id
 * after /clear, and one server process serves every subagent. The hook payload always names the
 * current session (and the subagent, if any), so this hook is the only source of that identity.
 * Whatever the model put in `_stackmap` is replaced. No permissionDecision is set, so the user's
 * normal permission prompts still apply.
 *
 * Fails closed: a plan call that can't be stamped is blocked, since the server refuses unstamped
 * calls anyway and a block names the reason.
 */
import { failClosed, readPayload, replaceToolInput } from "./hook-lib.mjs";

const HOOK = "plan-identity";
const PLAN_TOOL =/^mcp__plugin_stackmap_stackmap__plan_[a-z_]+$/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.length > 0;

async function main() {
  let input;
  try {
    input = await readPayload();
  } catch (err) {
    return failClosed(HOOK, `unreadable hook payload (${err.message})`);
  }
  if (input.hook_event_name !== "PreToolUse") {
    return failClosed(HOOK, `expected a PreToolUse payload, got ${JSON.stringify(input.hook_event_name)}`);
  }
  if (typeof input.tool_name !== "string" || !PLAN_TOOL.test(input.tool_name)) {
    return failClosed(HOOK, `called for ${JSON.stringify(input.tool_name)}, which isn't a stackmap plan tool; check the hooks.json matcher`);
  }
  if (!isPlainObject(input.tool_input)) return failClosed(HOOK, `${input.tool_name} call with no readable tool_input`);
  for (const key of ["session_id", "cwd", "transcript_path"]) {
    if (!nonEmpty(input[key])) return failClosed(HOOK, `the payload has no ${key}, so the caller can't be identified`);
  }
  for (const key of ["agent_id", "agent_type"]) {
    if (input[key] !== undefined && !nonEmpty(input[key])) return failClosed(HOOK, `the payload's ${key} is ${JSON.stringify(input[key])}`);
  }

  replaceToolInput({
    ...input.tool_input,
    _stackmap: {
      session_id: input.session_id,
      agent_id: input.agent_id ?? null,
      agent_type: input.agent_type ?? null,
      cwd: input.cwd,
      transcript_path: input.transcript_path,
      transcript_uuid: null,
    },
  });
}

main().catch((err) => failClosed(HOOK, `internal error (${err?.message ?? err})`));
