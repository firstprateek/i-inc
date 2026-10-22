// What the daily "Tend the brain" ticket is given to look at (docs/design/brain.md, "Tending"): the pages the
// index can show to be duplicates, contradictions waiting in `## Conflict` sections, links that lead nowhere,
// pages nobody has opened for 60 days and nothing links to, and the size of each map. The librarian reads
// this report in its brief and edits its brain copy; the harvest checks and commits what it changes.
import { buildMap, mapLineLimit, type Scope, scopeDir, snapshotPath } from "@i-inc/core";
import { findDuplicate } from "./brain-check.ts";
import type { BrainIndex, IndexedPage } from "./brain-index.ts";

export const unusedDays = 60;
const day = 86_400_000;

export interface PageRef {
  scope: Scope;
  slug: string;
  title: string;
}

export interface TidyReport {
  /** Unused for `unusedDays` and linked from nowhere: candidates to delete. */
  unused: (PageRef & { lastUsedAt: number | null; updated: string | null })[];
  broken: { from: PageRef; link: string }[];
  /** Pages with a conflict kept for resolving (`needs-tidy`). */
  conflicts: PageRef[];
  duplicates: { a: PageRef; b: PageRef; why: string }[];
  maps: { scope: Scope; pages: number; lines: number; limit: number }[];
}

const ref = (p: IndexedPage): PageRef => ({ scope: p.scope, slug: p.slug, title: p.title });

/** Pages that are never pruned: the company's rules and its projects, and a person's personality. */
const keepAlways = (p: IndexedPage): boolean =>
  (p.scope === "company" && (p.slug.startsWith("policies/") || p.slug.startsWith("projects/"))) ||
  (p.scope.startsWith("brain:") && p.slug === "personality");

/**
 * The report for the scopes an employee may write. `trackedSince` is when page use began to be counted
 * (a page can only be called unused after a full `unusedDays` of watching).
 */
export function tidyReport(
  index: BrainIndex,
  scopes: Scope[],
  now: number,
  trackedSince: number,
): TidyReport {
  const pages = index.pages(scopes);
  const cutoff = now - unusedDays * day;
  const watched = trackedSince <= cutoff;

  // Who links to whom, resolved the way a reader does (own scope first).
  const inbound = new Set<string>();
  const broken: TidyReport["broken"] = [];
  const byKey = new Map(pages.map((p) => [`${p.scope}\0${p.slug}`, p]));
  for (const l of index.allLinks(scopes)) {
    const from = byKey.get(`${l.scope}\0${l.slug}`);
    const hit = index.resolveLink(l.to, [l.scope, ...scopes.filter((s) => s !== l.scope)]);
    if (!hit) {
      if (from && broken.length < 40) broken.push({ from: ref(from), link: l.to });
    } else if (!(hit.scope === l.scope && hit.slug === l.slug)) {
      inbound.add(`${hit.scope}\0${hit.slug}`);
    }
  }

  const unused = pages
    .filter((p) => {
      if (!watched || keepAlways(p) || inbound.has(`${p.scope}\0${p.slug}`)) return false;
      const used = p.lastUsedAt ?? 0;
      const written = p.updated ? Date.parse(`${p.updated}T00:00:00Z`) : 0;
      return used < cutoff && written < cutoff;
    })
    .slice(0, 40)
    .map((p) => ({ ...ref(p), lastUsedAt: p.lastUsedAt, updated: p.updated }));

  const duplicates: TidyReport["duplicates"] = [];
  for (const scope of scopes) {
    const here = pages.filter((p) => p.scope === scope).slice(0, 300);
    const seen = new Set<string>();
    for (const p of here) {
      const others = here.filter((o) => o.slug !== p.slug);
      const hit = findDuplicate(
        { slug: p.slug, title: p.title, description: p.description },
        others.map((o) => ({ slug: o.slug, title: o.title, description: o.description })),
        [],
      );
      if (!hit) continue;
      const key = [p.slug, hit.slug].sort().join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      duplicates.push({ a: ref(p), b: { scope, slug: hit.slug, title: hit.title }, why: hit.why });
      if (duplicates.length >= 30) break;
    }
  }

  const maps = scopes.map((scope) => {
    const mine = pages.filter((p) => p.scope === scope);
    const lines = buildMap(
      mine.map((p) => ({ slug: p.slug, title: p.title, description: p.description })),
      1_000_000,
    ).root.length;
    return { scope, pages: mine.length, lines, limit: mapLineLimit };
  });

  return {
    unused,
    broken,
    conflicts: pages.filter((p) => p.needsTidy).map(ref),
    duplicates,
    maps,
  };
}

const clean = (s: string) =>
  s.replace(/<\s*(\/?)\s*(brain-page|brain|tidy)\b/gi, "<\\$1$2").replace(/\s+/g, " ");

/** The report as the text at the end of the tidy-up's brief. Page names are the files of the agent's copy. */
export function renderTidyReport(r: TidyReport, employeeId: string, home?: string): string {
  const file = (p: PageRef) => {
    const rel = snapshotPath(p.scope, p.slug);
    return rel
      ? `${home ?? "/home/employee/brain"}/${employeeId}/${rel}`
      : `${scopeDir(p.scope) ?? p.scope}/${p.slug}.md`;
  };
  const line = (p: PageRef) => `${file(p)} ("${clean(p.title)}")`;
  const out: string[] = [
    "<tidy>",
    "Tidy-up report: where to look in your brain copy. Pages are listed by file.",
  ];
  const section = (head: string, items: string[], none: string) => {
    out.push("", head);
    out.push(...(items.length ? items.map((i) => `- ${i}`) : [none]));
  };
  section(
    "Duplicates (pages that cover the same topic): merge into the better-named page and delete the other.",
    r.duplicates.map((d) => `${line(d.a)} and ${line(d.b)}: ${d.a.slug} ${d.why}`),
    "none found.",
  );
  section(
    "Conflicts kept for you (a `## Conflict` section holds the version that lost): decide what is true, rewrite the page, remove the section and the `needs-tidy` line.",
    r.conflicts.map(line),
    "none.",
  );
  section(
    "Broken [[links]] (they name no page): fix the name, or remove the link.",
    r.broken.map((b) => `${line(b.from)} links to [[${clean(b.link)}]]`),
    "none.",
  );
  section(
    `Unused for ${unusedDays} days and linked from nowhere: delete them unless they are still true and worth keeping.`,
    r.unused.map(
      (u) =>
        `${line(u)}; last opened ${u.lastUsedAt ? new Date(u.lastUsedAt).toISOString().slice(0, 10) : "never"}`,
    ),
    "none (or page use has not been watched long enough yet).",
  );
  section(
    "Maps (one line a page; past the limit a map is cut when it goes into a prompt): keep each under its limit by merging or pruning.",
    r.maps.map(
      (m) =>
        `${m.scope}: ${m.pages} pages, ${m.lines} map lines of ${m.limit}${m.lines > m.limit ? " (over the limit)" : ""}`,
    ),
    "none.",
  );
  out.push("</tidy>");
  return out.join("\n");
}
