#!/usr/bin/env node
/**
 * PostToolUse hook: catch fetches that returned HTTP 200 with the wrong content — a login wall
 * or a bot check served with a success status, which an agent will then quote as fact. A
 * structural check (the status code) provably misses this class, so the body is inspected.
 * Exit 2 is a warning after the fact — the tool already ran — so Claude sees the caveat.
 *
 * Informational: a parse failure never breaks a tool result, but it is reported visibly, because a
 * sanity check that silently stopped running looks identical to one that found nothing.
 */
import { readPayload, reportError, warnAfterTool } from "./hook-lib.mjs";

const MARKERS = [
  /sign\s?in to (your|continue)/i, /you (?:need|must) (?:to )?(?:be )?(?:sign|log)(?:ed)?\s?in/i,
  /please (?:sign|log)\s?in/i, /create an account/i, /enable javascript/i,
  /access denied/i, /403 forbidden/i, /are you a robot/i, /verify you are human/i,
  /subscribe to (?:read|continue)/i, /this content is not available/i,
];
const MIN_CHARS = 200;

function textOf(resp) {
  if (typeof resp === "string") return resp;
  if (!resp || typeof resp !== "object") return "";
  for (const k of ["content", "text", "result", "output", "body"]) {
    const v = resp[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("\n");
  }
  return JSON.stringify(resp);
}

async function main() {
  const input = await readPayload();
  const body = textOf(input.tool_response ?? input.tool_result ?? "");
  const url = input?.tool_input?.url ?? input?.tool_input?.prompt ?? "(unknown)";

  const hits = MARKERS.filter((re) => re.test(body)).map((re) => re.source);
  const tooShort = body.trim().length < MIN_CHARS;
  if (hits.length === 0 && !tooShort) return;

  const reasons = [];
  if (hits.length) reasons.push(`content matches login-wall/blocked markers (${hits.slice(0, 2).join(", ")})`);
  if (tooShort) reasons.push(`body is only ${body.trim().length} chars`);

  warnAfterTool(
    `Fetch returned a successful status but suspicious content for ${url}: ${reasons.join("; ")}. ` +
      `Do NOT state conclusions from this response. Re-fetch with authentication, use an MCP connector for this service, or ask for the content directly.`,
  );
}

main().catch((err) => reportError("fetch-sanity", `fetch sanity check did not run — ${err?.message ?? err}`));
