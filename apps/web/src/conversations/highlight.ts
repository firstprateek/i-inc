// A small syntax highlighter for the code in a conversation: it cuts source into tokens (keyword, string,
// comment, number, ...) and nothing more, so the view can render them as spans without ever building HTML
// from the source. Not a parser: it gets the common shapes of a dozen languages right and leaves the rest plain.

export type TokenType =
  | "kw"
  | "str"
  | "com"
  | "num"
  | "fn"
  | "ty"
  | "pun"
  | "tag"
  | "attr"
  | "add"
  | "del"
  | "meta";
export interface Token {
  /** The kind of token; undefined is plain text. */
  t?: TokenType;
  s: string;
}

interface Lang {
  keywords: ReadonlySet<string>;
  /** Line comment starters. */
  line: readonly string[];
  /** Block comment [start, end]. */
  block?: readonly [string, string];
  /** Quote characters that open a string. */
  quotes: string;
  /** Names followed by `(` are shown as functions. */
  calls?: boolean;
  /** Capitalised words are shown as types. */
  types?: boolean;
  /** Variables like $x or ${x}. */
  dollar?: boolean;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

const JS: Lang = {
  keywords: words(
    "break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while with yield async await as satisfies declare namespace abstract keyof",
  ),
  line: ["//"],
  block: ["/*", "*/"],
  quotes: "\"'`",
  calls: true,
  types: true,
};
const PY: Lang = {
  keywords: words(
    "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self",
  ),
  line: ["#"],
  quotes: "\"'",
  calls: true,
  types: true,
};
const SH: Lang = {
  keywords: words(
    "if then else elif fi for while until do done case esac in function select time export local readonly return exit cd echo set unset source alias sudo",
  ),
  line: ["#"],
  quotes: "\"'`",
  dollar: true,
};
const C: Lang = {
  keywords: words(
    "auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename using public private protected virtual new delete this true false null nullptr bool string func package import interface map chan go defer range var fn let mut pub impl trait use mod match loop where self Self crate async await move dyn ref type final throws throw try catch finally extends implements abstract synchronized boolean byte",
  ),
  line: ["//"],
  block: ["/*", "*/"],
  quotes: "\"'`",
  calls: true,
  types: true,
};
const SQL: Lang = {
  keywords: words(
    "select from where and or not null insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset as distinct union all case when then else end is in like between exists primary key foreign references default unique count sum avg min max asc desc with returning",
  ),
  line: ["--"],
  block: ["/*", "*/"],
  quotes: "\"'",
  calls: true,
};
const CSS: Lang = {
  keywords: words("important media supports import font-face keyframes root from to"),
  line: [],
  block: ["/*", "*/"],
  quotes: "\"'",
};
const YAML: Lang = {
  keywords: words("true false null yes no"),
  line: ["#"],
  quotes: "\"'",
};
const JSON_LANG: Lang = { keywords: words("true false null"), line: [], quotes: '"' };

const LANGS: Record<string, Lang> = {
  js: JS,
  jsx: JS,
  ts: JS,
  tsx: JS,
  javascript: JS,
  typescript: JS,
  mjs: JS,
  cjs: JS,
  json: JSON_LANG,
  jsonc: JSON_LANG,
  py: PY,
  python: PY,
  sh: SH,
  bash: SH,
  zsh: SH,
  shell: SH,
  console: SH,
  c: C,
  h: C,
  cpp: C,
  "c++": C,
  cs: C,
  csharp: C,
  java: C,
  go: C,
  rust: C,
  rs: C,
  kotlin: C,
  swift: C,
  php: C,
  sql: SQL,
  css: CSS,
  scss: CSS,
  yaml: YAML,
  yml: YAML,
  toml: YAML,
};

const NUM = /^(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/;
const IDENT = /^[A-Za-z_$][\w$-]*/;

/** Highlights `code` as `lang`; an unknown language is returned as one plain token. Long code is left plain. */
export function highlight(code: string, lang: string): Token[] {
  const name = lang.toLowerCase();
  if (code.length > 40_000) return [{ s: code }];
  if (name === "diff" || name === "patch") return diffTokens(code);
  if (name === "html" || name === "xml" || name === "svg" || name === "vue") return markupTokens(code);
  const l = LANGS[name];
  if (!l) return [{ s: code }];
  return scan(code, l, name === "json" || name === "jsonc");
}

function scan(code: string, l: Lang, json: boolean): Token[] {
  const out: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push({ s: plain });
      plain = "";
    }
  };
  const push = (t: TokenType, s: string) => {
    flush();
    out.push({ t, s });
  };
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i, i + 2);
    const c = code.charAt(i);
    const starter = l.line.find((s) => code.startsWith(s, i));
    if (starter && !(starter === "#" && code.charAt(i - 1) === "$")) {
      let end = code.indexOf("\n", i);
      if (end < 0) end = code.length;
      push("com", code.slice(i, end));
      i = end;
      continue;
    }
    if (l.block && code.startsWith(l.block[0], i)) {
      const close = code.indexOf(l.block[1], i + l.block[0].length);
      const end = close < 0 ? code.length : close + l.block[1].length;
      push("com", code.slice(i, end));
      i = end;
      continue;
    }
    if (l.quotes.includes(c)) {
      let j = i + 1;
      while (j < code.length && code.charAt(j) !== c) {
        if (code.charAt(j) === "\\") j++;
        else if (c !== "`" && code.charAt(j) === "\n") break;
        j++;
      }
      const end = Math.min(code.length, j + 1);
      const text = code.slice(i, end);
      // A JSON key is a string followed by a colon.
      push(json && /^\s*:/.test(code.slice(end, end + 8)) ? "attr" : "str", text);
      i = end;
      continue;
    }
    if (l.dollar && c === "$") {
      const m = /^\$(?:\{[^}]*\}|\w+|[@#?*$!-])/.exec(code.slice(i));
      if (m) {
        push("attr", m[0]);
        i += m[0].length;
        continue;
      }
    }
    const prev = code.charAt(i - 1);
    if (/\d/.test(c) && !/[\w$]/.test(prev)) {
      const m = NUM.exec(code.slice(i, i + 40));
      if (m) {
        push("num", m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (IDENT.test(c)) {
      const m = IDENT.exec(code.slice(i, i + 80));
      if (m) {
        const w = m[0];
        const next = code.charAt(i + w.length);
        if (l.keywords.has(w)) push("kw", w);
        else if (l.calls && next === "(") push("fn", w);
        else if (l.types && /^[A-Z][A-Za-z0-9]*$/.test(w) && w.length > 1) push("ty", w);
        else plain += w;
        i += w.length;
        continue;
      }
    }
    if (rest === "=>" || /[{}()[\];,]/.test(c)) {
      push("pun", c);
      i++;
      continue;
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}

/** Added lines green, removed red, hunk headers dim. */
function diffTokens(code: string): Token[] {
  const out: Token[] = [];
  const lines = code.split("\n");
  lines.forEach((line, n) => {
    const nl = n < lines.length - 1 ? "\n" : "";
    if (/^(\+\+\+|---|diff |index )/.test(line)) out.push({ t: "meta", s: line + nl });
    else if (line.startsWith("@@")) out.push({ t: "meta", s: line + nl });
    else if (line.startsWith("+")) out.push({ t: "add", s: line + nl });
    else if (line.startsWith("-")) out.push({ t: "del", s: line + nl });
    else out.push({ s: line + nl });
  });
  return out;
}

/** Tags, attributes, strings and comments of HTML or XML. */
function markupTokens(code: string): Token[] {
  const out: Token[] = [];
  const re =
    /<!--[\s\S]*?-->|<\/?[A-Za-z][^\s/>]*|\s[\w:-]+(?==)|"[^"]*"|'[^']*'|\/?>|[^<"'\s/>]+|\s+|[<"'/>]/g;
  let m: RegExpExecArray | null = re.exec(code);
  let inTag = false;
  while (m) {
    const s = m[0];
    if (s.startsWith("<!--")) out.push({ t: "com", s });
    else if (/^<\/?[A-Za-z]/.test(s)) {
      inTag = true;
      out.push({ t: "tag", s });
    } else if (s === ">" || s === "/>") {
      inTag = false;
      out.push({ t: "tag", s });
    } else if (inTag && /^\s[\w:-]+$/.test(s)) out.push({ t: "attr", s });
    else if (inTag && (s.startsWith('"') || s.startsWith("'"))) out.push({ t: "str", s });
    else out.push({ s });
    m = re.exec(code);
  }
  return out;
}

/** The text of a token list, for tests: highlighting never changes the characters. */
export const tokensText = (tokens: Token[]): string => tokens.map((t) => t.s).join("");
