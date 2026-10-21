// What the host persists from an agent: secrets redacted, and every string and action capped.
//
// Redaction reuses the ticket transcripts' `redactSecrets`, but only on the fields that carry text
// an agent or a tool wrote (output, input, messages, errors). Structural fields (ids, URIs, base64
// `data`) are left alone: the redactor's hex and base64 rules would mangle them. Streaming deltas are
// redacted chunk by chunk, so a secret split across two chunks is not caught; tool results, which
// arrive whole, are.
import { redactSecrets } from "../sessions.ts";
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
  /([?&;](?:access_token|refresh_token|id_token|token|key|api_key|apikey|sig|signature|secret|client_secret|password|passwd|code|auth|x-amz-[a-z0-9-]{1,40}|x-goog-[a-z0-9-]{1,40})=)[^&\s"'#<>]{1,2000}/gi;
const USERINFO = /([a-z][a-z0-9+.-]{0,30}:\/\/)[^/\s@:]{1,200}@/gi;
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]{0,30}PRIVATE KEY-----/g;

/**
 * Private key blocks, whole (up to 20,000 characters between the markers); a block with no end in
 * reach loses the 4,000 characters after its first line. Each end marker is looked for once, however
 * many beginnings come before it, so a text of nothing but beginnings costs one pass.
 */
function redactPem(t: string): string {
  if (!t.includes("PRIVATE KEY-----")) return t;
  let out = "";
  let last = 0;
  let end: RegExpExecArray | null | undefined;
  PEM_BEGIN.lastIndex = 0;
  for (let m = PEM_BEGIN.exec(t); m; m = PEM_BEGIN.exec(t)) {
    if (m.index < last) continue;
    if (end === undefined || (end !== null && end.index < m.index)) {
      PEM_END.lastIndex = m.index;
      end = PEM_END.exec(t);
    }
    const stop =
      end && end.index - m.index <= 20_000
        ? end.index + end[0].length
        : Math.min(t.length, m.index + m[0].length + 4000);
    out += `${t.slice(last, m.index)}[private key]`;
    last = stop;
    PEM_BEGIN.lastIndex = stop;
  }
  return out + t.slice(last);
}

/**
 * `redactSecrets` over a text of any length, in time linear in it (`redactSecrets` itself is bounded:
 * no pattern rescans a long run). In order:
 *  - runs of blanks collapse, so a 64 KB block of newlines costs nothing;
 *  - a data: URI becomes a note of what it was and how big (`[image/png data, 48 KB]`);
 *  - private key blocks go whole, URL userinfo goes, and secret-looking query parameters lose their
 *    values (the URL itself stays);
 *  - the redactor's own patterns (tokens of every sort at any length, JWTs, passwords, key=value);
 *  - last, an unbroken run of 500 or more token characters that is still there, base64 of something
 *    or a path with no end in sight, is replaced by a note of its length.
 * It is all one pass over the whole text, so no secret can fall between pieces of it.
 */
export function redactText(text: string): string {
  let t = text.replace(BLANK_RUN, (m) => (m.includes("\n") ? "\n" : " "));
  t = t.replace(
    DATA_URI,
    (_m, mime: string, payload: string) =>
      `[${mime} data, ${Math.max(1, Math.round(payload.length / 1024))} KB]`,
  );
  t = redactPem(t);
  t = t.replace(USERINFO, "$1[redacted]@").replace(SECRET_QUERY, "$1[redacted]");
  t = redactSecrets(t);
  return t.replace(LONG_RUN, (m) => `[${m.length} characters in one unbroken run, not kept]`);
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

/**
 * Only the patterns that are unmistakably credentials, for file contents (diffs) where the full
 * redactor's hex and base64 rules would mangle source code: GitHub, OpenAI/Anthropic, Google, Slack,
 * AWS and JWT tokens, bearer headers, private key blocks and passwords in URLs.
 */
export function redactTokens(text: string): string {
  let out = text.length > 1_000_000 ? text.slice(0, 1_000_000) : text;
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[redacted private key]",
  );
  out = out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]");
  out = out.replace(/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[redacted]");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
  out = out.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted]");
  out = out.replace(/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, "[redacted]");
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/g, "[redacted]");
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]");
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:\s/@]+):([^@\s/]+)@/g, "$1$2:[redacted]@");
  return out;
}
