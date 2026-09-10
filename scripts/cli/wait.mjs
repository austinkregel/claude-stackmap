import { execSync } from "node:child_process";
import { parseArgs } from "./args.mjs";

/**
 * Poll a command until it succeeds or matches a pattern, in ONE agent turn.
 * The alternative is a `sleep N && <check>` loop re-issued once per turn, where every poll
 * costs a full round trip and the turns add up faster than the wait does.
 */
export async function wait(argv) {
  const { flags } = parseArgs(argv);
  const cmd = flags.cmd;
  if (!cmd || cmd === true) throw new Error("usage: sm wait --cmd '<shell>' [--until <regex>] [--fail <regex>] [--every S] [--timeout S]");
  const every = Number(flags.every ?? 15) * 1000;
  const timeout = Number(flags.timeout ?? 600) * 1000;
  const until = flags.until && flags.until !== true ? new RegExp(String(flags.until), "i") : null;
  const failRe = flags.fail && flags.fail !== true ? new RegExp(String(flags.fail), "i") : null;
  const started = Date.now();
  let attempts = 0, last = "";

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
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (failRe && failRe.test(out)) {
      process.stdout.write(out);
      console.error(`-- FAILED after ${attempts} attempt(s), ${elapsed}s: matched --fail pattern`);
      return 1;
    }
    if (until ? until.test(out) : ok) {
      process.stdout.write(out);
      console.error(`-- satisfied after ${attempts} attempt(s), ${elapsed}s`);
      return 0;
    }
    if (Date.now() - started + every >= timeout) break;
    await new Promise((r) => setTimeout(r, every));
  }
  process.stdout.write(last);
  console.error(`-- TIMEOUT after ${attempts} attempt(s), ${Math.round((Date.now() - started) / 1000)}s without matching`);
  return 2;
}
