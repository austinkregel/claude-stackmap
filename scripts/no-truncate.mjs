#!/usr/bin/env node
/**
 * PreToolUse(Bash): block feeding a live command's output into a truncating filter, unless `tee`
 * captures the full output first.
 *
 * The rule, precisely:
 *   - In a pipeline, if any stage after the first is a truncating filter (configurable,
 *     guard.noTruncate.consumers), the stage straight after the producer must be `tee`.
 *     `cmd | tee f | tail` passes; `cmd | tail | tee f` and `cmd | sort | tee f | tail` do not.
 *   - A `tee` in a different command does not count: `cmd && tee f | tail` blocks, because the
 *     `;` / `&&` / `||` separated command never saw the output.
 *   - A truncating filter reading a process substitution (`tail <(cmd)`, `tail < <(cmd)`) blocks.
 *   - Filters used on FILES (`grep x file`, `tail -5 build.log`, `cmd | tee f && tail f`) pass:
 *     the ban is on truncating a live command's output, not on searching a file.
 *
 * `wc`, `sort`, and `jq` are not truncating filters by default; they transform or summarise output.
 *
 * Fails closed: an unreadable payload, invalid config, a command the shell would reject, or a
 * filter whose name is only known at runtime (`cmd | $PAGER`) blocks.
 *
 * Stated limits: pipelines inside `eval` strings, aliases, shell functions, and scripts on disk
 * are not seen; neither is a program that truncates its own output.
 */
import { deny, failClosed, readPayload } from "./hook-lib.mjs";
import { loadHookConfig } from "./hook-config.mjs";
import { commandName, parse, ShellParseError, walkStages } from "./shell-tokens.mjs";

const HOOK = "no-truncate";

class CannotEvaluate extends Error {}

/**
 * Names of truncating programs a stage runs: itself, or (for a subshell) anything inside it. A
 * subshell is not analysed for which inner command reads the pipe, so `cmd | (cd x && grep y file)`
 * deliberately blocks.
 */
function truncatorsIn(stage, consumers) {
  const found = [];
  const { name, dynamic } = commandName(stage);
  if (dynamic) throw new CannotEvaluate(`a pipeline stage whose program is only known at runtime (${stage.source})`);
  if (name && consumers.has(name)) found.push(name);
  for (const nested of stage.nested) {
    walkStages(nested, (inner) => {
      const n = commandName(inner).name;
      if (n && consumers.has(n)) found.push(n);
    });
  }
  return found;
}

/** The pipeline as a one-line label for the block message: each stage's first line, joined by its pipe operator. */
const firstLine = (stage) => {
  const [line, ...rest] = stage.source.split("\n");
  return rest.length ? `${line.trim()} …` : line.trim();
};

function describe(pipeline) {
  return pipeline.stages.map((stage, i) => (i === 0 ? firstLine(stage) : `${pipeline.ops[i - 1]} ${firstLine(stage)}`)).join(" ");
}

function readsProcessSubstitution(stage) {
  const targets = [...stage.words, ...stage.redirects.map((r) => r.target)];
  return targets.some((w) => w.parts.some((p) => p.kind === "procsub" && p.dir === "<"));
}

/** The first violation in the command, as a description, or null. */
function findViolation(command, consumerList) {
  const consumers = new Set(consumerList);
  return (
    walkStages(
      parse(command),
      (stage, pipeline, index) => {
        if (index === 0 && pipeline.stages.length > 1) {
          const consumerStages = pipeline.stages.slice(1);
          const firstConsumer = commandName(consumerStages[0]);
          if (firstConsumer.name === "tee") return undefined;
          for (const consumer of consumerStages) {
            const names = truncatorsIn(consumer, consumers);
            if (names.length) return `\`${describe(pipeline)}\` pipes output into ${names[0]} without tee first`;
          }
        }
        const { name } = commandName(stage);
        if (name && consumers.has(name) && readsProcessSubstitution(stage)) {
          return `\`${firstLine(stage)}\` runs ${name} over a process substitution's output`;
        }
        return undefined;
      },
      (unknown) => {
        throw new CannotEvaluate(unknown);
      },
    ) ?? null
  );
}

const reasonFor = (violation, consumers) =>
  `Blocked: ${violation}.\n\n` +
  "House rule: never cut down a live command's output. It hides errors and context, and the " +
  "command may not be safe to run again just to see what was cut.\n\n" +
  "Capture the full output first, then read it:\n" +
  "  <command> 2>&1 | tee /tmp/<name>.log\n" +
  "tee must be the command straight after the pipe; a filter after it is fine " +
  "(`<command> 2>&1 | tee /tmp/<name>.log | tail -20`). Searching or tailing the saved FILE " +
  "afterwards is fine too. If the program has its own limiting flag, use that.\n\n" +
  `Truncating filters (guard.noTruncate.consumers): ${consumers.join(", ")}.`;

async function main() {
  let input;
  try {
    input = await readPayload();
  } catch (err) {
    return failClosed(HOOK, `unreadable hook payload (${err.message})`);
  }
  if (input.tool_name !== "Bash") return;

  let cfg;
  try {
    cfg = loadHookConfig();
  } catch (err) {
    return failClosed(HOOK, err.message);
  }
  const { enabled, consumers } = cfg.guard.noTruncate;
  if (!enabled) return;

  const command = input?.tool_input?.command;
  if (typeof command !== "string") return failClosed(HOOK, "Bash call with no readable command string");
  if (!command.trim()) return;

  let violation;
  try {
    violation = findViolation(command, consumers);
  } catch (err) {
    if (err instanceof CannotEvaluate || err instanceof ShellParseError) {
      return failClosed(HOOK, `cannot evaluate this command: ${err.message}`);
    }
    throw err;
  }
  if (violation) return deny(reasonFor(violation, consumers));
}

main().catch((err) => failClosed(HOOK, `internal error (${err?.message ?? err})`));
