// Finding pages again (docs/design/brain.md, "Reading"): a query built safely from a task's text,
// BM25 from the index boosted by how close the scope is, one link away from the best two, and a
// token budget. Pure: the index is a port (`RetrievalSource`), so this runs against any fake.
import { type Scope, scopeKind } from "./knowledge.ts";

// ---- The query -------------------------------------------------------------------------------------

const stopWords = new Set(
  `a about above after again all also am an and any are as at be because been before being below
  between both but by can could did do does doing down during each few for from further had has have
  having he her here hers him his how i if in into is it its itself just let me more most my no nor
  not now of off on once only or other our out over own same she should so some such than that the
  their them then there these they this those through to too under until up us very was we were what
  when where which while who whom why will with would you your yours get got make made use used
  using need needs want wants like also etc via per new one two see add fix`
    .split(/\s+/)
    .filter(Boolean),
);

export interface QueryOptions {
  /** At most this many terms go into the query. */
  maxTerms?: number;
  /** Only this much of the text is looked at. */
  maxScan?: number;
}

/**
 * An FTS5 MATCH expression from free text: lowercase words (letters and digits only), stop-words and
 * noise dropped, the most repeated words first, capped in count, each in double quotes and joined with
 * OR. Nothing from the input except [\p{L}\p{N}] ever reaches the expression, so it can't be turned
 * into FTS syntax (NEAR, column filters, `*`, parentheses, unbalanced quotes). Empty when no words.
 */
export function buildQuery(text: string, o: QueryOptions = {}): string {
  const maxTerms = o.maxTerms ?? 24;
  const scan = text.length > (o.maxScan ?? 65_536) ? text.slice(0, o.maxScan ?? 65_536) : text;
  const seen = new Map<string, { n: number; at: number }>();
  let at = 0;
  for (const m of scan.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    at++;
    if (w.length < 2 || w.length > 32 || stopWords.has(w)) continue;
    if (/^\d+$/.test(w) && w.length > 6) continue;
    if (/^[0-9a-f]{12,}$/.test(w)) continue; // hashes and ids
    const hit = seen.get(w);
    if (hit) hit.n++;
    else seen.set(w, { n: 1, at });
  }
  return [...seen.entries()]
    .sort(([, a], [, b]) => Math.min(b.n, 3) - Math.min(a.n, 3) || a.at - b.at)
    .slice(0, maxTerms)
    .map(([w]) => `"${w}"`)
    .join(" OR ");
}

// ---- Retrieval -------------------------------------------------------------------------------------

export interface Hit {
  scope: Scope;
  slug: string;
  title: string;
  description: string;
  updated: string | null;
  /** Higher is better (the index negates SQLite's bm25). */
  score: number;
  snippet: string;
}

export interface StoredPage {
  scope: Scope;
  slug: string;
  title: string;
  description: string;
  updated: string | null;
  body: string;
}

/** What retrieval needs from the index. */
export interface RetrievalSource {
  /** Pages matching an FTS expression within `scopes`, best first. */
  search(match: string, scopes: Scope[], limit: number): Hit[];
  page(scope: Scope, slug: string): StoredPage | null;
  /** The pages `[[links]]` from this page resolve to, through the reader's scopes. */
  linksOf(scope: Scope, slug: string, readable: Scope[]): { scope: Scope; slug: string }[];
}

export interface RetrieveOptions {
  query: string;
  scopes: Scope[];
  boost?: { own: number; team: number; company: number };
  k?: number;
  linkHops?: number;
  tokenBudget?: number;
  /** Pages already in context, as "scope:slug" keys. They are never returned. */
  exclude?: string[];
}

export interface RetrievedPage {
  scope: Scope;
  slug: string;
  title: string;
  description: string;
  updated: string | null;
  /** The page body, cut to fit when it alone is over the budget. */
  text: string;
  tokens: number;
  via: "search" | "link";
  score: number;
}

export const pageKey = (scope: Scope, slug: string): string => `${scope}:${slug}`;
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

const defaultBoost = { own: 1.5, team: 1.2, company: 1 };
const maxLinked = 4;
const linkSeeds = 2;

/**
 * The pages to put in front of an agent for a task: the top `k` by BM25 times the scope's boost (own
 * brain, then team, then company), plus pages one link away from the best two, de-duplicated, until
 * the token budget (about characters / 4) is used.
 */
export function retrieve(source: RetrievalSource, o: RetrieveOptions): RetrievedPage[] {
  const match = buildQuery(o.query);
  if (!match || o.scopes.length === 0) return [];
  const boost = o.boost ?? defaultBoost;
  const k = o.k ?? 5;
  const budget = o.tokenBudget ?? 3000;
  const excluded = new Set(o.exclude ?? []);

  const factor = (s: Scope) => {
    const kind = scopeKind(s);
    return kind === "brain" ? boost.own : kind === "team" ? boost.team : boost.company;
  };
  const hits = source
    .search(match, o.scopes, Math.max(50, (k + excluded.size) * 4))
    .filter((h) => !excluded.has(pageKey(h.scope, h.slug)))
    .map((h) => ({ ...h, score: h.score * factor(h.scope) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  const picked: { ref: { scope: Scope; slug: string }; via: "search" | "link"; score: number }[] = hits.map(
    (h) => ({ ref: h, via: "search", score: h.score }),
  );
  const have = new Set([...picked.map((p) => pageKey(p.ref.scope, p.ref.slug)), ...excluded]);

  // One link away (or `linkHops` away) from the best two.
  let frontier = picked.slice(0, linkSeeds);
  let added = 0;
  for (let hop = 0; hop < (o.linkHops ?? 1) && frontier.length && added < maxLinked; hop++) {
    const next: typeof frontier = [];
    for (const from of frontier) {
      for (const ref of source.linksOf(from.ref.scope, from.ref.slug, o.scopes)) {
        const key = pageKey(ref.scope, ref.slug);
        if (have.has(key) || added >= maxLinked) continue;
        have.add(key);
        added++;
        const entry = { ref, via: "link" as const, score: from.score * 0.5 };
        picked.push(entry);
        next.push(entry);
      }
    }
    frontier = next;
  }

  const out: RetrievedPage[] = [];
  let used = 0;
  for (const p of picked) {
    const page = source.page(p.ref.scope, p.ref.slug);
    if (!page) continue;
    const overhead = page.title.length + page.slug.length + 24;
    let text = page.body.trim();
    let tokens = estimateTokens(text.length + overhead);
    if (used + tokens > budget) {
      if (out.length) break; // stop at the budget
      text = `${text.slice(0, Math.max(0, budget * 4 - overhead))}…`;
      tokens = Math.min(budget, estimateTokens(text.length + overhead));
    }
    used += tokens;
    out.push({
      scope: page.scope,
      slug: page.slug,
      title: page.title,
      description: page.description,
      updated: page.updated,
      text,
      tokens,
      via: p.via,
      score: p.score,
    });
  }
  return out;
}
