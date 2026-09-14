/**
 * Reads a subagent transcript (the JSONL at a SubagentStop payload's `agent_transcript_path`) and
 * returns the Bash calls it recorded, with their results.
 *
 * Record shapes (captured from a real auditor stop, Claude Code 2.1.231):
 *   - assistant records carry `message.content[]` blocks `{type: "tool_use", id, name, input}`;
 *   - user records carry `{type: "tool_result", tool_use_id, content, is_error}`, `content` a string;
 *   - output too large to keep inline is replaced by a `<persisted-output>` preview whose
 *     "Full output saved to: <path>" line names a file in the session's `tool-results/` directory.
 *
 * Not a hook: it never reads a payload and is imported by audit-check.mjs. Dependency-free.
 * Anything it cannot read the way it expects throws TranscriptError, never a partial answer.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export class TranscriptError extends Error {}

/** Write lag: re-read every 5 s, for up to 50 s, while a result the check needs isn't written yet. */
export const LAG_RETRY_MS = 5_000;
export const LAG_WINDOW_MS = 50_000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the transcript and run `check(calls)` on it. `check` returns `{ waiting, blocking, ... }`;
 * while `waiting` is non-empty (a command ran but its result isn't written yet), or the file's last
 * line is still being written and something failed to match, re-read every `retryMs` until
 * `windowMs` has passed. Returns the last check's result, plus `tailIncomplete`.
 */
export async function checkTranscript(transcriptPath, check, { retryMs = LAG_RETRY_MS, windowMs = LAG_WINDOW_MS, sleep = pause, now = Date.now } = {}) {
  const deadline = now() + windowMs;
  for (;;) {
    const { calls, tailIncomplete } = await readBashCalls(transcriptPath);
    const result = check(calls);
    const unsettled = result.waiting.length > 0 || (tailIncomplete && result.blocking.length > 0);
    if (!unsettled || now() + retryMs > deadline) return { ...result, tailIncomplete };
    await sleep(retryMs);
  }
}

const PERSISTED = /^<persisted-output>\n[^\n]*Full output saved to: ([^\n]+)\n/;

/**
 * The Bash calls in a transcript, in order: `{ id, command, result }`, where `result` is
 * `{ output, isError, persistedFrom }` or null when no result has been recorded yet.
 * `tailIncomplete` is true when the file's last line has no newline yet (a write in progress).
 */
export async function readBashCalls(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath === "") {
    throw new TranscriptError("the SubagentStop payload has no agent_transcript_path");
  }
  if (!isAbsolute(transcriptPath)) {
    throw new TranscriptError(`agent_transcript_path is not absolute: "${transcriptPath}"`);
  }
  // A subagent transcript is <projects>/<session>/subagents/agent-<id>.jsonl; the session's saved
  // tool output sits beside it in <projects>/<session>/tool-results/.
  if (basename(dirname(transcriptPath)) !== "subagents") {
    throw new TranscriptError(
      `agent_transcript_path is not in a subagents/ directory, so its session's tool-results/ can't be located: ${transcriptPath}`,
    );
  }
  const toolResults = join(dirname(dirname(transcriptPath)), "tool-results");

  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch (err) {
    throw new TranscriptError(`cannot read the agent transcript ${transcriptPath}: ${err.message}`);
  }
  const tailIncomplete = raw.length > 0 && !raw.endsWith("\n");
  const lines = raw.split("\n");
  // A last line without its newline is still being written: leave it out rather than misread it.
  lines.pop();

  const calls = [];
  const byId = new Map();
  const resultIds = new Set();
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      throw new TranscriptError(`line ${index + 1} of ${transcriptPath} is not valid JSON: ${err.message}`);
    }
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && block.name === "Bash") {
        if (byId.has(block.id)) throw new TranscriptError(`tool_use id ${block.id} appears twice in ${transcriptPath}`);
        if (typeof block.input?.command !== "string") {
          throw new TranscriptError(`Bash tool_use ${block.id} has no string input.command (line ${index + 1})`);
        }
        const call = { id: block.id, command: block.input.command, result: null };
        byId.set(block.id, call);
        calls.push(call);
      } else if (block?.type === "tool_result" && byId.has(block.tool_use_id)) {
        if (resultIds.has(block.tool_use_id)) {
          throw new TranscriptError(`tool_result for ${block.tool_use_id} appears twice in ${transcriptPath}`);
        }
        resultIds.add(block.tool_use_id);
        byId.get(block.tool_use_id).result = bashResult(block, toolResults, index + 1);
      }
    }
  }
  return { calls, tailIncomplete };
}

function bashResult(block, toolResults, lineNumber) {
  if (typeof block.content !== "string") {
    throw new TranscriptError(
      `tool_result ${block.tool_use_id} (line ${lineNumber}) has ${Array.isArray(block.content) ? "array" : typeof block.content} content; only string content is handled`,
    );
  }
  const isError = block.is_error === true;
  const persisted = PERSISTED.exec(block.content);
  if (!persisted) return { output: block.content, isError, persistedFrom: null };

  const path = persisted[1].trim();
  if (!isAbsolute(path) || dirname(path) !== toolResults) {
    throw new TranscriptError(`tool_result ${block.tool_use_id} points at ${path}, which is not in ${toolResults}`);
  }
  let output;
  try {
    output = readFileSync(path, "utf8");
  } catch (err) {
    throw new TranscriptError(`tool_result ${block.tool_use_id} was saved to ${path}, which cannot be read: ${err.message}`);
  }
  return { output, isError, persistedFrom: path };
}
