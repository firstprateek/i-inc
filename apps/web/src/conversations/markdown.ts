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

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;

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
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && (m[1] ?? "")[0] === fence[0] && (m[1] ?? "").length >= fence.length) {
        fence = undefined;
        // The chunk ends with its closing fence; whatever follows begins a new one.
        inChunk = false;
      }
    } else if (line.trim() === "") {
      inChunk = false;
    } else {
      const m = FENCE.exec(line);
      if (m) {
        // A fence always starts a chunk of its own.
        starts.push(pos);
        fence = m[1] ?? "```";
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

const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const startsBlock = (line: string): boolean =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  HR.test(line) ||
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
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1] ?? "```";
      const body: string[] = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
        if (close && (close[1] ?? "")[0] === mark[0] && (close[1] ?? "").length >= mark.length) {
          closed = true;
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      out.push({ k: "code", lang: fence[2] ?? "", code: body.join("\n"), open: !closed });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push({ k: "h", level: (h[1] ?? "#").length, c: inline(h[2] ?? "") });
      i++;
      continue;
    }
    if (HR.test(line)) {
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
    if (li && depth < 6) {
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
        items.push({ task, c: parseBlocks(body.join("\n"), depth + 1) });
        // A blank line between items keeps the same list going when the next line is another item.
        if ((lines[i] ?? "").trim() === "" && (ordered ? ORDERED : BULLET).test(lines[i + 1] ?? "")) i++;
      }
      out.push({ k: ordered ? "ol" : "ul", start, items });
      continue;
    }
    // A table: a header row, a separator row, then rows.
    if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
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
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !startsBlock(lines[i] ?? "")) {
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

/** Only these can be followed. Anything else (javascript:, data:, file:...) is shown as text. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^#[\w-]*$/.test(h)) return h;
  try {
    const u = new URL(h);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

export function inline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) {
      out.push({ k: "text", s: text });
      text = "";
    }
  };
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
      const end = src.indexOf(mark, i + n);
      if (end > 0) {
        flush();
        let code = src.slice(i + n, end);
        if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out.push({ k: "code", s: code });
        i = end + n;
        continue;
      }
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
              .split(/\s+/)[0] ?? "";
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
    if (c === "<") {
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
      // `_` only inside no word (snake_case stays as it is); the opener needs a non-space after it.
      const canOpen = k !== undefined && after !== "" && !/\s/.test(after) && !(c === "_" && isWord(before));
      if (canOpen) {
        const end = findEmphasisEnd(src, i + run, delim, c === "_");
        if (end > 0) {
          flush();
          out.push({ k: k as "strong" | "em" | "del", c: inline(src.slice(i + run, end), depth + 1) });
          i = end + run;
          continue;
        }
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

function findClose(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const ch = src.charAt(j);
    if (ch === "\\") j++;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return j;
  }
  return -1;
}

/** The `)` closing the `(` at `open`, allowing balanced parentheses inside. */
function findParen(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const ch = src.charAt(j);
    if (ch === "\\") j++;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return j;
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
        return n.href.startsWith("#")
          ? html`<a href=${n.href}>${renderInline(n.c)}</a>`
          : html`<a href=${n.href} target="_blank" rel="noopener noreferrer">${renderInline(n.c)}</a>`;
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
