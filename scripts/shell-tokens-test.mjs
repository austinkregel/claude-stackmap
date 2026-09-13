#!/usr/bin/env node
/**
 * Shell parser suite. Every guard's precision rests on this parser telling a command apart from a
 * description of one, so each construct is pinned both ways: what must be seen as a command, and
 * what must be seen as data.
 */
import { commandName, commandWords, parse, ShellParseError, staticText, walkStages } from "./shell-tokens.mjs";

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
};

/** All programs the parser would run, in walk order, as "name arg arg". */
function programs(src) {
  const out = [];
  walkStages(parse(src), (stage) => {
    const { name, dynamic } = commandName(stage);
    if (name) out.push([name, ...commandWords(stage).slice(1).map((w) => staticText(w) ?? "<dynamic>")].join(" "));
    else if (dynamic) out.push("<dynamic>");
  });
  return out;
}

/** Pipelines as arrays of command names, in walk order. */
function pipelines(src) {
  const out = [];
  const seen = new Set();
  walkStages(parse(src), (stage, pipeline) => {
    if (seen.has(pipeline)) return;
    seen.add(pipeline);
    out.push(pipeline.stages.map((s) => commandName(s).name ?? (s.subshell ? "(subshell)" : "?")));
  });
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const expectPrograms = (label, src, expected) => {
  let got;
  try {
    got = programs(src);
  } catch (err) {
    return check(label, false, `threw ${err.message}`);
  }
  check(label, same(got, expected), `got ${JSON.stringify(got)}`);
};
const expectPipelines = (label, src, expected) => {
  let got;
  try {
    got = pipelines(src);
  } catch (err) {
    return check(label, false, `threw ${err.message}`);
  }
  check(label, same(got, expected), `got ${JSON.stringify(got)}`);
};
const expectError = (label, src) => {
  try {
    parse(src);
    check(label, false, "parsed without error");
  } catch (err) {
    check(label, err instanceof ShellParseError, `threw ${err?.constructor?.name}: ${err?.message}`);
  }
};

console.log("-- quoting: quoted text is data --");
expectPrograms("quoted ; does not split a command", 'git commit -m "wip; git merge later"', ["git commit -m wip; git merge later"]);
expectPrograms("single-quoted pipe is data", "printf '%s' 'npm test | head -5'", ["printf %s npm test | head -5"]);
expectPipelines("double-quoted pipe is data", 'echo "a | tail b"', [["echo"]]);
expectPrograms("escaped pipe is data", "echo a \\| tail", ["echo a | tail"]);
expectPrograms("ANSI-C quote decodes escapes", "echo $'a\\tb'", ["echo a\tb"]);
expectPrograms("empty quotes are still a word", 'grep "" file', ["grep  file"]);
expectPrograms("line continuation joins a command", "git \\\n  status", ["git status"]);

console.log("\n-- substitutions: commands inside quotes are still commands --");
expectPipelines("$(...) inside double quotes is parsed", 'echo "$(npm test | tail -5)"', [["echo"], ["npm", "tail"]]);
expectPipelines("backticks are parsed", "echo `ls | head`", [["echo"], ["ls", "head"]]);
expectPipelines("nested $( $( ) )", "echo $(cat $(ls | head))", [["echo"], ["cat"], ["ls", "head"]]);
expectPipelines("process substitution is parsed", "tail -5 <(npm test)", [["tail"], ["npm"]]);
expectPipelines("process substitution as a redirect target", "while read l; do :; done < <(make | tail)", [["read"], [":"], ["done"], ["make", "tail"]]);
expectPipelines("substitution inside ${…} default still runs", 'echo "${X:-$(npm test | tail)}"', [["echo"], ["npm", "tail"]]);
expectPipelines("substitution inside $((…)) still runs", "echo $(( $(wc -l < f) + 1 ))", [["echo"], ["wc"]]);
expectPrograms("parameter expansion is dynamic, not a command", "$PAGER file", ["<dynamic>"]);

console.log("\n-- operators --");
expectPipelines("|| is not a pipe", "npm test || tail -5 /tmp/x.log", [["npm"], ["tail"]]);
expectPipelines("|& is a pipe", "npm test |& tail -5", [["npm", "tail"]]);
expectPipelines("&& and ; separate pipelines", "a | tee f && tail f; b | head", [["a", "tee"], ["tail"], ["b", "head"]]);
expectPipelines("newline after | continues the pipeline", "npm test |\n  tail -5", [["npm", "tail"]]);
expectPipelines("2>&1 is a redirect, not a background &", "npm test 2>&1 | tee out.log", [["npm", "tee"]]);
expectPipelines("&> redirect", "make &> build.log", [["make"]]);
expectPipelines("background & ends a pipeline", "sleep 1 & tail -f x", [["sleep"], ["tail"]]);

console.log("\n-- compound commands --");
expectPipelines("subshell piped into a filter", "(make; make test) | tail", [["(subshell)", "tail"], ["make"], ["make"]]);
expectPipelines("brace group keywords are stripped", "{ make; make test; } | tail", [["make"], ["make"], ["}", "tail"]]);
expectPrograms("if/then keywords are stripped", "if true; then git merge x; fi", ["true", "git merge x", "fi"]);
expectPipelines("loop output piped", "for f in a b; do cat $f; done | head", [["for"], ["cat"], ["done", "head"]]);
expectPrograms(
  "case patterns do not break parsing",
  'case "$x" in\n  a|b) echo one ;;\n  *) git status ;;\nesac',
  ["case <dynamic>", "echo one", "git status"],
);
expectPipelines("case output piped", "case $x in a) make;; esac | tail", [["case", "tail"], ["make"]]);
expectPrograms("function definition body is parsed", "f() { git push; }; f", ["git push", "}", "f"]);
expectPrograms("array assignment is not a subshell", "arr=(a b c); echo ${arr[0]}", ["echo <dynamic>"]);
expectPrograms("assignment prefix is not the command", "FOO=1 BAR=\"x y\" npm test", ["npm test"]);
expectPrograms("path to a program resolves to its basename", "/usr/bin/tail -5 f", ["tail -5 f"]);
expectPrograms("arithmetic command", "(( i++ )); echo ok", ["echo ok"]);

expectPipelines("process substitution feeding a filter through a redirect", "tail -5 < <(npm test)", [["tail"], ["npm"]]);

console.log("\n-- comments --");
expectPipelines("trailing comment is not a command", "make # | tail later", [["make"]]);
expectPrograms("# inside a word is literal", "echo a#b", ["echo a#b"]);
expectPrograms("${#var} is not a comment", "echo ${#PATH}", ["echo <dynamic>"]);

console.log("\n-- heredocs and here-strings --");
{
  const src = "cat <<'EOF' > doc.md\nnpm test | tail -20\nEOF\necho done";
  expectPipelines("heredoc body is data", src, [["cat"], ["echo"]]);
  let body = null;
  walkStages(parse(src), (stage) => {
    if (stage.heredocs.length) body = stage.heredocs[0].body;
  });
  check("heredoc body is captured verbatim", body === "npm test | tail -20", `got ${JSON.stringify(body)}`);
}
expectPipelines("pipe on the heredoc marker line is real", "cat <<'EOF' | tail -5\nbody\nEOF", [["cat", "tail"]]);
{
  // Regression: a pipeline after a heredoc reported the heredoc body as part of its source text.
  const script = parse("cat > p.py <<'PY'\nimport json\nPY\n# run it\npython3 p.py | head -5");
  const sources = script.pipelines.map((p) => p.source);
  check("pipeline source excludes a preceding heredoc body and comment", sources.at(-1) === "python3 p.py | head -5", `got ${JSON.stringify(sources)}`);
  const after = parse("cd x; make | tail && ls").pipelines.map((p) => p.source);
  check("pipeline source excludes the separator before it", JSON.stringify(after) === JSON.stringify(["cd x", "make | tail", "ls"]), `got ${JSON.stringify(after)}`);
}
expectPipelines("<<- strips leading tabs from the terminator", "cat <<-EOF\n\tbody\n\tEOF\necho after", [["cat"], ["echo"]]);
expectPipelines("unterminated heredoc takes the rest as body, like bash", "cat <<EOF\nnpm test | tail", [["cat"]]);
expectPipelines("expansion in an UNQUOTED heredoc body runs", "cat <<EOF\n$(npm test | tail)\nEOF", [["cat"], ["npm", "tail"]]);
expectPipelines("expansion in a QUOTED heredoc body is data", "cat <<'EOF'\n$(npm test | tail)\nEOF", [["cat"]]);
expectPrograms(
  "heredoc inside $( ) inside double quotes (the commit-message idiom)",
  'git commit -m "$(cat <<\'EOF\'\nSubject line\n\nBody; git merge later\nEOF\n)"',
  ["git commit -m <dynamic>", "cat"],
);

console.log("\n-- scripts run through a shell --");
expectPipelines("bash -c string is parsed", "bash -c 'npm test | tail'", [["bash"], ["npm", "tail"]]);
expectPipelines("sh -lc cluster is parsed", 'sh -lc "make | head"', [["sh"], ["make", "head"]]);
expectPipelines("bash -o pipefail -c is parsed", "bash -o pipefail -c 'make | head'", [["bash"], ["make", "head"]]);
expectPipelines("expansions inside a -c string keep its structure", 'sh -c "cd $DIR && npm test | tail"', [["sh"], ["cd"], ["npm", "tail"]]);
expectPrograms("a -c string that is entirely runtime is a dynamic command", 'bash -c "$CMD"', ["bash -c <dynamic>", "<dynamic>"]);
expectPipelines("heredoc fed to a shell is parsed", "bash <<'EOF'\nmake | tail\nEOF", [["bash"], ["make", "tail"]]);
expectPipelines("bash script.sh is a file, not followed", "bash deploy.sh | tee out.log", [["bash", "tee"]]);

console.log("\n-- syntax the shell rejects throws --");
expectError("unterminated double quote", 'echo "unterminated | tail -5');
expectError("unterminated single quote", "echo 'nope");
expectError("unterminated $(", "echo $(ls");
expectError("unmatched )", "echo a)");
expectError("pipe with no command before it", "| tail");
expectError("pipe with no command after it", "make |");
expectError("&& at end of input", "make &&");
expectError(";; outside case", "echo a;; echo b");

console.log(failed === 0 ? "\nall shell parser checks passed" : `\n${failed} shell parser check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
