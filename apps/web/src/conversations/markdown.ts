// Markdown for the agent's replies. It builds Lit templates directly from a small parsed tree, so the
// text of a message is never turned into HTML: raw HTML in a reply shows as the text it is, a link is only
// ever http(s), mailto or an in-page anchor, and an image becomes a link (nothing loads by itself). That is
// the sanitising: there is no HTML string to sanitise.
//
// Incremental: a reply is cut into top-level chunks (paragraphs, fenced code, lists...). `MarkdownCache`
// keeps each chunk's rendered template by its source text, so while a reply streams only the last, still
// growing chunk is parsed again, and a long reply costs the same per frame as a short one.
import { html, nothing, type TemplateResult } from "lit";
import { highlight, type Token } from "./highlight.ts";

// ───────────────────────────── the tree ─────────────────────────────

export type Inline =
  | { k: "text"; s: string }
  | { k: "code"; s: string }
  | { k: "strong" | "em" | "del"; c: Inline[] }
  | { k: "link"; href: string; c: Inline[] }
  | { k: "br" };

export type Block =
  | { k: "p"; c: Inline[] }
  | { k: "h"; level: number; c: Inline[] }
  | { k: "code"; lang: string; code: string; open: boolean }
  | { k: "ul" | "ol"; start: number; items: Item[] }
  | { k: "quote"; c: Block[] }
  | { k: "hr" }
  | { k: "table"; head: Inline[][]; align: ("left" | "center" | "right" | null)[]; rows: Inline[][][] };

export interface Item {
  /** undefined: not a task; otherwise whether it is ticked. */
  task: boolean | undefined;
  c: Block[];
}

// ───────────────────────────── chunks ─────────────────────────────

/** A line longer than this is shown as plain text: nothing here is allowed to cost more than a line's length. */
export const MAX_LINE = 4000;

/** How many characters to look ahead for the end of a link, a code span or an emphasis. */
const WINDOW = 1500;

/** Spaces at the start of a line, at most `max` of them; -1 when there are more (an indented code line). */
function indentOf(line: string, max: number): number {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n++;
  return n > max ? -1 : n;
}

/** An opening code fence (three or more backticks or tildes, then an optional language), or null. */
function fenceOpen(line: string): { mark: string; lang: string } | null {
  const at = indentOf(line, 3);
  if (at < 0) return null;
  const c = line.charAt(at);
  if (c !== "`" && c !== "~") return null;
  let end = at;
  while (line.charAt(end) === c) end++;
  if (end - at < 3) return null;
  const rest = line.slice(end);
  // A backtick fence's info string may not hold a backtick (that would be inline code).
  if (c === "`" && rest.includes("`")) return null;
  return { mark: line.slice(at, end), lang: rest.trim().split(/\s/, 1)[0] ?? "" };
}

/** A closing fence of at least `mark`'s length, with nothing after it. */
function fenceClose(line: string, mark: string): boolean {
  const at = indentOf(line, 3);
  if (at < 0 || line.charAt(at) !== mark.charAt(0)) return false;
  let end = at;
  while (line.charAt(end) === mark.charAt(0)) end++;
  return end - at >= mark.length && line.slice(end).trim() === "";
}

/** An ATX heading: one to six `#`, a space, the text (a closing run of `#` is dropped). */
function heading(line: string): { level: number; text: string } | null {
  const at = indentOf(line, 3);
  if (at < 0) return null;
  let end = at;
  while (line.charAt(end) === "#") end++;
  const level = end - at;
  if (level < 1 || level > 6 || !/\s/.test(line.charAt(end))) return null;
  let text = line.slice(end).trim();
  let cut = text.length;
  while (cut > 0 && text.charAt(cut - 1) === "#") cut--;
  if (cut < text.length && (cut === 0 || /\s/.test(text.charAt(cut - 1)))) text = text.slice(0, cut).trim();
  return { level, text };
}

/** A thematic break: three or more of one of `-`, `*`, `_`, with only spaces between. */
function isHr(line: string): boolean {
  const at = indentOf(line, 3);
  if (at < 0) return false;
  const c = line.charAt(at);
  if (c !== "-" && c !== "*" && c !== "_") return false;
  let n = 0;
  for (let i = at; i < line.length; i++) {
    const ch = line.charAt(i);
    if (ch === c) n++;
    else if (ch !== " " && ch !== "\t") return false;
  }
  return n >= 3;
}

/** The row under a table's header: cells of dashes with optional colons. */
function isTableSep(line: string): boolean {
  let t = line.trim();
  if (!t.includes("-")) return false;
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").every((c) => /^:?-+:?$/.test(c.trim()));
}

/**
 * Cuts text into top-level chunks: runs of lines separated by blank lines, except that a fenced code block
 * (which may hold blank lines) is one chunk. Returns the start offset of each chunk.
 */
export function chunkStarts(text: string, from = 0): number[] {
  const starts: number[] = [];
  let pos = from;
  let fence: string | undefined;
  let inChunk = false;
  while (pos < text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end);
    if (fence !== undefined) {
      if (fenceClose(line, fence)) {
        fence = undefined;
        // The chunk ends with its closing fence; whatever follows begins a new one.
        inChunk = false;
      }
    } else if (line.trim() === "") {
      inChunk = false;
    } else {
      const open = fenceOpen(line);
      if (open) {
        // A fence always starts a chunk of its own.
        starts.push(pos);
        fence = open.mark;
        inChunk = true;
      } else if (!inChunk) {
        starts.push(pos);
        inChunk = true;
      }
    }
    pos = end + 1;
  }
  return starts;
}

// ───────────────────────────── block parser ─────────────────────────────

const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

const startsBlock = (line: string): boolean =>
  fenceOpen(line) !== null ||
  heading(line) !== null ||
  isHr(line) ||
  QUOTE.test(line) ||
  BULLET.test(line) ||
  ORDERED.test(line);

/** Parses one chunk (or a nested part of one) into blocks. `open` marks a code block the text ended inside. */
export function parseBlocks(text: string, depth = 0): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.length > MAX_LINE) {
      out.push({ k: "p", c: [{ k: "text", s: line }] });
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      const mark = fence.mark;
      const body: string[] = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (fenceClose(l, mark)) {
          closed = true;
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      out.push({ k: "code", lang: fence.lang, code: body.join("\n"), open: !closed });
      continue;
    }
    const h = heading(line);
    if (h) {
      out.push({ k: "h", level: h.level, c: inline(h.text) });
      i++;
      continue;
    }
    if (isHr(line)) {
      out.push({ k: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line) && depth < 4) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) {
        body.push(QUOTE.exec(lines[i] ?? "")?.[1] ?? "");
        i++;
      }
      out.push({ k: "quote", c: parseBlocks(body.join("\n"), depth + 1) });
      continue;
    }
    const li = BULLET.exec(line) ?? ORDERED.exec(line);
    if (li && depth < 3) {
      const ordered = ORDERED.test(line) && !BULLET.test(line);
      const baseIndent = (li[1] ?? "").length;
      const items: Item[] = [];
      const start = ordered ? Number(ORDERED.exec(line)?.[2] ?? 1) : 1;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = ordered ? ORDERED.exec(l) : BULLET.exec(l);
        if (!m || (m[1] ?? "").length > baseIndent + 1 || (m[1] ?? "").length < baseIndent) break;
        const marker = ordered ? (m[2] ?? "").length + 1 : 1;
        const body: string[] = [m[3] ?? ""];
        const contentIndent = baseIndent + marker + 1;
        i++;
        // Continuation: indented lines (nested lists, code, paragraphs), and blank lines between them.
        while (i < lines.length) {
          const n = lines[i] ?? "";
          if (n.trim() === "") {
            const after = lines[i + 1] ?? "";
            if (
              after.trim() !== "" &&
              /^\s{2,}\S/.test(after) &&
              after.length - after.trimStart().length >= baseIndent + 2
            ) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          const indent = n.length - n.trimStart().length;
          if (indent >= baseIndent + 2) {
            body.push(n.slice(Math.min(indent, contentIndent)));
            i++;
          } else if (indent <= baseIndent && (BULLET.test(n) || ORDERED.test(n) || startsBlock(n))) break;
          else if (!startsBlock(n)) {
            body.push(n.trim());
            i++;
          } else break;
        }
        let first = body[0] ?? "";
        let task: boolean | undefined;
        const t = /^\[([ xX])\]\s+(.*)$/.exec(first);
        if (t) {
          task = t[1] !== " ";
          first = t[2] ?? "";
        }
        body[0] = first;
        // The usual item is one line of text: no need to parse it as a document.
        const plain =
          body.length === 1 && first.length <= MAX_LINE && first.trim() !== "" && !startsBlock(first);
        items.push({
          task,
          c: plain ? [{ k: "p", c: inline(first.trim()) }] : parseBlocks(body.join("\n"), depth + 1),
        });
        // A blank line between items keeps the same list going when the next line is another item.
        if ((lines[i] ?? "").trim() === "" && (ordered ? ORDERED : BULLET).test(lines[i + 1] ?? "")) i++;
      }
      out.push({ k: ordered ? "ol" : "ul", start, items });
      continue;
    }
    // A table: a header row, a separator row, then rows.
    if (line.includes("|") && isTableSep(lines[i + 1] ?? "")) {
      const head = cells(line);
      const sep = cells(lines[i + 1] ?? "");
      if (head.length === sep.length || head.length > 0) {
        const align = sep.map((s) => {
          const t = s.trim();
          return t.startsWith(":") && t.endsWith(":")
            ? "center"
            : t.endsWith(":")
              ? "right"
              : t.startsWith(":")
                ? "left"
                : null;
        });
        i += 2;
        const rows: Inline[][][] = [];
        while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
          rows.push(cells(lines[i] ?? "").map(inline));
          i++;
        }
        out.push({ k: "table", head: head.map(inline), align, rows });
        continue;
      }
    }
    // A paragraph: lines until a blank line or the start of another block.
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      (lines[i] ?? "").length <= MAX_LINE &&
      !startsBlock(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i++;
    }
    out.push({ k: "p", c: inline(para.map((l) => l.trim()).join("\n")) });
  }
  return out;
}

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

// ───────────────────────────── inline parser ─────────────────────────────

/**
 * Only http(s) and mailto links can be followed. Anything else (javascript:, data:, file:, an in-page `#`
 * anchor, which would move the app off the conversation) is shown as its text.
 */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (h.length > 2000) return null;
  try {
    const u = new URL(h);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * Inline markdown. Every search here is bounded: a closer is looked for within a window, nesting is capped,
 * and a search that found nothing from one place is not repeated from a later one, so no input (a run of
 * `[`, of `*a `, of backticks) costs more than a pass or two over the text.
 */
export function inline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) {
      out.push({ k: "text", s: text });
      text = "";
    }
  };
  // A search for a closer that found none from `p` will find none from any later position.
  const noCode = new Map<number, number>();
  const noEmphasis = new Map<string, number>();
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(src.charAt(i + 1))) {
      text += src.charAt(i + 1);
      i += 2;
      continue;
    }
    if (c === "\n") {
      flush();
      out.push({ k: "br" });
      i++;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (src.charAt(i + n) === "`") n++;
      const mark = "`".repeat(n);
      const failed = noCode.get(n);
      const end = failed !== undefined && i + n >= failed ? -1 : src.indexOf(mark, i + n);
      if (end > 0) {
        flush();
        let code = src.slice(i + n, end);
        if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out.push({ k: "code", s: code });
        i = end + n;
        continue;
      }
      noCode.set(n, i + n);
      text += mark;
      i += n;
      continue;
    }
    if ((c === "[" || (c === "!" && src.charAt(i + 1) === "[")) && depth < 4) {
      const image = c === "!";
      const open = i + (image ? 1 : 0);
      const close = findClose(src, open);
      if (close > 0 && src.charAt(close + 1) === "(") {
        const end = findParen(src, close + 1);
        if (end > 0) {
          const label = src.slice(open + 1, close);
          const target =
            src
              .slice(close + 2, end)
              .trim()
              .split(/\s+/, 1)[0] ?? "";
          const href = safeHref(target.replace(/^<|>$/g, ""));
          flush();
          const kids = inline(label || target, depth + 1);
          out.push(
            href
              ? { k: "link", href, c: image ? [{ k: "text", s: `${label || "image"} (image)` }] : kids }
              : { k: "text", s: label },
          );
          i = end + 1;
          continue;
        }
      }
    }
    if (c === "<" && (src.startsWith("<http", i) || src.startsWith("<mailto:", i))) {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(src.slice(i, i + 2000));
      if (m) {
        const href = safeHref(m[1] ?? "");
        if (href) {
          flush();
          out.push({ k: "link", href, c: [{ k: "text", s: m[1] ?? href }] });
          i += m[0].length;
          continue;
        }
      }
    }
    if (
      (c === "h" || c === "H") &&
      /^https?:\/\//i.test(src.slice(i, i + 8)) &&
      !isWord(src.charAt(i - 1)) &&
      depth < 4
    ) {
      const m = /^https?:\/\/[^\s<>()[\]]+/i.exec(src.slice(i, i + 2000));
      if (m) {
        let url = m[0];
        while (/[.,;:!?'"*_]$/.test(url)) url = url.slice(0, -1);
        const href = safeHref(url);
        if (href) {
          flush();
          out.push({ k: "link", href, c: [{ k: "text", s: url }] });
          i += url.length;
          continue;
        }
      }
    }
    if ((c === "*" || c === "_" || c === "~") && depth < 6) {
      const run = src.startsWith(c.repeat(2), i) ? 2 : 1;
      const delim = c.repeat(run);
      const k = c === "~" ? (run === 2 ? "del" : undefined) : run === 2 ? "strong" : "em";
      const before = src.charAt(i - 1);
      const after = src.charAt(i + run);
      // `_` only outside a word (snake_case stays as it is); the opener needs a non-space after it.
      const canOpen = k !== undefined && after !== "" && !/\s/.test(after) && !(c === "_" && isWord(before));
      if (canOpen) {
        const failed = noEmphasis.get(delim);
        const end =
          failed !== undefined && i + run >= failed ? -1 : findEmphasisEnd(src, i + run, delim, c === "_");
        if (end > 0) {
          flush();
          out.push({ k: k as "strong" | "em" | "del", c: inline(src.slice(i + run, end), depth + 1) });
          i = end + run;
          continue;
        }
        noEmphasis.set(delim, i + run);
      }
      text += delim;
      i += run;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

/** The `]` closing the `[` at `open`: within a window, and no more than three brackets deep. */
function findClose(src: string, open: number): number {
  let depth = 0;
  const stop = Math.min(src.length, open + WINDOW);
  for (let j = open; j < stop; j++) {
    const ch = src.charAt(j);
    if (ch === "\\") j++;
    else if (ch === "[") {
      if (++depth > 3) return -1;
    } else if (ch === "]" && --depth === 0) return j;
  }
  return -1;
}

/** The `)` closing the `(` at `open`, on the same line, within a window, no more than three deep. */
function findParen(src: string, open: number): number {
  let depth = 0;
  const stop = Math.min(src.length, open + WINDOW);
  for (let j = open; j < stop; j++) {
    const ch = src.charAt(j);
    if (ch === "\\") j++;
    else if (ch === "(") {
      if (++depth > 3) return -1;
    } else if (ch === ")" && --depth === 0) return j;
    else if (ch === "\n") return -1;
  }
  return -1;
}

function findEmphasisEnd(src: string, from: number, delim: string, underscore: boolean): number {
  let j = from;
  while (j < src.length) {
    const at = src.indexOf(delim, j);
    if (at < 0) return -1;
    const prev = src.charAt(at - 1);
    const next = src.charAt(at + delim.length);
    if (at > from && !/\s/.test(prev) && prev !== "\\" && !(underscore && isWord(next))) {
      // A longer run of the same character is not a closer for a shorter delimiter ("**a*" is not "*a*").
      if (delim.length === 1 && next === delim) {
        j = at + 2;
        continue;
      }
      return at;
    }
    j = at + delim.length;
  }
  return -1;
}

// ───────────────────────────── rendering ─────────────────────────────

const renderInline = (nodes: Inline[]): unknown[] =>
  nodes.map((n) => {
    switch (n.k) {
      case "text":
        return n.s;
      case "code":
        return html`<code class="ic">${n.s}</code>`;
      case "strong":
        return html`<strong>${renderInline(n.c)}</strong>`;
      case "em":
        return html`<em>${renderInline(n.c)}</em>`;
      case "del":
        return html`<del>${renderInline(n.c)}</del>`;
      case "br":
        return html`<br />`;
      case "link":
        return html`<a href=${n.href} target="_blank" rel="noopener noreferrer">${renderInline(n.c)}</a>`;
      default:
        return "";
    }
  });

const tokenClass = (t: Token): string | typeof nothing => (t.t ? `tk-${t.t}` : nothing);
const highlighted = new Map<string, TemplateResult>();

/** Highlighted code, cached by language and source (a finished code block is rendered once). */
function codeBody(code: string, lang: string, open: boolean): TemplateResult {
  // While a block is still streaming, highlighting it again for every token would be wasted work.
  if (open || code.length > 40_000) return html`${code}`;
  const key = `${lang}\u0000${code}`;
  const hit = highlighted.get(key);
  if (hit) return hit;
  const tpl = html`${highlight(code, lang).map((t) => (t.t ? html`<span class=${tokenClass(t)}>${t.s}</span>` : t.s))}`;
  highlighted.set(key, tpl);
  if (highlighted.size > 300) {
    const oldest = highlighted.keys().next().value;
    if (oldest !== undefined) highlighted.delete(oldest);
  }
  return tpl;
}

/** Copies text with the clipboard API where there is one. */
async function copyText(text: string, button: HTMLElement | null): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const label = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = label;
      }, 1400);
    }
  } catch {
    // No clipboard permission: the text stays selectable.
  }
}

export function renderBlocks(blocks: Block[]): TemplateResult[] {
  return blocks.map((b): TemplateResult => {
    switch (b.k) {
      case "p":
        return html`<p>${renderInline(b.c)}</p>`;
      case "h": {
        const kids = renderInline(b.c);
        return b.level <= 1
          ? html`<h3 class="md-h">${kids}</h3>`
          : b.level === 2
            ? html`<h4 class="md-h">${kids}</h4>`
            : html`<h5 class="md-h">${kids}</h5>`;
      }
      case "code":
        return html`<div class="code" data-lang=${b.lang || nothing}>
          <div class="code-head"><span class="code-lang">${b.lang || "text"}</span><button type="button" class="copy"
            @click=${(e: Event) => void copyText(b.code, e.currentTarget as HTMLElement)}>Copy</button></div>
          <pre tabindex="0"><code>${codeBody(b.code, b.lang, b.open)}</code></pre>
        </div>`;
      case "ul":
      case "ol": {
        const items = b.items.map(
          (it) =>
            html`<li class=${it.task === undefined ? nothing : "task"}>${
              it.task === undefined
                ? nothing
                : html`<input type="checkbox" disabled .checked=${it.task} aria-label=${it.task ? "Done" : "Not done"} />`
            }<div class="li-body">${renderBlocks(it.c)}</div></li>`,
        );
        return b.k === "ol" ? html`<ol start=${b.start}>${items}</ol>` : html`<ul>${items}</ul>`;
      }
      case "quote":
        return html`<blockquote>${renderBlocks(b.c)}</blockquote>`;
      case "hr":
        return html`<hr />`;
      default:
        return html`<div class="table-wrap"><table>
          <thead><tr>${b.head.map((c, n) => html`<th style=${b.align[n] ? `text-align:${b.align[n]}` : nothing}>${renderInline(c)}</th>`)}</tr></thead>
          <tbody>${b.rows.map((r) => html`<tr>${r.map((c, n) => html`<td style=${b.align[n] ? `text-align:${b.align[n]}` : nothing}>${renderInline(c)}</td>`)}</tr>`)}</tbody>
        </table></div>`;
    }
  });
}

/**
 * Renders one reply incrementally. Call `render(text)` with the growing text: finished chunks come back
 * from the cache, only the last one is parsed again. One cache per message part.
 */
export class MarkdownCache {
  private prevText = "";
  private starts: number[] = [];
  private cache = new Map<string, TemplateResult[]>();
  /** For tests: how many chunks were parsed by the last render. */
  parsed = 0;

  render(text: string): TemplateResult[] {
    // Append-only growth keeps every chunk but the last as it was.
    let starts: number[];
    if (this.prevText && text.startsWith(this.prevText) && this.starts.length > 1) {
      const keep = this.starts.slice(0, -1);
      const resume = this.starts.at(-1) ?? 0;
      starts = [...keep, ...chunkStarts(text, resume)];
    } else starts = chunkStarts(text);
    this.prevText = text;
    this.starts = starts;
    this.parsed = 0;
    const next = new Map<string, TemplateResult[]>();
    const out: TemplateResult[] = [];
    starts.forEach((s, n) => {
      const src = text.slice(s, starts[n + 1] ?? text.length);
      let tpl = next.get(src) ?? this.cache.get(src);
      if (!tpl) {
        tpl = renderBlocks(parseBlocks(src));
        this.parsed++;
      }
      next.set(src, tpl);
      out.push(...tpl);
    });
    this.cache = next;
    return out;
  }
}

/** Renders a whole text in one go (for short strings; a streaming reply uses a `MarkdownCache`). */
export const renderMarkdown = (text: string): TemplateResult[] => new MarkdownCache().render(text);
