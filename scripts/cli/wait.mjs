import { execSync } from "node:child_process";
import { parseArgs, numberFlag } from "./args.mjs";

/** Poll a command until it succeeds or matches a pattern, in one agent turn. */
export async function wait(argv) {
  const { flags } = parseArgs(argv);
  const cmd = flags.cmd;
  if (!cmd || cmd === true) throw new Error("usage: sm wait --cmd '<shell>' [--until <regex>] [--fail <regex>] [--every S] [--timeout S] [--json]");
  const asJson = Boolean(flags.json);
  const every = (numberFlag(flags, "every", { min: 0.01 }) ?? 15) * 1000;
  const timeout = (numberFlag(flags, "timeout", { min: 0.01 }) ?? 600) * 1000;
  const until = flags.until && flags.until !== true ? new RegExp(String(flags.until), "i") : null;
  const failRe = flags.fail && flags.fail !== true ? new RegExp(String(flags.fail), "i") : null;
  const started = Date.now();
  let attempts = 0, last = "";

  const finish = (status, code, text) => {
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    if (asJson) {
      console.log(JSON.stringify({ output: last, _stats: { status, attempts, elapsedSeconds } }));
    } else {
      process.stdout.write(last);
      console.error(`-- ${text} after ${attempts} attempt(s), ${elapsedSeconds}s`);
    }
    return code;
  };

  while (Date.now() - started < timeout) {
    attempts++;
    let out = "", ok = true;
    try {
      out = execSync(String(cmd), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: every });
    } catch (err) {
      ok = false;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    last = out;
    if (failRe && failRe.test(out)) return finish("failed", 1, "FAILED: matched --fail pattern");
    if (until ? until.test(out) : ok) return finish("satisfied", 0, "satisfied");
    if (Date.now() - started + every >= timeout) break;
    await new Promise((r) => setTimeout(r, every));
  }
  return finish("timeout", 2, "TIMEOUT without matching");
}
