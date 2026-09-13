/**
 * Shared hook protocol: reading a payload, emitting a decision, reporting a failure, and locating
 * session state. One source of truth so the hooks cannot drift apart on the wire format.
 *
 * Dependency-free and never imported from dist/: a broken TypeScript build must not be able to
 * disable a hook.
 *
 * Every function here sets `process.exitCode` and returns instead of calling `process.exit()`.
 * Node documents `process.exit()` as ending the process "as quickly as possible even if there are
 * still asynchronous operations pending, including writes to process.stdout", which can cut off
 * the decision JSON on a slow pipe. Claude Code reads that JSON on every exit code (hooks
 * reference, "Exit code output"), so losing it loses the structured decision. Callers therefore
 * `return deny(...)` and let the process end on its own.
 *
 * Two failure doctrines, never mixed (see guard.sh and hook-open.sh):
 *   - GUARDRAILS fail CLOSED: `failClosed()` exits 2, the only code that blocks unconditionally.
 *   - INFORMATIONAL hooks fail OPEN but VISIBLY: `reportError()`. Stderr from a hook that exits 0
 *     "goes to the debug log only, never the transcript, and Claude never sees it" (hooks
 *     reference, "Exit code 0"), so a stderr-only report is a silent failure. `systemMessage` is
 *     the documented field that is shown to the user.
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

/**
 * PostToolUse: warn Claude about a tool result that already happened. The hooks reference says to
 * "exit 2 instead so Claude sees the stderr even though the tool already ran".
 */
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

/**
 * Informational hook: fail open, visibly. The session or turn continues; the user sees the
 * message in the transcript instead of it vanishing into the debug log.
 */
export function reportError(hook, err) {
  const message = err instanceof Error ? err.message : String(err);
  emit({ systemMessage: `stackmap ${hook}: ${message}` });
  process.stderr.write(`stackmap ${hook}: ${message}\n`);
  process.exitCode = 1;
}

/**
 * Where per-session state lives: $STACKMAP_STATE, else ~/.stackmap. A relative $STACKMAP_STATE is
 * rejected rather than resolved: hooks run with the project as cwd, so a relative path would
 * scatter state across every repo the plugin is used in.
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
