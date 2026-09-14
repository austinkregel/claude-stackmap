/**
 * Shared hook protocol: reading a payload, emitting a decision, reporting a failure, and locating
 * session state.
 *
 * Dependency-free and never imported from dist/, so a broken TypeScript build cannot disable a hook.
 *
 * Every function sets `process.exitCode` and returns; `process.exit()` can cut off the decision
 * JSON before stdout flushes.
 *
 * Two failure modes, never mixed (see guard.sh and hook-open.sh):
 *   - Guardrails fail closed: `failClosed()` exits 2, the only code that blocks unconditionally.
 *   - Informational hooks fail open, visibly: `reportError()` emits a `systemMessage`, because
 *     stderr from a hook that exits 0 is never shown.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Read stdin to completion. */
export async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

/**
 * Read and parse the hook payload. Throws on empty or malformed input; the caller decides whether
 * that blocks (guardrail) or is reported (informational).
 */
export async function readPayload() {
  const raw = await readStdin();
  if (!raw.trim()) throw new Error("empty stdin");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("payload is not a JSON object");
  }
  return parsed;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

/** PreToolUse: deny the call. Exit 2 blocks even if the JSON were somehow unreadable. */
export function deny(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
  process.stderr.write(reason + "\n");
  process.exitCode = 2;
}

/** Stop: block the turn from ending, in the documented top-level `decision` shape. */
export function blockStop(reason) {
  emit({ decision: "block", reason });
  process.stderr.write(reason + "\n");
  process.exitCode = 2;
}

/** SessionStart / SubagentStart / UserPromptSubmit: add text to Claude's context. */
export function addContext(hookEventName, text) {
  emit({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

/** PostToolUse: warn Claude about a tool result that already happened. Exit 2 makes Claude see stderr. */
export function warnAfterTool(text) {
  process.stderr.write(text + "\n");
  process.exitCode = 2;
}

/** Guardrail: block a call that could not be evaluated. */
export function failClosed(hook, what) {
  return deny(
    `stackmap ${hook}: ${what} — blocking rather than failing open.\n` +
      `A guard that cannot evaluate a call must not permit it. Re-issue the call, or fix the hook ` +
      `or the config if this repeats.`,
  );
}

/** Informational hook: fail open, visibly. Exit 1 is non-blocking; the user sees `systemMessage`. */
export function reportError(hook, err) {
  const message = err instanceof Error ? err.message : String(err);
  emit({ systemMessage: `stackmap ${hook}: ${message}` });
  process.stderr.write(`stackmap ${hook}: ${message}\n`);
  process.exitCode = 1;
}

/**
 * Where per-session state lives: $STACKMAP_STATE, else ~/.stackmap. A relative $STACKMAP_STATE is
 * rejected because hooks run with the project as cwd.
 */
export function stateDir() {
  const fromEnv = process.env.STACKMAP_STATE;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!isAbsolute(fromEnv)) {
      throw new Error(`STACKMAP_STATE must be an absolute path, got "${fromEnv}"`);
    }
    return fromEnv;
  }
  return join(homedir(), ".stackmap");
}

export function sessionsDir() {
  return join(stateDir(), "sessions");
}

/** Strip anything unsafe in a filename, so a session id cannot escape the sessions directory. */
export function safeSessionId(id) {
  return String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "");
}
