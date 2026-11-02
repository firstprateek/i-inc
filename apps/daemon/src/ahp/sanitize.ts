// What the host persists from an agent: secrets redacted, and every string and action capped.
//
// Redaction reuses the ticket transcripts' `redactSecrets`, but only on the fields that carry text
// an agent or a tool wrote (output, input, messages, errors). Structural fields (ids, URIs, base64
// `data`) are left alone: the redactor's hex and base64 rules would mangle them. Streaming deltas are
// redacted chunk by chunk, so a secret split across two chunks is not caught; tool results, which
// arrive whole, are.
import { redactJwts, redactKeyed, redactSecrets } from "../sessions.ts";
import type { Json } from "./wire.ts";

/** Keys whose string values are free text from an agent or a tool. */
const TEXT_KEYS = new Set([
  "content",
  "text",
  "toolInput",
  "partialInput",
  "invocationMessage",
  "pastTenseMessage",
  "confirmationTitle",
  "reasonMessage",
  "message",
  "preview",
  "stack",
  "activity",
  "displayName",
  "intention",
  "label",
  "title",
]);

export interface Caps {
  /** The longest string kept, in UTF-16 units. */
  maxString: number;
  /** The most an action may take once serialised (bytes, roughly). */
  maxAction: number;
  /** The most text a streamed part of a reply may grow to. */
  maxPart: number;
}

export const defaultCaps: Caps = { maxString: 64 * 1024, maxAction: 1024 * 1024, maxPart: 2 * 1024 * 1024 };

const marker = (n: number) => `\n[…${n} more characters not kept]`;

/** An unbroken run of this many token characters or more that survives redaction is not kept. */
const LONG_RUN = /(?<![A-Za-z0-9_+/=.-])[A-Za-z0-9_+/=.-]{500,}/g;
/** A run of blanks this long (spaces, tabs, newlines) is worth one blank. */
const BLANK_RUN = /\s{200,}/g;
const DATA_URI =
  /data:([a-z0-9.+-]{1,60}\/[a-z0-9.+-]{1,60})(?:;[a-z0-9=._+-]{1,60}){0,5},([A-Za-z0-9+/=%_-]{200,})/gi;
const SECRET_QUERY =
  /([?&;](?:access_token|refresh_token|id_token|token|key|api_key|apikey|sig|signature|secret|client_secret|password|passwd|pwd|pass|passphrase|code|auth|x-amz-[a-z0-9-]{1,40}|x-goog-[a-z0-9-]{1,40})=)[^&\s"'#<>]{1,2000}/gi;
// Everything between `://` and the last `@` before the path: a password may hold an `@`.
const USERINFO = /([a-z][a-z0-9+.-]{0,30}:\/\/)[^/\s?#]{1,400}@/gi;
/**
 * What `USERINFO` stopped short of, at any length. Past its limit a quote means a string ended, not that a password goes
 * on: a minified file has no blank or `/` for thousands of characters. Every `://` has a `/`, where the one before it
 * stops, so no character is read twice however many there are.
 */
const LONG_USERINFO = /([a-z][a-z0-9+.-]{0,30}:\/\/)[^/\s?#"'`]+@/gi;
/** What `SECRET_QUERY` stopped short of, at any length, with the end of a `LONG_RUN` note the tail may have become. */
const LONG_SECRET_QUERY = new RegExp(
  `${SECRET_QUERY.source.replace("{1,2000}", "+")}(?: characters in one unbroken run, not kept\\])?`,
  "gi",
);
/** A template's hole, where a host or a port will go. */
const HOLE = String.raw`\$\w+|\$\{.*\}|\$\(\w+\)|\\\([\w.]+\)|\{\{?[^{}]*\}?\}|<\w+>|%\(\w+\)[a-z]|%[sduv]`;
/** What follows the `:` of a host when no password does: a port (or a list of hosts), the word, a hole. */
const PORT = new RegExp(`^(?:\\d{1,5}(?:,.*)?|port|\\*|${HOLE})$`, "i");
/** What before a `:` is a host and no one's user name. A dotted name won't do: `first.last` and `postgres.abcdef` are users. */
const NOT_A_USER = new RegExp(`^(?:localhost|\\d{1,3}(?:\\.\\d{1,3}){3}|${HOLE})(?::|$)`, "i");
/** A hole in Ruby's or Elixir's way, which starts with the `#` that ends an authority. */
const HASH_HOLE = /#\{[^}\s]{0,200}\}/y;
const NEXT_SCHEME = /[a-z][a-z0-9+.-]{0,30}:$/i;
const URL_BLANK = /\s/g;
const AUTHORITY_END = /[/?#\s]/g;
const SCHEME_END = /[a-z][a-z0-9+.-]{0,30}$/i;
/**
 * A token with a word character straight before it (`foo_ghp_...`), which a pattern with a `\b` passes over. Its prefix
 * won't do alone: `highs_and_lows` holds `ghs_`, `task-` holds `sk-`, `disk_live_` holds `sk_live_` and `pnpm_` holds
 * `npm_`. So each kind needs its real length and letters. All hex after `gh?_` or `?k_live_` is a hash, which those
 * vendors don't issue, and a `k_live_` run needs a digit (`network_live_connectionStringPassword`). An `sk-` key with only
 * that prefix to go on is looked for after a `_` or a digit, not a letter: `task-` then a hash is an ordinary name. All
 * of this lowers the odds and no more: a name of the right length and letters still matches.
 */
const GLUED_TOKEN =
  /gh[opsu]_(?![0-9a-f]+(?![A-Za-z0-9]))[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9]{20,}\w*|sk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{16,}|(?<![A-Za-z])sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[0-9][0-9A-Za-z-]{9,}|AKIA[0-9A-Z]{16}(?![0-9A-Za-z])|[sr]k_live_(?![0-9a-f]+(?![A-Za-z0-9]))(?=[A-Za-z]*[0-9])[A-Za-z0-9]{24,}\w*|npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g;
const NAMED_KEY = /^sk-(?:ant|proj|svcacct|admin)-/;
/**
 * After a letter, `sk-admin-` is as likely a name's (`task-admin-dashboard-settings`), so it needs what a key has and a
 * name hasn't: 16 letters and digits in a row, among them a digit or both cases. A short key's `-` and `_` can break up
 * every such run, so capitals and digits anywhere will also do: a name in that case has neither together.
 */
const gluedToken = (m: string, at: number, t: string): string => {
  if (!NAMED_KEY.test(m) || !/[A-Za-z]/.test(t.charAt(at - 1))) return "[redacted]";
  const run = m.match(/[A-Za-z0-9]{16,}/g)?.some((r) => /\d/.test(r) || (/[a-z]/.test(r) && /[A-Z]/.test(r)));
  return run || (/[A-Z]/.test(m) && /\d/.test(m)) ? "[redacted]" : m;
};
// RSA, EC, OPENSSH and plain PRIVATE KEY blocks, and PGP's `PRIVATE KEY BLOCK`.
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----/g;
/** An armor header inside a key: `Version: GnuPG v2`, `DEK-Info: AES-128-CBC,0F1E`. */
const KEY_HEADER = /[ \t]*[A-Za-z][A-Za-z-]{0,29}: [^\n]{0,200}/y;
/** A run of a key's body: base64, or base64 with a written-out `\\n` in it. */
const KEY_RUN = /[ \t]*[A-Za-z0-9+/=\\-]*/y;

/**
 * Private key blocks go whole, however long: from the marker through the end marker, or, with no end
 * marker, through every following line of key material (base64, armor headers, blank lines, or a
 * run of it inside a JSON string) up to the first thing that is not. A body of 30,000 characters is not
 * left half showing, and the words after the key stay. One pass: nothing is looked at twice, and the
 * next end marker is found once and remembered, so any number of begin markers costs one scan.
 */
function redactPem(t: string, keepLines = false): string {
  if (!t.includes("PRIVATE KEY")) return t;
  let out = "";
  let last = 0;
  let end: RegExpExecArray | null | undefined;
  const endFrom = (pos: number): RegExpExecArray | null => {
    if (end === null) return null;
    if (end === undefined || end.index < pos) {
      PEM_END.lastIndex = pos;
      end = PEM_END.exec(t);
    }
    return end;
  };
  PEM_BEGIN.lastIndex = 0;
  for (let m = PEM_BEGIN.exec(t); m; m = PEM_BEGIN.exec(t)) {
    if (m.index < last) continue;
    let pos = m.index + m[0].length;
    let stop = pos;
    while (pos < t.length) {
      KEY_HEADER.lastIndex = pos;
      let lineEnd = -1;
      if (KEY_HEADER.test(t)) lineEnd = KEY_HEADER.lastIndex;
      else {
        KEY_RUN.lastIndex = pos;
        KEY_RUN.test(t);
        const runEnd = KEY_RUN.lastIndex;
        const e = endFrom(pos);
        if (e && e.index <= runEnd) {
          stop = e.index + e[0].length; // the end marker, which is what the run was reaching for
          break;
        }
        const next = t[runEnd];
        const long = runEnd - pos >= 60;
        if (next === undefined || next === "\n" || next === "\r" || long || /["'}\]),;<>]/.test(next)) {
          lineEnd = runEnd;
        } else break; // a word of prose: not part of the key
      }
      stop = lineEnd;
      pos = lineEnd;
      if (t[pos] === "\r") pos++;
      if (t[pos] === "\n")
        pos++; // the newline is the key's only if another line of it follows
      else if (pos < t.length) break; // the line goes on with something else
    }
    const lines = keepLines ? "\n".repeat(t.slice(m.index, stop).split("\n").length - 1) : "";
    out += `${t.slice(last, m.index)}[private key]${lines}`;
    last = stop;
    PEM_BEGIN.lastIndex = stop;
  }
  return out + t.slice(last);
}

/**
 * Does what comes before a URL's first `/`, `?` or `#` stop inside a password, not at a host and port? `USERINFO` may
 * have been here first: after its `[redacted]@`, a name with no port is what's left of a password that held an `@`.
 */
function stopsInPassword(authority: string): boolean {
  const at = authority.lastIndexOf("@");
  const host = authority.slice(at + 1).replace(/^\[.*\]/, ""); // an IPv6 address is all colons
  const colon = host.indexOf(":");
  if (colon >= 0) return !((at < 0 && NOT_A_USER.test(host)) || PORT.test(host.slice(colon + 1)));
  const first = authority.indexOf(":");
  return (first >= 0 && first < at) || authority.startsWith("[redacted]@");
}

/**
 * URL userinfo whose password holds a `/`, `?` or `#`: `postgres://u:ab/cd@h`. Any of those ends the authority, and an `@`
 * after one is usually the path's (`http://localhost:3000/@vite/client`, `https://x.example/react@18`), so `USERINFO` stops
 * there. This goes on only where what it stopped at can't be a host and port, and takes all up to the URL's last `@`.
 *
 * A URL ends at a blank. It ends at the quote that opened it, written the same way (a `\"` doesn't close a `"`), if what
 * comes before that quote reads as a host: `"https://a.example","/@me"` is two strings, and `"postgres://u:a"b/c@h"` is a
 * password with a quote in it. After a `/`, `?` or `#` any such quote ends it, so `"http://a:b/c","me@x"` keeps what is
 * outside the string, and a password that holds its opening quote there shows. A `://` is the next URL's, and its scheme
 * isn't read as a password: `[a](https://a.example)[b](https://b.example/@c)`. A password of up to five digits before a
 * `/`, `?` or `#` reads as a port and stays: that is `localhost:3000/` to anything that reads it.
 *
 * One pass: a run of non-blanks is searched once for its last `@`, an authority ends at the next `://` at the latest, and
 * strings opened by the same quote don't overlap.
 */
function redactCutPasswords(t: string): string {
  if (!t.includes("@")) return t;
  let out = "";
  let last = 0;
  let run = -1;
  let lastAt = -1;
  for (let at = t.indexOf("://"); at >= 0; at = t.indexOf("://", Math.max(at + 3, last))) {
    const from = at + 3;
    if (from > run) {
      URL_BLANK.lastIndex = from;
      run = URL_BLANK.exec(t)?.index ?? t.length;
      const found = t.slice(from, run).lastIndexOf("@");
      lastAt = found < 0 ? -1 : from + found;
    }
    AUTHORITY_END.lastIndex = from;
    const stop = AUTHORITY_END.exec(t)?.index ?? t.length;
    if (stop >= lastAt) continue;
    const authority = t.slice(from, stop);
    if (!stopsInPassword(t.startsWith("//", stop) ? authority.replace(NEXT_SCHEME, "") : authority)) continue;
    HASH_HOLE.lastIndex = stop;
    if (HASH_HOLE.test(t)) continue;
    const scheme = SCHEME_END.exec(t.slice(Math.max(0, at - 31), at));
    if (!scheme) continue;
    let end = lastAt;
    const open = at - scheme[0].length - 1;
    const quote = t[open];
    if (quote === '"' || quote === "'" || quote === "`") {
      const closeFrom = (pos: number) => {
        let close = t.indexOf(quote, pos);
        while (close >= 0 && (t[close - 1] === "\\") !== (t[open - 1] === "\\"))
          close = t.indexOf(quote, close + 1);
        return close;
      };
      const first = closeFrom(from);
      if (first >= 0 && first < stop && !stopsInPassword(t.slice(from, first))) continue;
      const close = closeFrom(stop);
      if (close >= 0 && close < end) {
        const inside = t.slice(stop, close).lastIndexOf("@");
        if (inside < 0) continue;
        end = stop + inside;
      }
    }
    out += `${t.slice(last, from)}[redacted]`;
    last = end;
  }
  return out + t.slice(last);
}

/**
 * The shapes the usual patterns stop short of: a password in a URL that holds a `/`, `?` or `#`, userinfo or a secret
 * query value past their limits, and a token with a word character straight before it. The very last step, on text
 * every other pass has finished with, so it can't take what one of them looks for, such as a secret's name, and what
 * those passes hide stays hidden. It only takes out: what it leaves, without its `[redacted]`, was all there before.
 * `redactTokens`, `redactText` and `redactProse` end with it, and `redactFile`, which has passes of its own.
 */
export function redactLast(text: string): string {
  const t = redactCutPasswords(text)
    .replace(LONG_USERINFO, "$1[redacted]@")
    .replace(LONG_SECRET_QUERY, "$1[redacted]")
    .replace(GLUED_TOKEN, gluedToken);
  return redactJwts(t, /eyJ[A-Za-z0-9_-]{8,}$/).replace(
    /whsec_[A-Za-z0-9+/=]{24,}[A-Za-z0-9+/=_-]*/g,
    "[redacted]",
  );
}

/**
 * Where the usual pattern stopped in a webhook secret, until `whole` takes the rest. Made for each text: what comes after
 * it goes, so an agent must not be able to write one in front of a password, and a noncharacter alone it can.
 */
const secretCut = () => `\uFDD0${crypto.randomUUID()}\uFDD0`;

/**
 * The patterns that are unmistakably credentials, whatever the text is: private key blocks (PGP's
 * too), URL userinfo (a password may hold an `@`), secret-looking query parameters (`?pwd=`, `?token=`),
 * and tokens of the known kinds (GitHub, OpenAI/Anthropic, Google, Slack, AWS key ids and keyed
 * secrets, JWTs, bearer headers). Source code and prose alike: none of these mangles either. The one
 * set behind `redactText` (everything an agent says) and `redactTokens` (diffs and files).
 */
function redactCredentials(text: string, keepLines = false, whole = false): string {
  const cut = whole ? secretCut() : "";
  let t = redactPem(text, keepLines);
  t = t.replace(USERINFO, "$1[redacted]@").replace(SECRET_QUERY, "$1[redacted]");
  t = t.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]");
  t = t.replace(/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[redacted]");
  t = t.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
  t = t.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted]");
  t = t.replace(/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, "[redacted]");
  t = redactJwts(t, /\beyJ[A-Za-z0-9_-]{8,}$/);
  t = t.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]");
  t = t.replace(/\b(?:[sr]k_live|whsec)_[A-Za-z0-9]{8,}\b/g, (m) =>
    whole && m.startsWith("whsec") ? `[redacted]${cut}` : "[redacted]",
  );
  t = t.replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "[redacted]");
  // AWS's 40-character secret access key, named: aws_secret_access_key = ..., "SecretAccessKey": "..."
  t = t.replace(
    /((?:aws[_-]?)?secret[_-]?(?:access[_-]?)?key["']?\s{0,5}[=:]\s{0,5}["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
    "$1[redacted]",
  );
  if (!whole) return t;
  // Last, and only taking more out: taken any earlier, a secret's end could take what another pattern looks for.
  return (
    t
      .replace(new RegExp(`${cut}[A-Za-z0-9+/=_-]*`, "g"), "")
      .replace(/\b[sr]k_live_[A-Za-z0-9]{16,}\w*/g, "[redacted]")
      // Eight characters before any `_` or `-`: `whsec_your_webhook_secret` is a placeholder for one.
      .replace(/\bwhsec_[A-Za-z0-9+/=]{8,}[A-Za-z0-9+/=_-]*/g, "[redacted]")
  );
}

/**
 * `redactSecrets` over a text of any length, in time linear in it (`redactSecrets` itself is bounded:
 * no pattern rescans a long run). In order:
 *  - runs of blanks collapse, so a 64 KB block of newlines costs nothing;
 *  - a data: URI becomes a note of what it was and how big (`[image/png data, 48 KB]`);
 *  - private key blocks go whole, URL userinfo goes, and secret-looking query parameters lose their
 *    values (the URL itself stays);
 *  - the redactor's own patterns (tokens of every sort at any length, JWTs, passwords, key=value);
 *  - an unbroken run of 500 or more token characters that is still there, base64 of something
 *    or a path with no end in sight, is replaced by a note of its length;
 *  - last, `redactLast`.
 * It is all one pass over the whole text, so no secret can fall between pieces of it.
 */
export function redactText(text: string): string {
  let t = text.replace(BLANK_RUN, (m) => (m.includes("\n") ? "\n" : " "));
  t = t.replace(
    DATA_URI,
    (_m, mime: string, payload: string) =>
      `[${mime} data, ${Math.max(1, Math.round(payload.length / 1024))} KB]`,
  );
  t = redactCredentials(t);
  t = redactSecrets(t);
  return redactLast(t.replace(LONG_RUN, (m) => `[${m.length} characters in one unbroken run, not kept]`));
}

/**
 * A string kept to `max` characters. When it is redacted, that happens before it is cut, on the
 * text with a margin past the cut, and the cut falls on a boundary, never inside a token.
 */
function keep(v: string, max: number, redact: boolean): string {
  if (v.length <= max) return redact ? redactText(v) : v;
  const head = v.slice(0, max + 1024);
  let r = redact ? redactText(head) : head;
  if (r.length > max) r = r.slice(0, max);
  if (redact) {
    // The end of the head may be the first half of something: back up to a blank within the last
    // 512 characters (a quarter of a short string), or drop that much.
    const back = Math.min(512, Math.floor(r.length / 4));
    const blank = Math.max(r.lastIndexOf(" "), r.lastIndexOf("\n"));
    r = blank >= r.length - back && blank > 0 ? r.slice(0, blank) : r.slice(0, r.length - back);
  }
  return r + marker(v.length - r.length);
}

function walk(v: unknown, key: string | undefined, max: number, redact: boolean): unknown {
  if (typeof v === "string") {
    // `data` is base64 of an image or file: capped by the attachment checks, never cut here.
    if (key === "data") return v;
    return keep(v, max, redact && key !== undefined && TEXT_KEYS.has(key));
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, key, max, redact));
  if (v && typeof v === "object") {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, k, max, redact);
    return out;
  }
  return v;
}

/**
 * An action from the backend, made safe to keep: text fields redacted, strings capped, and the
 * whole action shrunk (shorter strings) if it is still over the cap.
 */
export function sanitizeAction<T>(action: T, caps: Pick<Caps, "maxString" | "maxAction"> = defaultCaps): T {
  let max = caps.maxString;
  let out = walk(action, undefined, max, true);
  // Strings are cut hard until the action fits: a tool that returns hundreds of big parts.
  while (JSON.stringify(out).length > caps.maxAction && max > 256) {
    max = Math.floor(max / 4);
    out = walk(out, undefined, max, false);
  }
  return out as T;
}

/** The most of a text `redactTokens` reads: the rest is dropped. */
export const MAX_REDACTED = 1_000_000;

/**
 * Only the patterns that are unmistakably credentials, for file contents (diffs) where the full
 * redactor's hex and base64 rules would mangle source code: GitHub, OpenAI/Anthropic, Google, Slack,
 * AWS and JWT tokens, bearer headers, private key blocks and passwords in URLs: the same set
 * `redactText` starts with (`redactCredentials`). It leaves `token: string` in source code alone. With
 * `keepLines`, a key block leaves its line breaks behind, so what follows it keeps its line numbers. With
 * `whole`, a live payment key or webhook secret goes to its end, past what the usual pattern takes.
 */
export function redactTokens(text: string, opts: { keepLines?: boolean; whole?: boolean } = {}): string {
  return redactLast(redactKnown(text, opts));
}

/** `redactTokens` without `redactLast`, for a caller with passes of its own that have to come before it. */
export function redactKnown(text: string, opts: { keepLines?: boolean; whole?: boolean } = {}): string {
  return redactCredentials(
    text.length > MAX_REDACTED ? text.slice(0, MAX_REDACTED) : text,
    opts.keepLines,
    opts.whole,
  );
}

/**
 * For prose that people read later, such as brain pages: every credential `redactTokens` finds, and anything
 * named like a secret (`password: x`, `API_KEY=x`, `--token x`), the same sets `redactText` uses, without its
 * hex and base64 guesses (a commit id in a page stays).
 */
export function redactProse(text: string): string {
  return redactLast(
    redactKeyed(redactKnown(text))
      .replace(/(client[_-]?secret["']?\s*[:=]\s*)(["']?)[^\s"',;]{4,}\2/gi, "$1[redacted]")
      .replace(/(\bsecret["']?\s*=\s*)(?:(["'])[^"'\n]{1,500}\2|[^\s"',;]{4,})/gi, "$1[redacted]"),
  );
}
