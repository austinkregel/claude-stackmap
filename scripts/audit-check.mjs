#!/usr/bin/env node
/**
 * SubagentStop hook for stackmap:adversarial-auditor: the auditor can't finish until its final
 * message carries a complete audit report (see AUDIT_FORM in deliverables.mjs), and until every
 * Reproducer on a SURVIVED or FALSIFIED verdict matches a Bash call its own transcript recorded.
 *
 * Two outcomes, kept apart:
 *   - blocked: problems the auditor can fix (a missing field, a command it never ran, output that
 *     doesn't match). After one block (`stop_hook_active`) it lets the auditor finish and tells the
 *     user what is still wrong.
 *   - surfaced: things the auditor can't fix (no transcript path, a transcript that can't be read,
 *     a command the shell parser rejects, output cut from an excerpt, a result still unwritten after
 *     the lag window). The user is told, with the auditor's report, and asked for the missing
 *     context; the auditor is not blocked for them.
 *
 * Fails open, visibly, on internal errors.
 */
import { checkTranscript, LAG_WINDOW_MS, TranscriptError } from "./agent-transcript.mjs";
import { AUDIT_FORM, AUDITOR_AGENT as AGENT, auditReportProblems, auditReproducers, auditVerdict, verifyReproducers } from "./deliverables.mjs";
import { blockStop, notifyUser, readPayload, reportError } from "./hook-lib.mjs";

const HOOK = "audit-check";

async function main() {
  const input = await readPayload();
  if (input.hook_event_name !== "SubagentStop") {
    throw new Error(`registered for an unexpected event "${input.hook_event_name}"; no audit report was checked`);
  }
  if (input.agent_type !== AGENT) {
    throw new Error(`registered for ${AGENT} but called for "${input.agent_type}"; that report was not checked`);
  }

  const text = String(input.last_assistant_message ?? "");
  const missing = auditReportProblems(text);
  const surfaced = [];

  const verdict = auditVerdict(text);
  const { groups } = auditReproducers(text);
  const transcriptPath = input.agent_transcript_path;
  if (typeof transcriptPath !== "string" || transcriptPath === "") {
    surfaced.push("the SubagentStop payload carried no agent_transcript_path, so no Reproducer could be checked against what the auditor ran");
  } else if ((verdict === "SURVIVED" || verdict === "FALSIFIED") && groups.length > 0) {
    try {
      const result = await checkTranscript(transcriptPath, (calls) => verifyReproducers(groups, calls));
      missing.push(...result.blocking);
      surfaced.push(...result.surfaced);
      for (const label of result.waiting) {
        surfaced.push(`${label}: the command is in the transcript but its result still wasn't written after ${LAG_WINDOW_MS / 1000} s, so it could not be checked`);
      }
    } catch (err) {
      if (!(err instanceof TranscriptError)) throw err;
      surfaced.push(`the auditor's transcript could not be read (${err.message}), so no Reproducer was checked`);
    }
  }

  const surfacedNote = surfaced.length ? `\n\nAlso could not be checked (these need the user, not a fix from you):\n${surfaced.map((s) => `  - ${s}`).join("\n")}` : "";

  if (missing.length > 0) {
    if (input.stop_hook_active === true) {
      return notifyUser(HOOK, `the adversarial auditor finished with an incomplete or unverified report, still missing: ${[...missing, ...surfaced].join("; ")}`);
    }
    return blockStop(
      "Your audit report is incomplete or doesn't match what you ran. Missing:\n\n" +
        missing.map((m) => `  - ${m}`).join("\n") +
        surfacedNote +
        "\n\nEnd with:\n\n" +
        AUDIT_FORM.split("\n").map((l) => `  ${l}`).join("\n"),
    );
  }
  if (surfaced.length > 0) {
    return notifyUser(
      HOOK,
      `the adversarial auditor's report could not be fully verified: ${surfaced.join("; ")}. ` +
        `Please confirm or fill in the missing context before relying on its verdict. Its report:\n\n${reportTail(text)}`,
    );
  }
}

/** The report block the auditor ended with, from its last `Claim:` line, for the user to read. */
function reportTail(text) {
  const at = text.lastIndexOf("Claim:");
  return at === -1 ? text : text.slice(at);
}

main().catch((err) => reportError(HOOK, `audit report was not checked — ${err?.message ?? err}`));
