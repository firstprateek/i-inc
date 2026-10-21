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
}

export const defaultCaps: Caps = { maxString: 64 * 1024, maxAction: 1024 * 1024 };

const cut = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}\n[…${s.length - max} more characters not kept]`;

function walk(v: unknown, key: string | undefined, max: number, redact: boolean): unknown {
  if (typeof v === "string") {
    const text = redact && key !== undefined && TEXT_KEYS.has(key) ? redactSecrets(v) : v;
    // `data` is base64 of an image or file: capped by the attachment checks, never cut here.
    return key === "data" ? v : cut(text, max);
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
export function sanitizeAction<T>(action: T, caps: Caps = defaultCaps): T {
  let max = caps.maxString;
  let out = walk(action, undefined, max, true);
  // Strings are cut hard until the action fits: a tool that returns hundreds of big parts.
  while (JSON.stringify(out).length > caps.maxAction && max > 256) {
    max = Math.floor(max / 4);
    out = walk(out, undefined, max, false);
  }
  return out as T;
}
