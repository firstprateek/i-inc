// Checking an agent's edits to its brain copy before anything is committed (docs/design/brain.md,
// "Writing"). The agent may be confused or prompt-injected, so every change is untrusted input. This file is
// the pure half: it gets the raw changes collected from the sandbox (brain-harvest.ts) and the facts it needs
// about the world as plain data and callbacks, and says which changes may be committed (with the text that
// would be) and which are rejected, with a reason an owner can read.
//
// The rules, in the order they apply to a change:
//   1. a link, a special file or an over-size file is never read;
//   2. the path must be a page of a folder of THIS employee's copy: the company handbook, a team they are
//      on, their own brain. Never another employee's brain, never another team's section, and a personal
//      assistant's home data never goes to a shared scope;
//   3. the page name must be a plain lowercase slug (a new page; an old page keeps whatever name it had);
//   4. size caps per page and per harvest, and a cap on deletions;
//   5. credentials are redacted with the shared patterns (`redactProse`), and a page that is mostly secret
//      is refused;
//   6. the frontmatter is repaired (a title, a description, `updated`, `sources`) rather than refused;
//   7. the write bar: a page with nothing in it, an edit that only appends noise, an edit that wipes a page;
//   8. a NEW page that closely matches an existing page of the same scope is not created: the agent is told
//      which page to update.
import {
  clip,
  descriptionLimit,
  firstSentence,
  type PageMeta,
  parsePage,
  type Scope,
  scopeOfDir,
  serializePage,
  titleFromSlug,
  wordCount,
} from "@i-inc/core";
import { redactProse } from "./ahp/sanitize.ts";

// ---- What the sandbox reports --------------------------------------------------------------------------

/** One changed file of the copy, as the harvest script saw it. */
export interface RawChange {
  /** Path in the copy, e.g. `company/facts/signing.md`. */
  path: string;
  status: "A" | "M" | "D";
  /** The baseline text (what the copy was given); null for a new file. */
  base: string | null;
  /** The file's text now; null for a deleted file. */
  text: string | null;
  /** The git blob id of `text` in the copy (the baseline moves to it once the change is dealt with). */
  sha: string | null;
  /** The size of the file now, in bytes. */
  size: number;
  /** The sandbox found something that is not a plain page: a symlink, a special file, a file too big to read. */
  bad?: "link" | "special" | "big";
}

// ---- What the checker is told --------------------------------------------------------------------------

export interface Limits {
  /** A page over this many bytes is refused. Default 64 KB. */
  maxPageBytes: number;
  /** All the pages accepted from one harvest. Default 512 KB. */
  maxHarvestBytes: number;
  /** Changes accepted from one harvest. Default 40. */
  maxChanges: number;
  /** Pages deleted by one harvest. Default 5. */
  maxDeletes: number;
}

export const defaultLimits: Limits = {
  maxPageBytes: 64 * 1024,
  maxHarvestBytes: 512 * 1024,
  maxChanges: 40,
  maxDeletes: 5,
};

/** A page as the shared brain has it now. */
export interface Existing {
  slug: string;
  title: string;
  description: string;
}

export interface CheckContext {
  employeeId: string;
  /** Every employee id: a folder named after one is someone's brain, not a folder of this copy. */
  employeeIds: string[];
  /** The scopes this employee may write: their own brain, their teams' sections, the company handbook. */
  scopes: Scope[];
  /** The employee works on home data (a personal assistant). */
  isHome: boolean;
  /** `main` is the employee's copy; `code` is a personal assistant's second copy for code work (no personal folder). */
  copy: "main" | "code";
  /** `ticket-14` or `conversation-3f2a`: written into `sources`. */
  provenance: string;
  /** YYYY-MM-DD. */
  today: string;
  /** The session read pages that were built from untrusted content. */
  tainted: boolean;
  /**
   * Reasons to doubt where the whole harvest came from: the session handled external content (a GitHub issue,
   * a web fetch), or another employee may have been editing this copy (a shared sandbox). Each is noted on
   * every change, and every page is marked untrusted. Nothing is blocked.
   */
  suspect: string[];
  /** A tidy-up may shrink and delete more than other sessions (it merges and prunes). */
  tidy: boolean;
  limits: Limits;
  /** The pages of a scope as the shared brain has them (for the duplicate check). */
  pagesOf: (scope: Scope) => Existing[];
  /** Slugs the full-text index finds for a title and description in this scope, best first. */
  search: (scope: Scope, title: string, description: string) => string[];
  /** Whether a page exists in the shared brain now (a new page at an old slug is a concurrent create, not a duplicate). */
  exists: (scope: Scope, slug: string) => boolean;
}

export type RejectCode =
  | "link"
  | "special"
  | "path"
  | "scope"
  | "other-brain"
  | "home-data"
  | "reserved"
  | "oversize"
  | "too-many"
  | "secret"
  | "write-bar"
  | "duplicate"
  | "stale";

export interface Rejected {
  path: string;
  status: RawChange["status"];
  scope: Scope | null;
  slug: string | null;
  code: RejectCode;
  /** Why, in words an owner can read. */
  reason: string;
  /** For a duplicate: the page to update instead. */
  mergeInto?: { scope: Scope; slug: string; title: string };
  /** The change is left in the copy for the agent to deal with (a duplicate it is to merge); otherwise it is undone there. */
  keep: boolean;
  /** Nothing to show the owner: a change to a generated map. */
  silent: boolean;
  sha: string | null;
  /** What was proposed (redacted), for the feed's short diff. */
  base: string | null;
  text: string | null;
}

export type Op = "create" | "update" | "delete" | "rename";

export interface Accepted {
  path: string;
  scope: Scope;
  slug: string;
  op: Op;
  /** For a rename, the page it moved from, and its baseline text. */
  from?: { path: string; slug: string; base: string | null };
  /** The page as it would be written (frontmatter repaired, secrets redacted); null for a delete. */
  text: string | null;
  /** The baseline text of the page (for the three-way merge with what the shared brain has now). */
  base: string | null;
  sha: string | null;
  /** The agent's version, redacted, before the frontmatter was repaired: what a conflict keeps beside the shared one. */
  proposed: string | null;
  /** Built from untrusted content. */
  untrusted: boolean;
  /** A company policy page. */
  policy: boolean;
  /** What was repaired or redacted on the way, for the feed. */
  notes: string[];
  /** Nothing to commit: the change leaves the page as it is (only the baseline moves). */
  noop: boolean;
}

export interface CheckResult {
  accepted: Accepted[];
  rejected: Rejected[];
}

// ---- Words ---------------------------------------------------------------------------------------------

const stop = new Set(
  "a an and are as at be by for from how in is it of on or that the their this to we what when with your you about into".split(
    " ",
  ),
);

/** Lowercase words with a crude stem, for comparing titles and descriptions. */
export function words(s: string): string[] {
  const out: string[] = [];
  for (const m of s.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = stem(m[0]);
    if (!stop.has(w)) out.push(w);
  }
  return out;
}

/** The same stem for "signing", "signings" and "signed": plural first, then the verb ending. */
function stem(word: string): string {
  let w = word;
  if (w.length > 4) w = w.replace(/ies$/, "y").replace(/(?<![su])s$/, "");
  if (w.length > 5) w = w.replace(/(?:ing|ed)$/, "");
  return w;
}

/** The share of words two texts have in common (0 to 1). */
export function overlap(a: string, b: string): number {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

export interface Match {
  slug: string;
  title: string;
  why: string;
}

/**
 * The page of a scope that a new page closely matches, if any: the same title, nearly the same title, the
 * same name with a similar title, a similar title with a similar description, or a hit from the full-text
 * index that is similar enough in both.
 */
export function findDuplicate(
  page: { slug: string; title: string; description: string },
  among: Existing[],
  hits: string[],
): Match | null {
  const key = (s: string) => words(s).join(" ");
  const last = (slug: string) => words(slug.replace(/^.*\//, "").replace(/-/g, " ")).join(" ");
  const best: { m: Match | null; score: number } = { m: null, score: -1 };
  const consider = (e: Existing, why: string, score: number) => {
    if (score > best.score) {
      best.m = { slug: e.slug, title: e.title, why };
      best.score = score;
    }
  };
  for (const e of among) {
    if (e.slug === page.slug) continue;
    const t = overlap(page.title, e.title);
    const d = overlap(page.description, e.description);
    // A match needs the title AND the description to agree: "Desktop release" and "Mobile release" share a
    // word and are different pages.
    if (key(page.title) !== "" && key(page.title) === key(e.title) && d >= 0.5)
      consider(e, "has the same title and a similar description", 3 + d);
    else if (t >= 0.8 && d >= 0.4) consider(e, "has almost the same title and a similar description", 2 + t);
    else if (last(page.slug) !== "" && last(page.slug) === last(e.slug) && t >= 0.5 && d >= 0.4)
      consider(e, "has the same name and a similar title and description", 1.5 + t);
    else if (d >= 0.7 && t >= 0.5) consider(e, "has a similar title and description", 1 + d);
    else if (hits.includes(e.slug) && t >= 0.5 && d >= 0.4)
      consider(e, "matches it in search, in title and in description", 0.5 + t);
  }
  return best.m;
}

// ---- Pages ---------------------------------------------------------------------------------------------

const slugSegment = /^[a-z0-9](?:[a-z0-9._-]{0,48}[a-z0-9])?$/;

/** A name a NEW page may have: lowercase segments of letters, digits, dots, dashes and underscores, at most 4 deep. */
export function newSlugOk(slug: string): boolean {
  const parts = slug.split("/");
  return (
    slug.length <= 120 && parts.length <= 4 && parts.every((p) => slugSegment.test(p) && !/^\.+$/.test(p))
  );
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** The share of a text that the credential patterns took out (0 to 1), and how many places they took. */
export function secretShare(text: string): { redacted: string; share: number; count: number } {
  const redacted = redactProse(text);
  const markers = redacted.match(/\[redacted\]|\[private key\]/g)?.length ?? 0;
  if (redacted === text) return { redacted, share: 0, count: 0 };
  const left = redacted.replace(/\[redacted\]|\[private key\]/g, "");
  return { redacted, share: Math.max(0, 1 - left.length / Math.max(1, text.length)), count: markers };
}

const looksExternal = (s: string) => /https?:\/\/|\bgithub\.com\/|\bgit@|\bwww\./i.test(s);

/** A frontmatter key worth keeping: it starts with a letter, a digit or `_`. Not `| title`, `"title"` or ` title`; `last reviewed` is fine. */
const validKey = /^[\p{L}\p{N}_]/u;

export interface Normalized {
  text: string;
  meta: PageMeta;
  body: string;
  notes: string[];
}

/**
 * The page as it will be written: the body untouched except for line endings, and a frontmatter that is
 * valid, has a title and a description, today's `updated` and the provenance in `sources`. Anything the
 * agent wrote wrong in the frontmatter is repaired, not refused.
 */
export function normalizePage(
  text: string,
  slug: string,
  o: {
    today: string;
    provenance: string;
    /** The page is (or must stay) built from untrusted content. */
    external?: boolean;
    /** A page the shared brain already has: keeps what the agent's version lacks. */
    keep?: Pick<PageMeta, "source" | "needsTidy"> | undefined;
  },
): Normalized {
  const parsed = parsePage(text.replace(/\r\n?/g, "\n"), slug);
  const notes: string[] = [];
  if (!parsed.hasFrontmatter) notes.push("added frontmatter");
  else if (parsed.frontmatterError) notes.push("repaired the frontmatter");
  const body = `${parsed.body.replace(/^\n+/, "").trimEnd()}\n`;
  const meta: PageMeta = { ...parsed.meta };
  // Keys that are not keys: a small model copies a `| ` (or a quote) from the example into every frontmatter line,
  // and `| title: Errands` comes out as the key "| title" (Pip, 2026-10-23). They are dropped, not kept as extras.
  if (meta.extra) {
    const junk = Object.keys(meta.extra).filter((k) => !validKey.test(k));
    if (junk.length) {
      const kept = Object.fromEntries(Object.entries(meta.extra).filter(([k]) => validKey.test(k)));
      if (Object.keys(kept).length) meta.extra = kept;
      else delete meta.extra;
      notes.push(
        `dropped ${junk.length} junk frontmatter key${junk.length === 1 ? "" : "s"}: ${junk.map((k) => JSON.stringify(clip(k, 40))).join(", ")}`,
      );
    }
  }
  meta.title = clip(meta.title.replace(/\s+/g, " ").trim(), 120) || titleFromSlug(slug);
  if (parsed.derived.title && parsed.hasFrontmatter && !parsed.frontmatterError) notes.push("added a title");
  meta.description = clip(
    (meta.description || firstSentence(body)).replace(/\s+/g, " ").trim(),
    descriptionLimit,
  );
  if (parsed.derived.description && parsed.hasFrontmatter && !parsed.frontmatterError)
    notes.push("added a description");
  const tags = [...new Set(meta.tags)].filter((t) => /^[a-z0-9][a-z0-9 _.-]{0,31}$/.test(t)).slice(0, 8);
  meta.tags = tags;
  const sources = [...new Set(meta.sources)].filter((s) => s.length <= 160 && !/[\n\r]/.test(s)).slice(0, 20);
  if (!sources.includes(o.provenance)) sources.push(o.provenance);
  meta.sources = sources;
  meta.updated = o.today;
  // External is sticky: a page that was built from untrusted content stays marked, whatever the agent
  // wrote, and so does a page the agent marks itself.
  if (o.external || o.keep?.source === "external" || parsed.meta.source === "external")
    meta.source = "external";
  else delete meta.source;
  if (o.keep?.needsTidy && meta.needsTidy === undefined) meta.needsTidy = true;
  // Keys this module doesn't model: a few small ones are kept, anything big or nested is dropped.
  if (meta.extra) {
    const keep: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta.extra).slice(0, 8)) {
      if (JSON.stringify(v ?? null).length <= 300) keep[k] = v;
    }
    if (Object.keys(keep).length) meta.extra = keep;
    else delete meta.extra;
  }
  return { text: serializePage({ meta, body }), meta, body, notes };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Log-like lines an agent appends to a page as it goes: "2026-10-21: worked on ticket 14". */
const logLine =
  /^(?:[-*]\s*)?(?:\d{4}-\d{2}-\d{2}|ticket[- ]?#?\d+|#\d+|session|today|just now|worked on|did |done|updated|fixed|added|tried|note:?)\b/i;

/** Why an edit that only appends to a page adds nothing worth keeping, or null when it adds something. */
export function appendedNoise(base: string, next: string): string | null {
  const before = base.trimEnd();
  const after = next.trimEnd();
  if (!after.startsWith(before) || after.length === before.length) return null;
  const added = after.slice(before.length).trim();
  const lines = added
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (wordCount(added) < 5)
    return `it only appends ${wordCount(added)} word${wordCount(added) === 1 ? "" : "s"}`;
  const old = new Set(
    before
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  if (lines.every((l) => old.has(l))) return "it only repeats lines the page already has";
  if (lines.every((l) => logLine.test(l)))
    return "it only appends log lines about this session, which are not a lesson";
  return null;
}

/** The scope and slug a path of the copy names (`company/facts/x.md`), or null when it names no page. */
function locate(path: string, employeeId: string): { scope: Scope; slug: string } | null {
  const slash = path.indexOf("/");
  if (slash < 1 || !path.endsWith(".md")) return null;
  const scope = scopeOfDir(path.slice(0, slash), employeeId);
  const slug = path.slice(slash + 1, -3);
  return scope && slug ? { scope, slug } : null;
}

/**
 * A page as the feed's diff shows it: its title and description, then its body. The rest of the frontmatter
 * (`updated`, `sources`, tags) changes with every edit and says nothing about what was written.
 */
export function forDiff(text: string | null, slug = ""): string | null {
  if (text === null) return null;
  const p = parsePage(text, slug);
  return `title: ${p.meta.title}\ndescription: ${p.meta.description}\n${p.body.replace(/^\n+/, "")}`;
}

/** A few lines of what changed, for the feed: removed lines with `-`, added with `+`, with a little context. */
export function lineDiff(before: string | null, after: string | null, maxLines = 24): string {
  const lines = (t: string | null) => (t === null || t === "" ? [] : t.replace(/\n$/, "").split("\n"));
  const a = lines(before);
  const b = lines(after);
  if (a.length > 1500 || b.length > 1500) {
    return `${before === null ? "new file" : after === null ? "deleted" : "changed"}: ${a.length} → ${b.length} lines`;
  }
  // The classic longest-common-subsequence walk, fine for pages of this size.
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      (dp[i] as number[])[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((dp[i + 1] as number[])[j] as number, (dp[i] as number[])[j + 1] as number);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (
      j < n &&
      (i === m || ((dp[i] as number[])[j + 1] as number) >= ((dp[i + 1] as number[])[j] as number))
    ) {
      out.push(`+${b[j]}`);
      j++;
    } else {
      out.push(`-${a[i]}`);
      i++;
    }
  }
  // Keep the changed lines with one line of context either side.
  const shown: string[] = [];
  let gap = false;
  out.forEach((l, k) => {
    const changed = l[0] !== " ";
    const ctx = (out[k - 1] ?? " ")[0] !== " " || (out[k + 1] ?? " ")[0] !== " ";
    if (changed || ctx) {
      if (gap && shown.length) shown.push("…");
      shown.push(l);
      gap = false;
    } else gap = true;
  });
  const cut =
    shown.length > maxLines
      ? [...shown.slice(0, maxLines), `… ${shown.length - maxLines} more lines`]
      : shown;
  return cut.join("\n").slice(0, 4000);
}

// ---- The check -----------------------------------------------------------------------------------------

/** A new page whose body is these few words is not a page. */
const thinWords = 6;

function reject(c: RawChange, code: RejectCode, reason: string, extra: Partial<Rejected> = {}): Rejected {
  const text = c.text === null ? null : redactProse(c.text).slice(0, 8000);
  return {
    path: c.path,
    status: c.status,
    scope: null,
    slug: null,
    code,
    reason,
    keep: false,
    silent: false,
    sha: c.sha,
    base: c.base === null ? null : redactProse(c.base).slice(0, 8000),
    text,
    ...extra,
  };
}

/** Checks every change of one harvest. Deterministic: changes are taken in path order. */
export function checkHarvest(changes: RawChange[], ctx: CheckContext): CheckResult {
  const accepted: Accepted[] = [];
  const rejected: Rejected[] = [];
  const sorted = [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lim = ctx.limits;
  let total = 0;
  let deletes = 0;

  // The pages this harvest deletes, by scope: a page it moves is not a duplicate of the old one.
  const deleting = new Map<Scope, Set<string>>();
  for (const c of sorted) {
    if (c.status !== "D") continue;
    const at = locate(c.path, ctx.employeeId);
    if (!at) continue;
    const set = deleting.get(at.scope) ?? new Set<string>();
    set.add(at.slug);
    deleting.set(at.scope, set);
  }
  const added = new Map<Scope, Existing[]>();

  for (const c of sorted) {
    // 1. What the sandbox could not read as a plain page.
    if (c.bad === "link") {
      rejected.push(reject(c, "link", "a symlink is not a page"));
      continue;
    }
    if (c.bad === "special") {
      rejected.push(reject(c, "special", "not a plain file"));
      continue;
    }
    if (c.bad === "big") {
      rejected.push(
        reject(
          c,
          "oversize",
          `the file is ${Math.round(c.size / 1024)} KB, over the ${Math.round(lim.maxPageBytes / 1024)} KB a page may have`,
        ),
      );
      continue;
    }

    // 2. Where it is.
    const slash = c.path.indexOf("/");
    const dir = slash === -1 ? "" : c.path.slice(0, slash);
    const rest = slash === -1 ? c.path : c.path.slice(slash + 1);
    const generated = /(^|\/)INDEX\.md$/i.test(c.path) && slash !== -1 && !rest.includes("/");
    if (generated) {
      rejected.push(
        reject(c, "reserved", "the INDEX.md maps are generated from the pages", { silent: true }),
      );
      continue;
    }
    if (
      slash === -1 ||
      !c.path.endsWith(".md") ||
      c.path.length > 200 ||
      c.path.split("/").some((s) => !s || s === "." || s === ".." || s.startsWith(".")) ||
      /[\p{Cc}\\]/u.test(c.path)
    ) {
      rejected.push(
        reject(
          c,
          "path",
          "that is not the path of a page: pages are markdown files in the folders of your copy",
        ),
      );
      continue;
    }
    const scope = scopeOfDir(dir, ctx.employeeId);
    const otherBrain =
      dir !== "personal" &&
      (ctx.employeeIds.includes(dir) || /^(?:personal|brain)[-_:]/.test(dir) || /^brain$/.test(dir));
    if (!scope || otherBrain) {
      rejected.push(
        otherBrain || scope?.startsWith("brain:")
          ? reject(
              c,
              "other-brain",
              "that is not your own brain: you may only write your own personal brain, your team's section and the company handbook",
            )
          : reject(
              c,
              "scope",
              `${dir}/ is not a folder you may write: your own personal/, your team's folder and company/`,
            ),
      );
      continue;
    }
    const slug = rest.slice(0, -3);
    if (!ctx.scopes.includes(scope)) {
      rejected.push(
        reject(
          c,
          scope.startsWith("brain:") ? "other-brain" : "scope",
          scope.startsWith("brain:")
            ? "that is not your own brain"
            : `you are not on the team ${scope.slice(5)}, so you may not write its section`,
          { scope, slug },
        ),
      );
      continue;
    }
    // A PA's own brain is home data: it is written from the home copy only, and no shared scope is, from there.
    if (ctx.isHome) {
      const own = scope === `brain:${ctx.employeeId}`;
      if (ctx.copy === "main" && !own) {
        rejected.push(
          reject(
            c,
            "home-data",
            "a personal assistant works with home data, which never goes to a shared scope: only its own brain is written from here",
            { scope, slug },
          ),
        );
        continue;
      }
      if (ctx.copy === "code" && own) {
        rejected.push(
          reject(
            c,
            "home-data",
            "a personal assistant's own brain is home data and is not written from a code session",
            { scope, slug },
          ),
        );
        continue;
      }
    }
    if (scope === "company" && (slug === "teams" || slug.startsWith("teams/"))) {
      rejected.push(
        reject(
          c,
          "reserved",
          "company pages may not live under teams/: that is where the teams' sections are",
          { scope, slug },
        ),
      );
      continue;
    }
    if (scope.startsWith("brain:") && /^personality(?:\.md)?$/i.test(slug)) {
      rejected.push(
        reject(c, "reserved", "the personality page is the owner's: it holds the role instructions", {
          scope,
          slug,
        }),
      );
      continue;
    }
    if (c.status === "A" && !newSlugOk(slug)) {
      rejected.push(
        reject(
          c,
          "path",
          "a new page needs a plain lowercase name made of letters, digits and dashes, at most four folders deep",
          { scope, slug },
        ),
      );
      continue;
    }

    // 4. Caps.
    if (accepted.length >= lim.maxChanges) {
      rejected.push(
        reject(
          c,
          "too-many",
          `a harvest takes at most ${lim.maxChanges} changes; this one is left for the next`,
          { scope, slug, keep: true },
        ),
      );
      continue;
    }
    const policy = scope === "company" && (slug === "policies" || slug.startsWith("policies/"));

    if (c.status === "D") {
      if (deletes >= lim.maxDeletes) {
        rejected.push(
          reject(c, "too-many", `a harvest deletes at most ${lim.maxDeletes} pages at a time`, {
            scope,
            slug,
            keep: true,
          }),
        );
        continue;
      }
      deletes++;
      accepted.push({
        path: c.path,
        scope,
        slug,
        op: "delete",
        text: null,
        base: c.base,
        sha: null,
        proposed: null,
        untrusted: ctx.suspect.length > 0,
        policy,
        notes: [...ctx.suspect],
        noop: false,
      });
      continue;
    }

    // A or M: the text.
    const raw = c.text ?? "";
    if (raw.includes("\0")) {
      rejected.push(reject(c, "path", "the file is not text", { scope, slug }));
      continue;
    }
    const size = bytes(raw);
    if (size > lim.maxPageBytes) {
      rejected.push(
        reject(
          c,
          "oversize",
          `the page is ${Math.round(size / 1024)} KB, over the ${Math.round(lim.maxPageBytes / 1024)} KB a page may have`,
          { scope, slug },
        ),
      );
      continue;
    }
    if (total + size > lim.maxHarvestBytes) {
      rejected.push(
        reject(
          c,
          "oversize",
          `this harvest is over ${Math.round(lim.maxHarvestBytes / 1024)} KB; the rest is left for the next`,
          { scope, slug, keep: true },
        ),
      );
      continue;
    }

    // 5. Credentials.
    const secrets = secretShare(raw);
    if (secrets.share > 0.5) {
      rejected.push(
        reject(c, "secret", "the page is mostly credentials, so it was not kept", {
          scope,
          slug,
          keep: false,
        }),
      );
      continue;
    }
    const notes: string[] = [...ctx.suspect];
    if (secrets.count) notes.push(`redacted ${secrets.count} credential${secrets.count === 1 ? "" : "s"}`);

    // 6. Frontmatter, and untrusted marking.
    const first = parsePage(secrets.redacted, slug);
    const external =
      ctx.suspect.length > 0 ||
      first.meta.source === "external" ||
      first.meta.sources.some((s) => looksExternal(s)) ||
      (ctx.tainted && looksExternal(addedText(c.base, secrets.redacted)));
    const n = normalizePage(secrets.redacted, slug, {
      today: ctx.today,
      provenance: ctx.provenance,
      external,
    });
    notes.push(...n.notes);

    // 7. The write bar.
    const bodyWords = wordCount(n.body);
    if (bodyWords < thinWords) {
      rejected.push(
        reject(
          c,
          "write-bar",
          `the page has ${bodyWords === 0 ? "no text" : `only ${bodyWords} word${bodyWords === 1 ? "" : "s"}`}: a page needs something durable, non-obvious and reusable`,
          { scope, slug },
        ),
      );
      continue;
    }
    let noop = false;
    if (c.status === "M" && c.base !== null) {
      const before = parsePage(c.base, slug);
      if (squash(before.body) === squash(n.body)) {
        // Only the frontmatter moved (or nothing): not worth a commit, and not a write either.
        const same =
          before.meta.title === n.meta.title &&
          before.meta.description === n.meta.description &&
          before.meta.tags.join(",") === n.meta.tags.join(",");
        if (same) noop = true;
      } else {
        const noise = appendedNoise(before.body, n.body);
        if (noise) {
          rejected.push(
            reject(c, "write-bar", `${noise}: rewrite the page instead of adding to it`, { scope, slug }),
          );
          continue;
        }
        const was = wordCount(before.body);
        if (!ctx.tidy && was >= 80 && bodyWords < was * 0.15) {
          rejected.push(
            reject(
              c,
              "write-bar",
              `it would erase most of the page (${was} words down to ${bodyWords}): delete the page, or merge it into another`,
              { scope, slug },
            ),
          );
          continue;
        }
      }
    }

    // 8. Duplicates (new pages only).
    if (c.status === "A" && !noop) {
      const exclude = deleting.get(scope) ?? new Set<string>();
      const among = [...ctx.pagesOf(scope).filter((e) => !exclude.has(e.slug)), ...(added.get(scope) ?? [])];
      // A new page at a slug the shared brain already has is a concurrent create, merged later; not a duplicate.
      const hit = ctx.exists(scope, slug)
        ? null
        : findDuplicate(
            { slug, title: n.meta.title, description: n.meta.description },
            among,
            ctx.search(scope, n.meta.title, n.meta.description).filter((s) => !exclude.has(s)),
          );
      if (hit) {
        rejected.push(
          reject(
            c,
            "duplicate",
            `it ${hit.why} as [[${hit.slug}]] ("${hit.title}"): update that page instead of creating this one`,
            { scope, slug, mergeInto: { scope, slug: hit.slug, title: hit.title }, keep: true },
          ),
        );
        continue;
      }
      const list = added.get(scope) ?? [];
      list.push({ slug, title: n.meta.title, description: n.meta.description });
      added.set(scope, list);
    }

    total += size;
    accepted.push({
      path: c.path,
      scope,
      slug,
      op: c.status === "A" ? "create" : "update",
      text: n.text,
      base: c.base,
      sha: c.sha,
      proposed: secrets.redacted,
      untrusted: n.meta.source === "external",
      policy,
      notes,
      noop,
    });
  }

  // A page that went away and a page that came with the same words is a rename.
  const gone = accepted.filter((a) => a.op === "delete");
  for (const a of accepted.filter((x) => x.op === "create")) {
    const twin = gone.find(
      (g) =>
        g.scope === a.scope &&
        g.base !== null &&
        a.text !== null &&
        (squash(parsePage(g.base, g.slug).body) === squash(parsePage(a.text, a.slug).body) ||
          (overlap(parsePage(g.base, g.slug).meta.title, parsePage(a.text, a.slug).meta.title) >= 0.8 &&
            overlap(parsePage(g.base, g.slug).body, parsePage(a.text, a.slug).body) >= 0.8)),
    );
    if (!twin) continue;
    a.op = "rename";
    a.from = { path: twin.path, slug: twin.slug, base: twin.base };
    accepted.splice(accepted.indexOf(twin), 1);
    gone.splice(gone.indexOf(twin), 1);
  }
  return { accepted, rejected };
}

/** What an edit added to a page: the whole text for a new page, else what comes after the old text (or all of it). */
function addedText(base: string | null, next: string): string {
  if (base === null) return next;
  const before = base.trimEnd();
  return next.startsWith(before) ? next.slice(before.length) : next;
}
