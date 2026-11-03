// The last pass on text where it leaves the daemon (r131): the WebSocket frame, the REST body, a GitHub pull
// request's title and body, and a push notification. Nothing reads a sink's output back, so what is stored stays
// exactly what main stores, and every read the daemon makes of its own text gives main's result.
//
// Each sink is "what main sent, then a pass that only takes text out":
//   - the WebSocket gets `redactLast` on the strings the host already ran `sanitizeAction` on;
//   - an owner view over REST gets `redactProse`, then `redactLast`, on agent and system text;
//   - text that leaves the machine (GitHub, push) gets `redactText`, then `redactLast`.
// `guarded` checks every result at run time: it is kept only if, with its markers taken out, it is made of its
// input's characters in order. So a bug in a redactor here can only hide more, never show what main hid.
//
// `redactLast` never runs over serialized JSON (a URL scan would run from one field into the next): objects are
// walked and their strings redacted one by one, and JSON held in a string is redacted one decoded string literal
// at a time, so it stays JSON.
import type { TicketEvent } from "@i-inc/core";
import { redactLast, redactProse, redactText, TEXT_KEYS } from "./ahp/sanitize.ts";
import type { ProposalView, TicketView } from "./view-types.ts";

/**
 * The redactors the sinks call, and how often each ran. Tests swap one to prove the guard catches a redactor that
 * adds text, and read the counts to pin the cost.
 */
export const sinkRedactors = {
  last: redactLast as (s: string) => string,
  prose: redactProse as (s: string) => string,
  text: redactText as (s: string) => string,
};
export const sinkStats = { last: 0, prose: 0, text: 0, trips: 0 };

const last = (s: string): string => {
  sinkStats.last++;
  return sinkRedactors.last(s);
};
const prose = (s: string): string => {
  sinkStats.prose++;
  return sinkRedactors.prose(s);
};
const text = (s: string): string => {
  sinkStats.text++;
  return sinkRedactors.text(s);
};

// ── the guard ────────────────────────────────────────────────────────────────────────────────────────────

/** Every marker a redactor on main writes in place of what it took out. */
const MARKERS =
  /\[redacted\]|\[private key\]|\[[a-z0-9.+-]{1,60}\/[a-z0-9.+-]{1,60} data, \d+ KB\]|\[\d+ characters in one unbroken run, not kept\]/gi;

/**
 * Is `out`, with its markers taken out, made of `input`'s characters in order? Then nothing `out` shows was missing
 * from `input`. The test `copy-files.test.ts` holds `redactLast` to, run on every result. Linear: each piece
 * between markers is first looked for whole, and only character by character when that fails (a run of blanks
 * that `redactText` made one blank). Taking the first place a piece is found never ends later than where it came
 * from, so a masker's output always passes.
 */
export function takesOutOnly(input: string, out: string): boolean {
  if (out === input) return true;
  let at = 0;
  const piece = (from: number, to: number): boolean => {
    if (from === to) return true;
    const p = out.slice(from, to);
    const whole = input.indexOf(p, at);
    if (whole >= 0) {
      at = whole + p.length;
      return true;
    }
    for (let i = from; i < to; i++) {
      at = input.indexOf(out.charAt(i), at);
      if (at < 0) return false;
      at++;
    }
    return true;
  };
  let from = 0;
  MARKERS.lastIndex = 0;
  for (let m = MARKERS.exec(out); m; m = MARKERS.exec(out)) {
    if (!piece(from, m.index)) return false;
    from = m.index + m[0].length;
  }
  return piece(from, out.length);
}

let sinkLog: (line: string) => void = (line) => console.warn(line);
let logged = false;
/** Where the one line about a redactor that added text goes (the daemon's log). */
export function setSinkLog(log: (line: string) => void): void {
  sinkLog = log;
}

/**
 * A sink's result, kept only if it only takes out of `input`; otherwise the whole string is `[redacted]` and the
 * first time it happens is logged. The log line names no text.
 */
export function guarded(input: string, out: string): string {
  if (out === input || takesOutOnly(input, out)) return out;
  sinkStats.trips++;
  if (!logged) {
    logged = true;
    sinkLog(
      `sinks: a redactor added text to a ${input.length}-character string; it was sent as [redacted] (logged once)`,
    );
  }
  return "[redacted]";
}

// ── the cheap test, and the memo ─────────────────────────────────────────────────────────────────────────

/** `LONG_SECRET_QUERY`'s names, whole. */
const QUERY_NAME =
  /^(?:access_token|refresh_token|id_token|token|key|api_key|apikey|sig|signature|secret|client_secret|password|passwd|pwd|pass|passphrase|code|auth|x-amz-[a-z0-9-]{1,40}|x-goog-[a-z0-9-]{1,40})$/i;
/** Is there a `?name=`, `&name=` or `;name=` with one of those names? By hand, back from each `=`. */
function queryName(s: string): boolean {
  for (let p = s.indexOf("="); p >= 0; p = s.indexOf("=", p + 1)) {
    for (let i = p - 1; i >= 0 && i >= p - 47; i--) {
      const c = s.charCodeAt(i);
      if (c === 63 || c === 38 || c === 59) {
        if (i < p - 1 && QUERY_NAME.test(s.slice(i + 1, p))) return true;
        break;
      }
      if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45))
        break;
    }
  }
  return false;
}
const UNDERSCORE_HINT = /gh[opsu]_|github_pat_|k_live_|npm_|whsec_/;

/**
 * False only when `redactLast(s) === s` for certain: each of its steps needs one of these to change anything (the
 * two URL scans an `@` and a `://`, `LONG_SECRET_QUERY` a `?name=`, `GLUED_TOKEN` a prefix, `redactJwts` a `.eyJ`,
 * the webhook rule `whsec_`). A test holds it to that over a fuzzed corpus.
 */
export function lastDirty(s: string): boolean {
  if (s.includes("@") && s.includes("://")) return true;
  if (s.includes("=") && queryName(s)) return true;
  if (s.includes("_") && UNDERSCORE_HINT.test(s)) return true;
  return (
    s.includes("sk-") || s.includes("AIza") || s.includes("xox") || s.includes("AKIA") || s.includes(".eyJ")
  );
}

/** The result is the input itself: kept as a marker, not a copy. */
const SAME = "\u0000same";

/**
 * A bounded LRU of text to its sink result, by content (never by object identity), in memory only. Redaction is
 * a pure function of its text, so a hit is exact. `maxChars` counts keys and kept results.
 */
export class TextMemo {
  private readonly m = new Map<string, string>();
  private chars = 0;
  hits = 0;
  misses = 0;
  constructor(private readonly maxChars: number) {}
  get(s: string): string | undefined {
    const v = this.m.get(s);
    if (v === undefined) return undefined;
    this.hits++;
    this.m.delete(s);
    this.m.set(s, v);
    return v === SAME ? s : v;
  }
  set(s: string, r: string): string {
    this.misses++;
    if (s.length > this.maxChars / 4) return r; // one string never takes over the memo
    const v = r === s ? SAME : r;
    this.m.set(s, v);
    this.chars += s.length + (v === SAME ? 0 : v.length);
    for (const [k, x] of this.m) {
      if (this.chars <= this.maxChars) break;
      this.m.delete(k);
      this.chars -= k.length + (x === SAME ? 0 : x.length);
    }
    return r;
  }
  get size(): { entries: number; chars: number } {
    return { entries: this.m.size, chars: this.chars };
  }
  clear(): void {
    this.m.clear();
    this.chars = 0;
    this.hits = 0;
    this.misses = 0;
  }
}

/** 15M characters together at most: 30 MB of UTF-16 at worst, much less for ASCII. */
const memos = {
  last: new TextMemo(6_000_000),
  lastJson: new TextMemo(3_000_000),
  people: new TextMemo(6_000_000),
};
export const sinkMemos = memos;

/** Strings this long are looked up before the cheap test: a repeat read then costs one lookup. */
const LOOK_FIRST = 1024;
/** People views memoise only strings this long: shorter ones cost less to redact than to keep. */
const PEOPLE_MEMO_MIN = 256;

// ── the passes, one string at a time ─────────────────────────────────────────────────────────────────────

/** A JSON string literal, complete. */
const LITERAL = /"(?:[^"\\\n]|\\.)*"/g;

/**
 * `redactLast` on each run between quotes, for a piece of JSON whose literals can't be told apart (an unfinished
 * literal, text outside the literals of something that isn't quite JSON): no scan crosses a `"`.
 */
function lastLocal(t: string): string {
  if (!lastDirty(t)) return t;
  if (!t.includes('"')) return guarded(t, last(t));
  return t
    .split('"')
    .map((p) => (lastDirty(p) ? guarded(p, last(p)) : p))
    .join('"');
}

/**
 * `redactLast` inside each JSON string literal of `s`, never across two: each literal is decoded, redacted under the
 * guard and encoded again only if it changed, so keys, numbers and layout keep their place and the text stays
 * JSON when it was. A literal that won't decode, and anything outside the literals, gets `lastLocal`.
 */
function lastInJson(s: string): string {
  let out = "";
  let from = 0;
  let changed = false;
  LITERAL.lastIndex = 0;
  for (let m = LITERAL.exec(s); m; m = LITERAL.exec(s)) {
    const between = s.slice(from, m.index);
    const b = lastLocal(between);
    let lit = m[0];
    let v: unknown;
    try {
      v = JSON.parse(lit);
    } catch {
      v = undefined;
    }
    if (typeof v === "string") {
      if (lastDirty(v)) {
        const r = guarded(v, last(v));
        if (r !== v) lit = JSON.stringify(r);
      }
    } else {
      lit = `"${lastLocal(lit.slice(1, -1))}"`;
    }
    if (b !== between || lit !== m[0]) changed = true;
    out += b + lit;
    from = m.index + m[0].length;
  }
  const rest = s.slice(from);
  const r = lastLocal(rest);
  if (r !== rest) changed = true;
  return changed ? out + r : s;
}

/** Text a JSON parser takes whole, so that what is between its literals is JSON's own punctuation. */
const isJsonDoc = (s: string): boolean => {
  const c = s.trimStart().charAt(0);
  if (c !== "{" && c !== "[") return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/** An escape that decodes to a character the cheap test looks for. */
const ESCAPE = /\\u|\\\//;

/**
 * The WebSocket's pass on one text value: `redactLast`, under the guard, memoised. A tool's input (`json`), or a
 * value that is a whole JSON document, is redacted literal by literal.
 */
export function lastOf(s: string, json = false): string {
  const memo = json ? memos.lastJson : memos.last;
  const long = s.length >= LOOK_FIRST;
  if (long) {
    const hit = memo.get(s);
    if (hit !== undefined) return hit;
  }
  const maybeJson = json || STARTS_JSON.test(s);
  if (!lastDirty(s) && !(maybeJson && ESCAPE.test(s))) return long ? memo.set(s, s) : s;
  if (!long) {
    const hit = memo.get(s);
    if (hit !== undefined) return hit;
  }
  return memo.set(s, json || (maybeJson && isJsonDoc(s)) ? lastInJson(s) : guarded(s, last(s)));
}
const STARTS_JSON = /^\s*[[{]/;

/**
 * For people reading agent and system text in the owner's views (REST): `redactProse`, then `redactLast`, under the
 * guard. No hex or base64 guesses, so commit ids still show. Memoised: events are read again on every request.
 */
export function peopleOf(s: string): string {
  if (!s) return s;
  if (s.length >= PEOPLE_MEMO_MIN) {
    const hit = memos.people.get(s);
    if (hit !== undefined) return hit;
  }
  const r = guarded(s, last(prose(s)));
  return s.length >= PEOPLE_MEMO_MIN ? memos.people.set(s, r) : r;
}

/** For text that leaves the machine (a pull request's title and body, a push): `redactText`, then `redactLast`. */
export function outsideOf(s: string): string {
  if (!s) return s;
  return guarded(s, last(text(s)));
}

// ── the WebSocket ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Keys whose strings are text at the sink: the host's `TEXT_KEYS`, and the ones `sanitizeAction` never redacted
 * though a person reads them (a slash command's `description` and input `hint`, a message's `markdown`).
 */
const SINK_TEXT_KEYS: ReadonlySet<string> = new Set([...TEXT_KEYS, "description", "hint", "markdown"]);
/** A tool's input, kept as JSON text. */
const JSON_KEYS = new Set(["toolInput", "partialInput"]);

declare const wireBrand: unique symbol;
/** A frame made by the WebSocket sink: the host's `sendText` takes nothing else. */
export type Wire = string & { readonly [wireBrand]: true };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A message the owner typed: `{ text, origin: { kind: "user" } }`. */
const ownerMessage = (o: Record<string, unknown>): boolean =>
  typeof o.text === "string" && isObj(o.origin) && o.origin.kind === "user";

/**
 * The WebSocket's copy of an AHP value: `redactLast` on the strings under a text key, everything else as it is
 * (ids, URIs, paths, option values, base64 `data`). A message the owner typed is left as typed, except on a
 * read-only channel (a ticket stage), where the "message" is the daemon's brief. The channel is the nearest
 * `channel` or `resource` above. Only the parts that change are copied: with nothing to change, the same object
 * comes back. Never cuts.
 */
export function outward<T>(v: T, readOnly: (uri: string) => boolean = () => false): T {
  const ro = new Map<string, boolean>();
  const isReadOnly = (uri: string): boolean => {
    let r = ro.get(uri);
    if (r === undefined) {
      r = uri.startsWith("ahp-chat:/stage:") || readOnly(uri);
      ro.set(uri, r);
    }
    return r;
  };
  const walk = (x: unknown, key: string | undefined, ch: string): unknown => {
    if (typeof x === "string") {
      if (key === undefined || !SINK_TEXT_KEYS.has(key)) return x;
      return lastOf(x, JSON_KEYS.has(key));
    }
    if (Array.isArray(x)) {
      let out: unknown[] | undefined;
      for (let i = 0; i < x.length; i++) {
        const y = walk(x[i], key, ch);
        if (y === x[i]) continue;
        out ??= x.slice();
        out[i] = y;
      }
      return out ?? x;
    }
    if (isObj(x)) {
      const here =
        typeof x.channel === "string" ? x.channel : typeof x.resource === "string" ? x.resource : ch;
      if (ownerMessage(x) && !isReadOnly(here)) return x;
      let out: Record<string, unknown> | undefined;
      for (const k of Object.keys(x)) {
        const y = walk(x[k], k, here);
        if (y === x[k]) continue;
        out ??= { ...x };
        out[k] = y;
      }
      return out ?? x;
    }
    return x;
  };
  return walk(v, undefined, "") as T;
}

/** A JSON-RPC frame for the WebSocket, through the sink. The only way to make a `Wire`. */
export function wire(frame: unknown, readOnly?: (uri: string) => boolean): Wire {
  return JSON.stringify(outward(frame, readOnly)) as Wire;
}

/** A stored blob read as text (a diff side): `redactLast`, by literal when it is JSON. */
export function blobText(data: string, mime: string): string {
  return lastOf(data, /^application\/json/.test(mime));
}

// ── REST: the owner's views ─────────────────────────────────────────────────────────────────────────────

/**
 * Keys whose strings the web reads as data, or that a person never needs hidden: ids, hashes, links, paths, enum
 * values, names of engines and models. Everything else is text and gets the pass, so a field added later is
 * redacted unless it is named here.
 */
const STRUCT_KEY =
  /^(?:id|ids|uri|url|href|resource|channel|data|contentType|mime|sha|headSha|hash|harvest|commit|at|seq|type|kind|status|stage|state|path|paths|page|slug|scope|role|tint|verdict|severity|column|effort|outcome|decision|duty|via|op|code|pr|project|repo|branch|engine|model|harness|employee|assignee|to|from|tag|endpoint|publicKey)$|(?:Id|Ids|At|Url|Sha|Until|Paths)$/;

/**
 * An owner view's copy of a value: `peopleOf` on every string but the structural ones. A `diff` is already
 * redacted file text (a held change: `redactTokens`, then `redactLast`), so it gets `redactLast` only: the keyed
 * rules would take `token: string` out of code.
 */
export function peopleDeep<T>(v: T, key?: string): T {
  if (typeof v === "string") {
    if (key !== undefined && STRUCT_KEY.test(key)) return v;
    return (key === "diff" ? lastOf(v) : peopleOf(v)) as T;
  }
  if (Array.isArray(v)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < v.length; i++) {
      const y = peopleDeep(v[i], key);
      if (y === v[i]) continue;
      out ??= v.slice();
      out[i] = y;
    }
    return (out ?? v) as T;
  }
  if (isObj(v)) {
    let out: Record<string, unknown> | undefined;
    for (const k of Object.keys(v)) {
      const y = peopleDeep(v[k], k);
      if (y === v[k]) continue;
      out ??= { ...v };
      out[k] = y;
    }
    return (out ?? v) as T;
  }
  return v;
}

/**
 * A ticket as the owner's views show it. The owner's own words stay as typed (decision 1): the title, reason and
 * "done when" of a ticket the owner filed, and its images. An agent's follow-up gets the pass on those too.
 */
export function peopleView<V extends TicketView>(v: V): V {
  const ownerFiled = !v.createdBy;
  const out: Record<string, unknown> = { ...(v as Record<string, unknown>) };
  for (const [k, x] of Object.entries(v)) {
    if (k === "attachments") continue;
    if (ownerFiled && (k === "title" || k === "reason" || k === "doneWhen")) continue;
    if (k === "report" && ownerFiled && isObj(x)) {
      out[k] = { ...peopleDeep(x), title: x.title };
      continue;
    }
    out[k] = peopleDeep(x, k);
  }
  return out as V;
}

/** A ticket's event log as the owner's views show it: every event but the owner's own (`owner-*`). */
export function peopleEvents<E extends TicketEvent>(events: readonly E[]): E[] {
  return events.map((e) => (typeof e.type === "string" && e.type.startsWith("owner-") ? e : peopleDeep(e)));
}

/** A follow-up an agent proposed: all of it is the agent's. */
export function peopleProposal<P extends ProposalView>(p: P): P {
  return peopleDeep(p);
}

/** A ticket's title where the owner's views list it: the owner's own as typed, an agent's with the pass. */
export function peopleTitle(title: string, createdBy: string | null | undefined): string {
  return !createdBy || createdBy === "owner" ? title : peopleOf(title);
}

/**
 * A conversation's row as the REST API shows it: its title (the owner's first line, or the agent's own) gets
 * `redactLast`, as the WebSocket gives it (decision 6: not redacted where it is stored).
 */
export function peopleConversation<C extends { title: string }>(c: C): C {
  const title = lastOf(c.title);
  return title === c.title ? c : { ...c, title };
}

/** A conversation's shipping view: its ticket's live line and the reasons are the daemon's and the agent's words. */
export function peopleShip<S extends { suggestion?: unknown }>(s: S): S {
  const { suggestion, ...rest } = s;
  // What the confirm dialog starts with is made from the owner's own words (decision 1).
  return { ...peopleDeep(rest), ...(suggestion !== undefined ? { suggestion } : {}) } as unknown as S;
}
