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
//
// The frontmatter is real YAML (the `yaml` package, core schema), so block scalars, nested maps and
// quoted values survive. Keys we don't model are kept as parsed, with their case, and written back.
import YAML from "yaml";

/** A frontmatter value we don't model (any YAML), kept so a rewrite never drops what an agent wrote. */
export type FrontValue = unknown;

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
  /** Frontmatter keys this module doesn't know, in order, with their original case. */
  extra?: Record<string, FrontValue>;
}

export interface ParsedPage {
  meta: PageMeta;
  /** The text after the frontmatter, untouched. */
  body: string;
  /** Whether the file had a frontmatter block at all. */
  hasFrontmatter: boolean;
  /** Set when the frontmatter block is not valid YAML; its plain `key: value` lines are still read. */
  frontmatterError?: string;
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

const asList = (v: unknown): string[] => {
  if (v === undefined || v === null) return [];
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [v];
  return items
    .filter((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean")
    .map((x) => String(x).trim())
    .filter(Boolean);
};
const asString = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
const truthy = (v: unknown): boolean => v === true || /^(true|yes|1)$/i.test(asString(v).trim());
const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

const known = new Set(["title", "description", "tags", "updated", "sources", "source", "needs-tidy"]);

/**
 * What a hand-written block means when it isn't valid YAML (an unquoted `title: A: B` is the usual
 * slip): top-level `key: value` lines as strings, `[a, b]` and `- item` lists as lists.
 */
function lenientFront(raw: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let list: string[] | null = null;
  const unq = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");
  for (const line of raw) {
    const item = list ? line.match(/^\s*-\s+(.*)$/) : null;
    if (item) {
      list?.push(unq(item[1] ?? ""));
      continue;
    }
    const kv = line.match(/^([^\s:#-][^:]*):(?:\s+(.*))?$/);
    if (!kv) continue;
    const key = (kv[1] ?? "").trim();
    const val = (kv[2] ?? "").trim();
    list = null;
    if (val === "") out[key] = list = [];
    else if (val.startsWith("[") && val.endsWith("]")) {
      out[key] = val.slice(1, -1).split(",").map(unq).filter(Boolean);
    } else out[key] = unq(val);
  }
  return out;
}

/** The frontmatter as a plain object, or an error. Anything but a mapping is an error. */
function readFront(raw: string[]): { front: Record<string, unknown> } | { error: string } {
  try {
    const doc = YAML.parseDocument(raw.join("\n"), { uniqueKeys: false });
    if (doc.errors.length) return { error: doc.errors[0]?.message ?? "invalid YAML" };
    const v = doc.toJS({ maxAliasCount: 10 }) as unknown;
    if (v === null || v === undefined) return { front: {} };
    if (typeof v !== "object" || Array.isArray(v)) return { error: "frontmatter must be a mapping" };
    return { front: v as Record<string, unknown> };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

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
  const target = raw.split(/[|#]/)[0] ?? "";
  return target
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
  const read = split ? readFront(split.raw) : { front: {} };
  const front = "front" in read ? read.front : lenientFront(split?.raw ?? []);

  const writtenTitle = asString(front.title).trim();
  const writtenDesc = asString(front.description).trim();
  const title = writtenTitle || firstHeading(body) || titleFromSlug(slug || "untitled");
  const description = writtenDesc
    ? clip(writtenDesc.replace(/\s+/g, " "), descriptionLimit)
    : firstSentence(body);

  const updatedRaw = asString(front.updated).trim();
  const extra: Record<string, FrontValue> = {};
  for (const [k, v] of Object.entries(front)) if (!known.has(k)) extra[k] = v;

  const meta: PageMeta = {
    title,
    description,
    tags: asList(front.tags).map((t) => t.toLowerCase()),
    sources: asList(front.sources),
  };
  if (isDate(updatedRaw)) meta.updated = updatedRaw;
  if (asString(front.source).trim() === "external") meta.source = "external";
  if (truthy(front["needs-tidy"])) meta.needsTidy = true;
  if (Object.keys(extra).length) meta.extra = extra;

  return {
    meta,
    body,
    hasFrontmatter: split !== null,
    ...("error" in read ? { frontmatterError: read.error } : {}),
    derived: { title: !writtenTitle, description: !writtenDesc },
    links: extractLinks(body),
  };
}

/** Frontmatter, then the body. Re-parsing the result gives the same meta and body. */
export function serializePage(p: { meta: PageMeta; body: string }): string {
  const m = p.meta;
  const front: Record<string, unknown> = {
    title: m.title,
    description: clip(m.description, descriptionLimit),
    tags: m.tags,
  };
  if (m.updated) front.updated = m.updated;
  front.sources = m.sources;
  if (m.source) front.source = m.source;
  if (m.needsTidy) front["needs-tidy"] = true;
  for (const [k, v] of Object.entries(m.extra ?? {})) if (!(k in front)) front[k] = v;
  const doc = new YAML.Document(front);
  // tags and sources read best on one line: tags: [a, b]
  for (const k of ["tags", "sources"]) {
    const node = doc.get(k, true);
    if (YAML.isSeq(node)) node.flow = true;
  }
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return `---\n${yaml}---\n${p.body}`;
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
