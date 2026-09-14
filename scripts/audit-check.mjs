#!/usr/bin/env node
/**
 * SubagentStop hook for stackmap:adversarial-auditor: the auditor can't finish until its final
 * message carries a complete audit report (see AUDIT_FORM in deliverables.mjs).
 *
 * After one block (`stop_hook_active`), it lets the auditor finish and tells the user what the
 * report still lacks. Fails open, visibly, on internal errors.
 */
import { AUDIT_FORM, AUDITOR_AGENT as AGENT, auditReportProblems } from "./deliverables.mjs";
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

  const missing = auditReportProblems(String(input.last_assistant_message ?? ""));
  if (missing.length === 0) return;

  if (input.stop_hook_active === true) {
    return notifyUser(HOOK, `the adversarial auditor finished with an incomplete report, still missing: ${missing.join("; ")}`);
  }
  blockStop(
    "Your audit report is incomplete. Missing:\n\n" +
      missing.map((m) => `  - ${m}`).join("\n") +
      "\n\nEnd with:\n\n" +
      AUDIT_FORM.split("\n").map((l) => `  ${l}`).join("\n"),
  );
}

main().catch((err) => reportError(HOOK, `audit report was not checked — ${err?.message ?? err}`));
