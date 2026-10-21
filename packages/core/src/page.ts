// The brain's page format (docs/design/brain.md, "Page format"): markdown with a small YAML
// frontmatter, [[slug]] links in the body. Pure, and tolerant: pages written before frontmatter
// existed (a heading and appended paragraphs) parse too, with a title and description derived.
//
//   ---
//   title: Duet release process
//   description: How Duet cuts a release, and the signing step only the owner can do
//   tags: [duet, releases]
//   updated: 2026-10-20
//   sources: [ticket-14]
//   ---
//   Body. Link related pages as [[slug]].

/** A frontmatter value we don't model, kept so a rewrite never drops what an agent wrote. */
export type FrontValue = string | boolean | number | string[];

export interface PageMeta {
  title: string;
  /** The one line the map shows: "what would make me open this page?". At most 160 characters. */
  description: string;
  tags: string[];
  /** YYYY-MM-DD; absent when the page has never been stamped. */
  updated?: string;
  /** Where it came from: ticket and conversation ids, or URLs. */
  sources: string[];
  /** Set when the page was built from untrusted content (web pages, issues, other people's repos). */
  source?: "external";
  /** A pile of appended fragments that the tidy-up should merge into one page. */
  needsTidy?: boolean;
  /** Frontmatter keys this module doesn't know, in order. */
  extra?: Record<string, FrontValue>;
}

export interface ParsedPage {
  meta: PageMeta;
  /** The text after the frontmatter, untouched. */
  body: string;
  /** Whether the file had a frontmatter block at all. */
  hasFrontmatter: boolean;
  /** Which of title/description were derived rather than written. */
  derived: { title: boolean; description: boolean };
  /** Normalized link targets from the body, in order, without duplicates. */
  links: string[];
}

export const descriptionLimit = 160;

const fence = /^---[ \t]*$/;

/** Splits "---\n…\n---\n" off the front. Returns null when the text has no such block. */
function splitFrontmatter(text: string): { raw: string[]; body: string } | null {
  const src = text.replace(/^\uFEFF/, "");
  const lines = src.split("\n");
  if (!fence.test((lines[0] ?? "").replace(/\r$/, ""))) return null;
  for (let i = 1; i < lines.length; i++) {
    if (fence.test((lines[i] ?? "").replace(/\r$/, ""))) {
      return { raw: lines.slice(1, i).map((l) => l.replace(/\r$/, "")), body: lines.slice(i + 1).join("\n") };
    }
  }
  return null;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t
      .slice(1, -1)
      .replace(/\\(["\\nt])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Splits "a, b, "c, d"" on commas that aren't inside quotes. */
function splitList(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map(unquote).filter(Boolean);
}

type Raw = string | string[];

/** The tolerant YAML subset we write: `key: scalar`, `key: [a, b]`, and `key:` + `- item` lines. */
function readFront(lines: string[]): Map<string, Raw> {
  const out = new Map<string, Raw>();
  let list: string[] | null = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s*(.*)$/) ?? (list ? line.match(/^-\s*(.*)$/) : null);
    if (item && list) {
      list.push(unquote(item[1] ?? ""));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) {
      list = null;
      continue;
    }
    const key = (kv[1] ?? "").toLowerCase();
    const value = (kv[2] ?? "").trim();
    if (value === "") {
      list = [];
      out.set(key, list);
    } else if (value.startsWith("[") && value.endsWith("]")) {
      list = null;
      out.set(key, splitList(value.slice(1, -1)));
    } else {
      list = null;
      out.set(key, unquote(value));
    }
  }
  return out;
}

const asList = (v: Raw | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v.filter(Boolean) : v ? splitList(v) : [];
const asString = (v: Raw | undefined): string => (v === undefined ? "" : Array.isArray(v) ? v.join(", ") : v);
const truthy = (v: Raw | undefined): boolean => /^(true|yes|1)$/i.test(asString(v).trim());
const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

const known = new Set(["title", "description", "tags", "updated", "sources", "source", "needs-tidy"]);

/** "tools/vitest-mocks" → "Vitest mocks". */
export function titleFromSlug(slug: string): string {
  const t = slug.replace(/^.*\//, "").replace(/\.md$/, "").replace(/[-_]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The first `# heading` of a body, if it has one. */
export function firstHeading(body: string): string | null {
  for (const line of body.split("\n")) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function stripMarkdown(s: string): string {
  return s
    .replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first sentence of the body (skipping headings, rules and code), at most 160 characters. */
export function firstSentence(body: string, limit = descriptionLimit): string {
  const paragraphs = body
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split("\n")
        .filter((l) => l.trim() && !/^\s*#{1,6}\s/.test(l) && !/^\s*([-*_]\s*){3,}$/.test(l))
        .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^\s*>\s?/, ""))
        .join(" "),
    )
    .map(stripMarkdown)
    .filter(Boolean);
  const first = paragraphs[0] ?? "";
  const m = first.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = m?.[1] ?? first;
  return clip(sentence, limit);
}

/** Cuts to the limit on a word boundary, with an ellipsis when it had to cut. */
export function clip(s: string, limit: number): string {
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Normalizes a link target: "[[Tools/Vitest Mocks.md|mocks]]" → "tools/vitest-mocks". */
export function normalizeSlug(raw: string): string {
  return raw
    .split(/[|#]/)[0]!
    .trim()
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/\s+/g, "-")
    .replace(/^\/+|\/+$/g, "");
}

/** The `[[slug]]` targets in a body, normalized, in order, without duplicates. Code is ignored. */
export function extractLinks(body: string): string[] {
  const plain = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const seen = new Set<string>();
  const re = /\[\[([^\]\n]{1,200})\]\]/g;
  for (let m = re.exec(plain); m; m = re.exec(plain)) {
    const slug = normalizeSlug(m[1] ?? "");
    if (slug && !slug.includes("..")) seen.add(slug);
  }
  return [...seen];
}

/** Parses a page. `slug` (e.g. "tools/vitest-mocks") is only used to derive a missing title. */
export function parsePage(text: string, slug = ""): ParsedPage {
  const split = splitFrontmatter(text);
  const body = split ? split.body : text.replace(/^\uFEFF/, "");
  const front = split ? readFront(split.raw) : new Map<string, Raw>();

  const writtenTitle = asString(front.get("title")).trim();
  const writtenDesc = asString(front.get("description")).trim();
  const title = writtenTitle || firstHeading(body) || titleFromSlug(slug || "untitled");
  const description = writtenDesc
    ? clip(writtenDesc.replace(/\s+/g, " "), descriptionLimit)
    : firstSentence(body);

  const updatedRaw = asString(front.get("updated")).trim();
  const extra: Record<string, FrontValue> = {};
  for (const [k, v] of front) if (!known.has(k)) extra[k] = v;

  const meta: PageMeta = {
    title,
    description,
    tags: asList(front.get("tags")).map((t) => t.toLowerCase()),
    sources: asList(front.get("sources")),
  };
  if (isDate(updatedRaw)) meta.updated = updatedRaw;
  if (asString(front.get("source")).trim() === "external") meta.source = "external";
  if (truthy(front.get("needs-tidy"))) meta.needsTidy = true;
  if (Object.keys(extra).length) meta.extra = extra;

  return {
    meta,
    body,
    hasFrontmatter: split !== null,
    derived: { title: !writtenTitle, description: !writtenDesc },
    links: extractLinks(body),
  };
}

const bare = /^[A-Za-z0-9][A-Za-z0-9 ._/()'-]*$/;

function scalar(s: string): string {
  const one = s.replace(/\s*\n\s*/g, " ");
  return bare.test(one) &&
    !/[:#]/.test(one) &&
    !/^(true|false|null|yes|no|\d+)$/i.test(one) &&
    one === one.trim()
    ? one
    : `"${one.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const list = (a: string[]): string => `[${a.map(scalar).join(", ")}]`;

/** Frontmatter, then the body. Re-parsing the result gives the same meta and body. */
export function serializePage(p: { meta: PageMeta; body: string }): string {
  const m = p.meta;
  const lines = [
    `title: ${scalar(m.title)}`,
    `description: ${scalar(clip(m.description, descriptionLimit))}`,
  ];
  lines.push(`tags: ${list(m.tags)}`);
  if (m.updated) lines.push(`updated: ${m.updated}`);
  lines.push(`sources: ${list(m.sources)}`);
  if (m.source) lines.push(`source: ${m.source}`);
  if (m.needsTidy) lines.push("needs-tidy: true");
  for (const [k, v] of Object.entries(m.extra ?? {})) {
    lines.push(`${k}: ${Array.isArray(v) ? list(v) : typeof v === "string" ? scalar(v) : String(v)}`);
  }
  return `---\n${lines.join("\n")}\n---\n${p.body}`;
}

/** Today as YYYY-MM-DD in UTC, for stamping `updated`. */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Roughly how many words a body has. */
export function wordCount(body: string): number {
  const m = body.match(/[\p{L}\p{N}]+/gu);
  return m ? m.length : 0;
}
