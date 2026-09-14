#!/usr/bin/env node
/**
 * sm CLI suite: every subcommand run through bin/sm on temporary fixtures, checking output, the
 * counts footer, --json, and exit codes. No build needed.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sm = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sm");
const dir = mkdtempSync(join(tmpdir(), "stackmap-cli-"));
let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};
const run = (...args) => {
  const r = spawnSync(sm, args, { encoding: "utf8", cwd: dir });
  return { code: r.status, out: r.stdout, err: r.stderr, show: `exit ${r.status}; stdout ${JSON.stringify(r.stdout.slice(0, 200))}; stderr ${JSON.stringify(r.stderr.slice(0, 200))}` };
};
const json = (r) => {
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};
const f = (name, text) => {
  const p = join(dir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
};

try {
  console.log("-- sm --");
  {
    let r = run();
    check("no arguments prints usage and exits 0", r.code === 0 && /sm — stackmap CLI/.test(r.out), r.show);
    r = run("--help");
    check("--help exits 0", r.code === 0 && /sm slice/.test(r.out), r.show);
    r = run("frobnicate");
    check("an unknown command prints usage and exits 2", r.code === 2 && /sm — stackmap CLI/.test(r.out), r.show);
  }

  console.log("\n-- jsonl --");
  const clean = f("clean.jsonl", '{"id":1,"kind":"a","msg":{"text":"hello"}}\n{"id":2,"kind":"b","msg":{"text":"world"}}\n\n{"id":3,"kind":"a","msg":{"text":"again"}}\n');
  const broken = f("broken.jsonl", '{"id":1}\nnot json\n{"id":2}\n');
  {
    let r = run("jsonl", clean);
    check("emits every row, exit 0", r.code === 0 && r.out.trim().split("\n").length === 3, r.show);
    check("reports counts on stderr, skipping blank lines", /-- files=1 read=3 matched=3 parseErrors=0 emitted=3/.test(r.err), r.show);
    r = run("jsonl", clean, "--where", "kind=a", "--pick", "id");
    check("--where = and --pick", r.out.trim() === '{"id":1}\n{"id":3}', r.show);
    r = run("jsonl", clean, "--where", "kind!=a");
    check("--where !=", r.out.trim() === '{"id":2,"kind":"b","msg":{"text":"world"}}', r.show);
    r = run("jsonl", clean, "--where", "kind~^b$,id=2", "--pick", "id");
    check("--where ~ regex, comma-joined clauses", r.out.trim() === '{"id":2}', r.show);
    r = run("jsonl", clean, "--where", "kind=a", "--count");
    check("--count prints the match count", r.out.trim() === "2", r.show);
    r = run("jsonl", clean, "--limit", "1");
    check("--limit caps emitted rows and the footer says so", r.out.trim().split("\n").length === 1 && /matched=3 .*emitted=1/.test(r.err), r.show);
    r = run("jsonl", clean, "--jq-ish", "msg", "--where", "text=hello");
    check("--jq-ish digs into a path before filtering", r.out.trim() === '{"text":"hello"}', r.show);
    r = run("jsonl", clean, "--where", "kind=b", "--json");
    check("--json wraps rows and stats, with nothing on stderr", json(r)?.rows?.length === 1 && json(r)?._stats?.matched === 1 && r.err === "", r.show);
    r = run("jsonl", clean, "--count", "--json");
    check("--count --json prints the stats", json(r)?.matched === 3 && json(r)?.read === 3, r.show);
    r = run("jsonl", broken, "--pick", "id");
    check("an unparseable line is counted and exits 3", r.code === 3 && /parseErrors=1/.test(r.err) && r.out.trim().split("\n").length === 2, r.show);
    r = run("jsonl", broken, "--json");
    check("…and is counted under --json too", r.code === 3 && json(r)?._stats?.parseErrors === 1, r.show);
    r = run("jsonl", clean, broken, "--count");
    check("counts across several files", r.out.trim() === "5" && /files=2/.test(r.err), r.show);
    r = run("jsonl", clean, "--where", "kind");
    check("a malformed --where clause exits 1 and says why", r.code === 1 && /bad --where clause "kind"/.test(r.err), r.show);
    r = run("jsonl", clean, "--limit", "ten");
    check("a non-numeric --limit exits 1", r.code === 1 && /--limit expects a whole number/.test(r.err), r.show);
    r = run("jsonl", join(dir, "missing.jsonl"));
    check("a missing file exits 1 and names it", r.code === 1 && /missing\.jsonl/.test(r.err), r.show);
    r = run("jsonl");
    check("no file exits 1 with usage", r.code === 1 && /usage: sm jsonl/.test(r.err), r.show);
  }

  console.log("\n-- csv --");
  const people = f("people.csv", 'name,city,note\r\n"Smith, J",Paris,"said ""hi"""\r\nLee,Oslo,plain\r\n');
  const ragged = f("ragged.csv", "a,b\n1,2\n3,4,5\n6,7\n");
  const semi = f("semi.csv", "a;b\n1;2\n");
  {
    let r = run("csv", people, "--json");
    const rows = json(r)?.rows ?? [];
    check("quoted delimiters, escaped quotes, and CRLF parse", r.code === 0 && rows[0]?.name === "Smith, J" && rows[0]?.note === 'said "hi"' && rows[1]?.note === "plain", r.show);
    r = run("csv", people, "--where", "city=Oslo", "--select", "name");
    check("--where and --select", r.out.trim() === '{"name":"Lee"}', r.show);
    r = run("csv", people, "--count");
    check("--count, with the footer on stderr", r.out.trim() === "2" && /-- files=1 dataRows=2 matched=2 ragged=0/.test(r.err), r.show);
    r = run("csv", ragged, "--count");
    check("a ragged row is counted, kept, warned about, and exits 3", r.code === 3 && r.out.trim() === "3" && /ragged=1/.test(r.err) && /WARNING: 1 row/.test(r.err), r.show);
    r = run("csv", ragged, "--json");
    check("…and counted under --json", r.code === 3 && json(r)?._stats?.ragged === 1, r.show);
    r = run("csv", semi, "--delim", ";", "--json");
    check("--delim", json(r)?.rows?.[0]?.b === "2", r.show);
    r = run("csv", people, "--limit", "-1");
    check("a negative --limit exits 1", r.code === 1 && /--limit expects/.test(r.err), r.show);
  }

  console.log("\n-- slice --");
  const five = f("five.txt", "l1\nl2\nl3\nl4\nl5\n"); // 15 bytes
  {
    let r = run("slice", five);
    check("no range reports totals and exits 0", r.code === 0 && r.out === "" && /5 lines, 15 bytes/.test(r.err), r.show);
    r = run("slice", five, "--lines", "2-3");
    check("--lines A-B", r.code === 0 && r.out === "l2\nl3\n" && /emitted 2 of 5 lines/.test(r.err), r.show);
    r = run("slice", five, "--lines", "4-9");
    check("--lines past the end emits what exists and exits 3", r.code === 3 && r.out === "l4\nl5\n" && /SHORT: the file ends at line 5/.test(r.err), r.show);
    r = run("slice", five, "--head", "2");
    check("--head", r.code === 0 && r.out === "l1\nl2\n", r.show);
    r = run("slice", five, "--head", "50");
    check("--head on a shorter file returns it all and exits 0", r.code === 0 && r.out.split("\n").length === 6, r.show);
    r = run("slice", five, "--tail", "2");
    check("--tail", r.code === 0 && r.out === "l4\nl5\n", r.show);
    r = run("slice", five, "--tail", "50");
    check("--tail on a shorter file returns it all and exits 0", r.code === 0 && r.out.split("\n").length === 6, r.show);
    r = run("slice", five, "--bytes", "0-2");
    check("--bytes A-B", r.code === 0 && r.out === "l1" && /bytes 0-2 of 15/.test(r.err), r.show);
    r = run("slice", five, "--bytes", "12-100");
    check("--bytes past the end emits what exists and exits 3", r.code === 3 && r.out === "l5\n" && /SHORT READ: wanted 88, got 3/.test(r.err), r.show);
    for (const [flag, value] of [["--lines", "0-2"], ["--lines", "3-2"], ["--lines", "x"], ["--bytes", "5-1"], ["--head", "two"], ["--tail", "0"]]) {
      r = run("slice", five, flag, value);
      check(`${flag} ${value} exits 1 and says why`, r.code === 1 && new RegExp(flag).test(r.err), r.show);
    }
    r = run("slice", join(dir, "nope.txt"), "--head", "1");
    check("a missing file exits 1", r.code === 1 && /nope\.txt/.test(r.err), r.show);

    r = run("slice", five, "--lines", "2-3", "--json");
    let j = json(r);
    check("--json lines", r.code === 0 && j?.lines?.join() === "l2,l3" && j?._stats?.totalLines === 5 && j?._stats?.emitted === 2 && j?._stats?.short === false && r.err === "", r.show);
    r = run("slice", five, "--lines", "4-9", "--json");
    check("--json marks a short range and exits 3", r.code === 3 && json(r)?._stats?.short === true && json(r)?.lines?.length === 2, r.show);
    r = run("slice", five, "--tail", "2", "--json");
    check("--json tail", json(r)?.lines?.join() === "l4,l5" && json(r)?._stats?.last === 2 && json(r)?._stats?.mode === "tail", r.show);
    r = run("slice", five, "--bytes", "3-5", "--json");
    j = json(r);
    check("--json bytes are base64, with the range in stats", Buffer.from(j?.bytes ?? "", "base64").toString() === "l2" && j?._stats?.got === 2 && j?._stats?.short === false, r.show);
    r = run("slice", five, "--json");
    check("--json with no range reports totals", json(r)?._stats?.totalLines === 5 && json(r)?._stats?.sizeBytes === 15, r.show);
  }

  console.log("\n-- wait --");
  {
    let r = run("wait", "--cmd", "echo ready", "--until", "ready", "--every", "0.1", "--timeout", "5");
    check("--until satisfied exits 0 after one attempt", r.code === 0 && r.out === "ready\n" && /satisfied after 1 attempt/.test(r.err), r.show);
    r = run("wait", "--cmd", "n=$(cat count 2>/dev/null || echo 0); n=$((n+1)); echo $n > count; [ $n -ge 3 ]", "--every", "0.1", "--timeout", "5", "--json");
    check("a failing command is retried until it succeeds", r.code === 0 && json(r)?._stats?.status === "satisfied" && json(r)?._stats?.attempts === 3, r.show);
    r = run("wait", "--cmd", "echo boom", "--fail", "boom", "--every", "0.1", "--timeout", "5");
    check("--fail exits 1", r.code === 1 && /FAILED: matched --fail pattern/.test(r.err), r.show);
    r = run("wait", "--cmd", "echo nope", "--until", "ready", "--every", "0.2", "--timeout", "0.7");
    check("a timeout exits 2 and prints the last output", r.code === 2 && r.out === "nope\n" && /TIMEOUT without matching after [2-9] attempt/.test(r.err), r.show);
    r = run("wait", "--cmd", "echo nope", "--until", "ready", "--every", "0.2", "--timeout", "0.7", "--json");
    check("--json reports the timeout", r.code === 2 && json(r)?._stats?.status === "timeout" && json(r)?.output === "nope\n" && r.err === "", r.show);
    r = run("wait", "--cmd", "echo boom", "--fail", "boom", "--json");
    check("--json reports a --fail match", r.code === 1 && json(r)?._stats?.status === "failed", r.show);
    r = run("wait", "--until", "x");
    check("no --cmd exits 1 with usage", r.code === 1 && /usage: sm wait/.test(r.err), r.show);
    r = run("wait", "--cmd", "true", "--every", "soon");
    check("a non-numeric --every exits 1 instead of running zero attempts", r.code === 1 && /--every expects a number/.test(r.err), r.show);
    r = run("wait", "--cmd", "true", "--timeout", "0");
    check("a zero --timeout exits 1", r.code === 1 && /--timeout expects a number/.test(r.err), r.show);
  }

  console.log("\n-- dupes --");
  {
    const turn = (ts, text) => JSON.stringify({ type: "user", timestamp: ts, message: { content: text } });
    const convo = `${turn("2026-01-01T00:00:00Z", "hi")}\n${turn("2026-01-01T00:05:00Z", "bye")}\n`;
    const d = join(dir, "logs");
    f("logs/a.jsonl", convo);
    f("logs/b.jsonl", convo);
    f("logs/nested/c.jsonl", convo);
    f("logs/sig1.jsonl", `${turn("2026-02-01T00:00:00Z", "one")}\n${turn("2026-02-01T00:09:00Z", "two")}\n`);
    f("logs/sig2.jsonl", `${turn("2026-02-01T00:00:00Z", "one!")}\n${turn("2026-02-01T00:09:00Z", "two!")}\n`);
    f("logs/unique.jsonl", `${turn("2026-03-01T00:00:00Z", "solo")}\nnot json\n`);
    f("logs/ignored.txt", convo);

    let r = run("dupes", d);
    check("finds a byte-identical group (across subdirectories) and exits 3", r.code === 3 && /scanned 6 \.jsonl file/.test(r.out) && /byte-identical groups:\s+1/.test(r.out), r.show);
    check("finds a signature group of files that differ in bytes", /signature-identical groups:\s+1/.test(r.out), r.show);
    check("counts unparseable lines", /unparseable lines:\s+1/.test(r.out), r.show);
    r = run("dupes", d, "--json");
    const j = json(r);
    const sizes = (j?.groups ?? []).map((g) => g.length).sort().join();
    check("--json lists both groups, not the identical copies twice", r.code === 3 && j?.byteIdenticalGroups === 1 && j?.signatureIdenticalGroups === 1 && sizes === "2,3", r.show);
    check("--json reports parse errors and unreadable paths", j?.parseErrors === 1 && Array.isArray(j?.unreadable) && j.unreadable.length === 0, r.show);

    f("solo/only.jsonl", convo);
    r = run("dupes", join(dir, "solo"));
    check("no duplicates exits 0 and says so", r.code === 0 && /no duplicates found/.test(r.out), r.show);
    r = run("dupes", join(dir, "does-not-exist"));
    check("a missing directory exits 1 instead of reporting zero files", r.code === 1 && /cannot read directory .*does-not-exist \(ENOENT\)/.test(r.err), r.show);
    r = run("dupes");
    check("no directory exits 1 with usage", r.code === 1 && /usage: sm dupes/.test(r.err), r.show);

    for (let i = 0; i < 21; i++) {
      f(`many/p${i}-x.jsonl`, `{"n":${i}}\n`);
      f(`many/p${i}-y.jsonl`, `{"n":${i}}\n`);
    }
    r = run("dupes", join(dir, "many"));
    check("more than 20 groups says how many were not shown", /showing 20 of 21 groups; pass --json for all of them/.test(r.out), r.show);
    r = run("dupes", join(dir, "many"), "--json");
    check("--json includes every group", json(r)?.groups?.length === 21, r.show);

    const locked = join(dir, "locked");
    f("locked/inner/secret.jsonl", convo);
    f("locked/visible.jsonl", convo);
    chmodSync(join(locked, "inner"), 0o000);
    try {
      r = run("dupes", locked);
      check("an unreadable subdirectory is listed and exits 1", r.code === 1 && /unreadable:\s+1/.test(r.out) && /inner/.test(r.out), r.show);
    } finally {
      chmodSync(join(locked, "inner"), 0o755);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall cli checks passed" : `\n${failed} cli check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
