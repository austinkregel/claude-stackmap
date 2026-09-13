/**
 * A shell command parser for the guardrails.
 *
 * Guards used to test regexes against raw command text, which fails in both directions: a quoted
 * `;` split `git commit -m "wip; git merge later"` into a fake `git merge` (over-block), and text
 * inside double quotes was stripped wholesale, hiding `"$(npm test | tail -5)"` (under-block).
 * Parsing the command the way the shell does removes both classes: quoted text is data, while
 * command substitutions inside quotes are still commands.
 *
 * Output is deliberately flat. `if a; then b | tail; fi` becomes the pipelines `if a`, `then b |
 * tail`, and `fi`, with leading reserved words (`then`, `do`, `!`, `{` …) moved off the command
 * position into `stage.keywords`. Guards only need "which program runs, with which arguments,
 * reading from what", and the flat form answers that without a full grammar. `case` is the one
 * construct parsed structurally, because its `pattern)` syntax is otherwise an unmatched `)`.
 *
 * What it understands: single, double, and ANSI-C quotes; backslash escapes and line
 * continuations; `$(…)`, backticks, `$((…))`, `${…}` (including inside double quotes); process
 * substitution `<(…)` / `>(…)`; subshells `( … )`; heredocs (`<<`, `<<-`, quoted delimiters) and
 * here-strings; redirections with fd prefixes; `|`, `|&`, `&&`, `||`, `;`, `&`, newlines;
 * comments; function definitions; `case … esac`.
 *
 * Syntax the shell itself would reject (an unterminated quote, an unmatched `)`, a pipe with no
 * command) throws ShellParseError. Guards treat that as "cannot evaluate" and fail closed; the
 * command would not have run anyway. A heredoc with no terminator is NOT an error: bash warns and
 * uses the rest of the input as the body, and so does this parser.
 *
 * Known limits, stated rather than guessed around: zsh-only syntax (glob qualifiers like `*(.)`),
 * extglob patterns `!(x)`, and `[[ … ]]` operators are not modelled; `eval` arguments, aliases,
 * functions, and scripts on disk are not followed.
 */

export class ShellParseError extends Error {}

/** Words that may sit in front of a command without being the command. */
const PREFIX_KEYWORDS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "time"]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

const isBlank = (c) => c === " " || c === "\t";
const isNameStart = (c) => /[A-Za-z_]/.test(c);
const isNameChar = (c) => /[A-Za-z0-9_]/.test(c);

class Parser {
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.pendingHeredocs = [];
  }

  peek(n = 0) {
    return this.src[this.pos + n];
  }

  startsWith(s) {
    return this.src.startsWith(s, this.pos);
  }

  fail(message) {
    throw new ShellParseError(`${message} at offset ${this.pos}`);
  }

  /** True when `word` appears at pos as a whole word (followed by a delimiter). */
  atReservedWord(word) {
    if (!this.startsWith(word)) return false;
    const next = this.src[this.pos + word.length];
    return next === undefined || isBlank(next) || next === "\n" || next === ";" || next === "&" || next === "|" || next === ")";
  }

  skipBlanks() {
    for (;;) {
      const c = this.peek();
      if (isBlank(c)) this.pos++;
      else if (c === "\\" && this.peek(1) === "\n") this.pos += 2;
      else return;
    }
  }

  /** Called just after an unquoted newline is consumed: heredoc bodies start here. */
  readHeredocBodies() {
    const pending = this.pendingHeredocs;
    this.pendingHeredocs = [];
    for (const doc of pending) {
      const lines = [];
      let terminated = false;
      while (this.pos < this.src.length) {
        let end = this.src.indexOf("\n", this.pos);
        if (end === -1) end = this.src.length;
        let line = this.src.slice(this.pos, end);
        this.pos = Math.min(end + 1, this.src.length);
        if (doc.stripTabs) line = line.replace(/^\t+/, "");
        if (line === doc.delimiter) {
          terminated = true;
          break;
        }
        lines.push(line);
      }
      doc.body = lines.join("\n");
      doc.terminated = terminated;
      doc.expansions = doc.quoted ? [] : new Parser(doc.body).heredocExpansionParts();
    }
  }

  /**
   * Parse a command list until `stop`:
   *   null        — end of input
   *   ")"         — an unmatched `)` (consumed): the end of `$(`, `<(`, or a subshell
   *   "case-item" — `;;`, `;&`, `;;&` (consumed) or `esac` in command position (not consumed)
   */
  parseScript(stop) {
    const scriptStart = this.pos;
    const script = { pipelines: [], source: "" };
    let pipeline = newPipeline(this.pos);
    let stage = newStage(this.pos);
    let expectingCommand = false; // after `|`, `&&`, `||`: a newline is a continuation, not an end

    const endStage = () => {
      if (stageIsEmpty(stage)) return false;
      stage.source = this.src.slice(stage.start, this.pos).trim();
      pipeline.stages.push(stage);
      stage = newStage(this.pos);
      return true;
    };
    const endPipeline = (sep) => {
      const had = endStage();
      if (pipeline.ops.length && !had) this.fail(`'${pipeline.ops.at(-1)}' with no command after it`);
      if (pipeline.stages.length) {
        pipeline.sep = sep;
        pipeline.source = this.src.slice(pipeline.start, this.pos).trim();
        script.pipelines.push(pipeline);
      } else if (sep === "&&" || sep === "||" || sep === "|") {
        this.fail(`'${sep}' with no command before it`);
      }
      pipeline = newPipeline(this.pos);
    };
    const finish = () => {
      script.source = this.src.slice(scriptStart, this.pos);
      return script;
    };
    // Separators, heredoc bodies, and comments are consumed between commands; a pipeline or stage
    // that has not started yet must not count them as part of its source text.
    const startAfterData = () => {
      if (pipeline.stages.length === 0 && pipeline.ops.length === 0) pipeline.start = this.pos;
      if (stageIsEmpty(stage)) stage.start = this.pos;
    };

    for (;;) {
      this.skipBlanks();
      const c = this.peek();

      if (c === undefined) {
        if (stop === ")") this.fail("unterminated '$(', '<(', or '('");
        if (expectingCommand) this.fail("command list ends with an operator that needs a command after it");
        endPipeline(null);
        return finish();
      }

      if (c === "\n") {
        if (!expectingCommand) endPipeline("\n");
        this.pos++;
        this.readHeredocBodies();
        startAfterData();
        continue;
      }

      // Reached only at a token start, so `#` here begins a comment (mid-word `a#b` is literal).
      if (c === "#" && this.atWordBoundaryBehind()) {
        while (this.pos < this.src.length && this.peek() !== "\n") this.pos++;
        startAfterData();
        continue;
      }

      if (stop === ")" && c === ")") {
        if (expectingCommand) this.fail("operator with no command before ')'");
        endPipeline(null);
        this.pos++;
        return finish();
      }

      if (stop === "case-item" && stageIsEmpty(stage) && this.atReservedWord("esac")) {
        endPipeline(null);
        return finish();
      }

      if (this.startsWith(";;&") || this.startsWith(";;") || this.startsWith(";&")) {
        const op = this.startsWith(";;&") ? ";;&" : this.startsWith(";;") ? ";;" : ";&";
        if (stop !== "case-item") this.fail(`'${op}' outside a case statement`);
        endPipeline(op);
        this.pos += op.length;
        return finish();
      }
      if (this.startsWith("&&") || this.startsWith("||")) {
        const op = this.src.slice(this.pos, this.pos + 2);
        endPipeline(op);
        this.pos += 2;
        startAfterData();
        expectingCommand = true;
        continue;
      }
      if (c === ";") {
        endPipeline(";");
        this.pos++;
        startAfterData();
        continue;
      }
      if (this.startsWith("|&") || c === "|") {
        const op = this.startsWith("|&") ? "|&" : "|";
        if (!endStage() && pipeline.stages.length === 0) this.fail(`'${op}' with no command before it`);
        if (pipeline.ops.length === pipeline.stages.length) this.fail(`'${op}' with no command before it`);
        this.pos += op.length;
        pipeline.ops.push(op);
        stage = newStage(this.pos);
        expectingCommand = true;
        continue;
      }
      if (c === "&" && !this.startsWith("&>")) {
        endPipeline("&");
        this.pos++;
        startAfterData();
        continue;
      }

      if (c === "(") {
        if (stageIsEmpty(stage)) {
          if (this.peek(1) === "(") {
            const start = this.pos;
            this.pos += 2;
            const scripts = [];
            this.skipBalanced("(", ")", 2, scripts);
            stage.arithmetic = this.src.slice(start, this.pos);
            stage.nested.push(...scripts);
          } else {
            this.pos++;
            stage.nested.push(this.parseScript(")"));
            stage.subshell = true;
          }
          expectingCommand = false;
          continue;
        }
        if (stage.words.length === 1 && this.src.slice(this.pos).match(/^\(\s*\)/)) {
          // `name() { … }` — a function definition; the body parses as ordinary commands.
          this.pos += this.src.slice(this.pos).match(/^\(\s*\)/)[0].length;
          stage.functionDef = true;
          endPipeline(";");
          continue;
        }
        this.fail("unexpected '('");
      }
      if (c === ")") this.fail("unexpected ')'");

      if (stageIsEmpty(stage) && this.atReservedWord("case")) {
        this.parseCase(stage);
        expectingCommand = false;
        continue;
      }

      if (this.readRedirect(stage)) {
        expectingCommand = false;
        continue;
      }

      const word = this.readWord();
      if (!word) this.fail(`unexpected character '${c}'`);
      expectingCommand = false;
      const text = staticText(word);
      if (stage.words.length === 0 && stage.nested.length === 0 && text !== null && PREFIX_KEYWORDS.has(text) && !wordIsQuoted(word)) {
        stage.keywords.push(text);
        continue;
      }
      stage.words.push(word);
    }
  }

  atWordBoundaryBehind() {
    const prev = this.src[this.pos - 1];
    return prev === undefined || isBlank(prev) || prev === "\n" || prev === ";" || prev === "&" || prev === "|" || prev === "(";
  }

  /** `case WORD in [(]pat[|pat]…) list ;; … esac` — parsed into stage.caseItems. */
  parseCase(stage) {
    stage.words.push(literalWord("case"));
    this.pos += 4;
    this.skipBlanks();
    const subject = this.readWord();
    if (!subject) this.fail("case with no subject");
    stage.words.push(subject);
    this.skipBlanksAndNewlines();
    if (!this.atReservedWord("in")) this.fail("case without 'in'");
    this.pos += 2;
    stage.caseItems = [];
    for (;;) {
      this.skipBlanksAndNewlines();
      if (this.peek() === "#") {
        while (this.pos < this.src.length && this.peek() !== "\n") this.pos++;
        continue;
      }
      if (this.peek() === undefined) this.fail("case without 'esac'");
      if (this.atReservedWord("esac")) {
        this.pos += 4;
        return;
      }
      if (this.peek() === "(") this.pos++;
      const patterns = [];
      for (;;) {
        this.skipBlanks();
        const pattern = this.readWord();
        if (!pattern) this.fail("case pattern expected");
        patterns.push(pattern);
        this.skipBlanks();
        if (this.peek() === "|") {
          this.pos++;
          continue;
        }
        if (this.peek() === ")") {
          this.pos++;
          break;
        }
        this.fail("expected '|' or ')' after case pattern");
      }
      const body = this.parseScript("case-item");
      stage.caseItems.push({ patterns, body });
      stage.nested.push(body);
    }
  }

  skipBlanksAndNewlines() {
    for (;;) {
      this.skipBlanks();
      if (this.peek() === "\n") {
        this.pos++;
        this.readHeredocBodies();
      } else return;
    }
  }

  /**
   * Skip to the close of a construct already opened `depth` times. Command substitutions met on
   * the way (`${x:-$(cmd)}`, `$(( $(cmd) + 1 ))`) still run, so their scripts are collected.
   */
  skipBalanced(open, close, depth, scripts = []) {
    let d = depth;
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === "\\") {
        this.pos += 2;
        continue;
      }
      if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end === -1) this.fail("unterminated single quote");
        this.pos = end + 1;
        continue;
      }
      if (c === '"') {
        const parts = [];
        this.readDoubleQuoted(parts);
        scripts.push(...scriptsInParts(parts));
        continue;
      }
      if (c === "`") {
        scripts.push(this.readBacktick().script);
        continue;
      }
      if (this.startsWith("$(") && !this.startsWith("$((")) {
        this.pos += 2;
        scripts.push(this.parseScript(")"));
        continue;
      }
      if (c === open) d++;
      if (c === close) {
        d--;
        if (d === 0) {
          this.pos++;
          return;
        }
      }
      this.pos++;
    }
    this.fail(`unterminated '${open}'`);
  }

  /**
   * Expansions in an unquoted heredoc body. The body is data, but `$(…)` and backticks in it
   * run when the heredoc is read, exactly as they would inside double quotes.
   */
  heredocExpansionParts() {
    const parts = [];
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === "\\") {
        this.pos += 2;
        continue;
      }
      if (c === "`") {
        parts.push(this.readBacktick());
        continue;
      }
      if (c === "$") {
        const part = this.readDollar();
        if (part.kind !== "lit") parts.push(part);
        continue;
      }
      this.pos++;
    }
    return parts;
  }

  /** Redirection at the current position, if any. Returns true when one was consumed. */
  readRedirect(stage) {
    const start = this.pos;
    const m = /^(\d+)?(&>>|&>|<<<|<<-|<<|<>|<&|>>|>\||>&|<(?!\()|>(?!\())/.exec(this.src.slice(this.pos));
    if (!m) return false;
    const [, fd, op] = m;
    this.pos += m[0].length;
    this.skipBlanks();

    if (op === "<<" || op === "<<-") {
      const delimWord = this.readWord();
      if (!delimWord) this.fail("heredoc with no delimiter");
      const delimiter = literalTextIgnoringExpansions(delimWord);
      const doc = {
        op, fd: fd ?? null, delimiter, quoted: wordIsQuoted(delimWord), stripTabs: op === "<<-",
        body: "", terminated: false, expansions: [],
      };
      stage.heredocs.push(doc);
      stage.redirects.push({ op, fd: fd ?? null, target: delimWord, heredoc: doc, source: this.src.slice(start, this.pos) });
      this.pendingHeredocs.push(doc);
      return true;
    }

    const target = this.readWord();
    if (!target) this.fail(`redirection '${op}' with no target`);
    const redirect = { op, fd: fd ?? null, target, source: this.src.slice(start, this.pos) };
    if (op === "<<<") stage.herestrings.push(target);
    stage.redirects.push(redirect);
    return true;
  }

  /** A word, as a list of parts. Returns null when no word starts here. */
  readWord() {
    const start = this.pos;
    const parts = [];
    const lit = (text, quoted) => {
      const last = parts.at(-1);
      if (last && last.kind === "lit" && last.quoted === quoted) last.text += text;
      else parts.push({ kind: "lit", text, quoted });
    };

    while (this.pos < this.src.length) {
      const c = this.peek();
      if (isBlank(c) || c === "\n" || c === ";" || c === "&" || c === "|" || c === ")") break;
      if (c === "(" && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(this.src.slice(start, this.pos))) {
        // `arr=(a b c)` — an array assignment, not a subshell.
        const arrayStart = this.pos;
        this.pos++;
        const scripts = [];
        this.skipBalanced("(", ")", 1, scripts);
        parts.push({ kind: "array", raw: this.src.slice(arrayStart, this.pos), scripts });
        continue;
      }
      if (c === "(") break;
      if ((c === "<" || c === ">") && this.peek(1) === "(") {
        const dir = c;
        this.pos += 2;
        const script = this.parseScript(")");
        parts.push({ kind: "procsub", dir, script });
        continue;
      }
      if (c === "<" || c === ">") break;

      if (c === "\\") {
        if (this.peek(1) === "\n") {
          this.pos += 2;
          continue;
        }
        if (this.peek(1) === undefined) this.fail("trailing backslash");
        lit(this.peek(1), true);
        this.pos += 2;
        continue;
      }
      if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end === -1) this.fail("unterminated single quote");
        lit(this.src.slice(this.pos + 1, end), true);
        this.pos = end + 1;
        continue;
      }
      if (c === '"') {
        this.readDoubleQuoted(parts);
        continue;
      }
      if (c === "`") {
        parts.push(this.readBacktick());
        continue;
      }
      if (c === "$") {
        if (this.peek(1) === "'") {
          this.pos += 2;
          lit(this.readAnsiC(), true);
          continue;
        }
        if (this.peek(1) === '"') {
          this.pos++;
          this.readDoubleQuoted(parts);
          continue;
        }
        const part = this.readDollar();
        if (part.kind === "lit") lit(part.text, false);
        else parts.push(part);
        continue;
      }
      lit(c, false);
      this.pos++;
    }

    if (this.pos === start) return null;
    return { parts, raw: this.src.slice(start, this.pos) };
  }

  /** pos at the opening `"`; appends parts; leaves pos after the closing `"`. */
  readDoubleQuoted(parts) {
    this.pos++;
    const lit = (text) => {
      const last = parts.at(-1);
      if (last && last.kind === "lit" && last.quoted) last.text += text;
      else parts.push({ kind: "lit", text, quoted: true });
    };
    // An empty "" is still a (quoted, empty) word part.
    lit("");
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '"') {
        this.pos++;
        return;
      }
      if (c === "\\") {
        const n = this.peek(1);
        if (n === "\n") {
          this.pos += 2;
          continue;
        }
        if (n === "$" || n === "`" || n === '"' || n === "\\") {
          lit(n);
          this.pos += 2;
          continue;
        }
        lit("\\");
        this.pos++;
        continue;
      }
      if (c === "`") {
        parts.push(this.readBacktick());
        continue;
      }
      if (c === "$") {
        const part = this.readDollar();
        if (part.kind === "lit") lit(part.text);
        else parts.push(part);
        continue;
      }
      lit(c);
      this.pos++;
    }
    this.fail("unterminated double quote");
  }

  /** pos just after `$'`; returns the decoded text and leaves pos after the closing `'`. */
  readAnsiC() {
    const escapes = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v" };
    let out = "";
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === "'") {
        this.pos++;
        return out;
      }
      if (c === "\\" && this.peek(1) !== undefined) {
        const n = this.peek(1);
        out += escapes[n] ?? n;
        this.pos += 2;
        continue;
      }
      out += c;
      this.pos++;
    }
    this.fail("unterminated $'...' quote");
  }

  /** pos at `$`. Returns a part: cmdsub, arith, param, or a literal `$`. */
  readDollar() {
    const start = this.pos;
    if (this.startsWith("$((")) {
      this.pos += 3;
      const scripts = [];
      this.skipBalanced("(", ")", 2, scripts);
      return { kind: "arith", raw: this.src.slice(start, this.pos), scripts };
    }
    if (this.startsWith("$(")) {
      this.pos += 2;
      const script = this.parseScript(")");
      return { kind: "cmdsub", script, raw: this.src.slice(start, this.pos) };
    }
    if (this.startsWith("${")) {
      this.pos += 2;
      const scripts = [];
      this.skipBalanced("{", "}", 1, scripts);
      return { kind: "param", raw: this.src.slice(start, this.pos), scripts };
    }
    const n = this.peek(1);
    if (n !== undefined && isNameStart(n)) {
      this.pos++;
      while (this.pos < this.src.length && isNameChar(this.peek())) this.pos++;
      return { kind: "param", raw: this.src.slice(start, this.pos) };
    }
    if (n !== undefined && /[0-9@*#?$!-]/.test(n)) {
      this.pos += 2;
      return { kind: "param", raw: this.src.slice(start, this.pos) };
    }
    this.pos++;
    return { kind: "lit", text: "$" };
  }

  /** pos at the opening backtick. The body is unescaped and parsed as its own script. */
  readBacktick() {
    const start = this.pos;
    this.pos++;
    let body = "";
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === "`") {
        this.pos++;
        return { kind: "cmdsub", script: parse(body), raw: this.src.slice(start, this.pos) };
      }
      if (c === "\\" && (this.peek(1) === "`" || this.peek(1) === "\\" || this.peek(1) === "$")) {
        body += this.peek(1);
        this.pos += 2;
        continue;
      }
      body += c;
      this.pos++;
    }
    this.fail("unterminated backtick");
  }
}

function newPipeline(start) {
  return { stages: [], ops: [], sep: null, start, source: "" };
}

function newStage(start) {
  return {
    words: [], keywords: [], redirects: [], heredocs: [], herestrings: [], nested: [],
    subshell: false, arithmetic: null, caseItems: null, functionDef: false, start, source: "",
  };
}

function stageIsEmpty(stage) {
  return stage.words.length === 0 && stage.redirects.length === 0 && stage.nested.length === 0 && stage.arithmetic === null;
}

function literalWord(text) {
  return { parts: [{ kind: "lit", text, quoted: false }], raw: text };
}

/** Parse a command string. Throws ShellParseError on syntax the shell would reject. */
export function parse(src) {
  const parser = new Parser(src);
  const script = parser.parseScript(null);
  // Heredocs whose operator was on the last line never saw a newline: bash reads an empty body.
  parser.readHeredocBodies();
  return script;
}

/** The word's text when it is fully static (no expansions), else null. */
export function staticText(word) {
  let out = "";
  for (const part of word.parts) {
    if (part.kind !== "lit") return null;
    out += part.text;
  }
  return out;
}

/** Literal parts only; expansions contribute nothing. Used where a partial view is still useful. */
export function literalTextIgnoringExpansions(word) {
  return word.parts.filter((p) => p.kind === "lit").map((p) => p.text).join("");
}

export function wordIsQuoted(word) {
  return word.parts.some((p) => p.kind === "lit" && p.quoted);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/** Words after leading `NAME=value` assignments: [command, ...args]. */
export function commandWords(stage) {
  let i = 0;
  while (i < stage.words.length) {
    const first = stage.words[i].parts[0];
    if (first && first.kind === "lit" && !first.quoted && ASSIGNMENT.test(first.text)) i++;
    else break;
  }
  return stage.words.slice(i);
}

/**
 * The program a stage runs, as a basename (`/usr/bin/tail` -> `tail`). Returns:
 *   { name }            — a static command name
 *   { name: null, dynamic: true } — the command word contains an expansion (`$PAGER`)
 *   { name: null }      — no command (a subshell, arithmetic, bare assignment, function def)
 */
export function commandName(stage) {
  if (stage.functionDef) return { name: null }; // `f() {`: defines f, runs nothing
  const words = commandWords(stage);
  if (words.length === 0) return { name: null };
  const text = staticText(words[0]);
  if (text === null) return { name: null, dynamic: true };
  return { name: text.includes("/") ? text.slice(text.lastIndexOf("/") + 1) : text };
}

/** Scripts that run as part of expanding these word parts. */
function scriptsInParts(parts) {
  const out = [];
  for (const part of parts) {
    if (part.kind === "cmdsub" || part.kind === "procsub") out.push(part.script);
    if (part.scripts) out.push(...part.scripts);
  }
  return out;
}

/** Every script embedded in a list of words (substitutions, and those inside `${…}` / `$((…))`). */
function embeddedScripts(words) {
  return words.flatMap((word) => scriptsInParts(word.parts));
}

/**
 * A word's value as shell source, with each runtime expansion replaced by a placeholder parameter.
 * Used for `bash -c "cd $DIR && npm test"`: the structure is visible, and a guard sees
 * `${__stackmap_runtime_value}` wherever a value is only known at runtime, so `bash -c "$CMD"`
 * still reads as a command built at runtime rather than as an empty script.
 */
const RUNTIME_PLACEHOLDER = "${__stackmap_runtime_value}";
function sourceWithPlaceholders(word) {
  return word.parts.map((p) => (p.kind === "lit" ? p.text : RUNTIME_PLACEHOLDER)).join("");
}

/**
 * Scripts a stage runs through a shell: `bash -c '<script>'` and `bash <<EOF … EOF`.
 * Returns { scripts, unknown }: `unknown` describes a shell script this cannot see (a dynamic
 * `-c` argument), so a guard can fail closed instead of treating it as empty.
 */
export function shellScripts(stage) {
  const { name } = commandName(stage);
  if (!name || !SHELLS.has(name)) return { scripts: [], unknown: null };
  const args = commandWords(stage).slice(1);
  for (let i = 0; i < args.length; i++) {
    const text = staticText(args[i]);
    if (text === null) return { scripts: [], unknown: null }; // `bash "$script"`: a file, not followed
    if (text === "--") break;
    if (text === "-o" || text === "+o" || text === "-O" || text === "+O") {
      i++; // these take a value: `bash -o pipefail -c …`
      continue;
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(text)) {
      const script = args[i + 1];
      if (!script) return { scripts: [], unknown: `${name} -c with no command string` };
      return { scripts: [parse(sourceWithPlaceholders(script))], unknown: null };
    }
    // `bash -s arg…`: commands come from stdin and the remaining words are positional args.
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(text)) break;
    if (!text.startsWith("-") && !text.startsWith("+")) return { scripts: [], unknown: null }; // `bash script.sh`
  }
  // With -s, or with no script operand, the shell reads its commands from stdin.
  const scripts = stage.heredocs.map((doc) => parse(doc.body));
  for (const herestring of stage.herestrings) scripts.push(parse(sourceWithPlaceholders(herestring)));
  return { scripts, unknown: null };
}

/**
 * Visit every stage in a script, depth-first, including stages inside subshells, case bodies,
 * command and process substitutions (in words and in redirect targets), and scripts run via
 * `bash -c` or a heredoc fed to a shell. `visit(stage, pipeline, index)` may return a value;
 * the first non-undefined return stops the walk and is returned.
 *
 * `onUnknown(description)` is called for a shell script whose text is built at runtime.
 */
export function walkStages(script, visit, onUnknown = () => {}) {
  for (const pipeline of script.pipelines) {
    for (const [index, stage] of pipeline.stages.entries()) {
      const hit = visit(stage, pipeline, index);
      if (hit !== undefined) return hit;
      const children = [
        ...stage.nested,
        ...embeddedScripts(stage.words),
        ...embeddedScripts(stage.redirects.map((r) => r.target)),
        ...stage.heredocs.flatMap((doc) => scriptsInParts(doc.expansions)),
      ];
      const shell = shellScripts(stage);
      if (shell.unknown) {
        const stop = onUnknown(shell.unknown, stage);
        if (stop !== undefined) return stop;
      }
      children.push(...shell.scripts);
      for (const child of children) {
        const found = walkStages(child, visit, onUnknown);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}
