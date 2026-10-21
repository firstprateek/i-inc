// Finding pages again: the safe query builder, the scope boost, link expansion and the budget; and the
// map's size limit. Against a fake index, so no SQLite here.
import { describe, expect, it } from "vitest";
import {
  buildMap,
  buildQuery,
  type Hit,
  mapLineLimit,
  pageKey,
  type RetrievalSource,
  retrieve,
  type Scope,
  type StoredPage,
} from "../src/index.ts";

describe("buildQuery", () => {
  it("keeps the meaningful words, quoted and OR-ed, and drops stop-words, punctuation and short noise", () => {
    expect(buildQuery("How do I reset the Vitest mocks, again? (see #12)")).toBe(
      '"reset" OR "vitest" OR "mocks" OR "12"',
    );
    expect(buildQuery("")).toBe("");
    expect(buildQuery("the and of to a")).toBe("");
  });

  it("puts repeated words first and caps the number of terms", () => {
    const q = buildQuery("alpha beta beta beta gamma", { maxTerms: 2 });
    expect(q).toBe('"beta" OR "alpha"');
    const many = buildQuery(Array.from({ length: 200 }, (_, i) => `word${i}`).join(" "));
    expect(many.split(" OR ").length).toBe(24);
  });

  it("never lets FTS5 syntax through", () => {
    const hostile = [
      '" OR 1=1 --',
      "title:secret NEAR(a b, 3)",
      "foo* AND NOT (bar OR baz",
      '"unbalanced',
      "^start {col1 col2}: x",
      "a\u0000b ‮ rtl",
    ];
    for (const text of hostile) {
      const q = buildQuery(text);
      // Only quoted bare words joined by OR.
      expect(q === "" || /^"[\p{L}\p{N}]+"( OR "[\p{L}\p{N}]+")*$/u.test(q)).toBe(true);
    }
    expect(buildQuery("NEAR AND OR NOT")).toBe('"near"');
  });

  it("handles 100 KB of hostile input in well under 50 ms", () => {
    const inputs = [
      '"(*^:'.repeat(20_000),
      "a".repeat(100_000),
      Array.from({ length: 20_000 }, (_, i) => `w${i}x`).join(" "),
      "́".repeat(100_000),
    ];
    for (const text of inputs) {
      const t = performance.now();
      const q = buildQuery(text);
      expect(performance.now() - t).toBeLessThan(50);
      expect(q.length).toBeLessThan(2000);
    }
  });
});

// A scripted index: pages, their raw scores for any query, and links.
function fake(
  pages: { scope: Scope; slug: string; score?: number; body?: string; links?: string[] }[],
): RetrievalSource {
  const stored = (p: (typeof pages)[number]): StoredPage => ({
    scope: p.scope,
    slug: p.slug,
    title: p.slug,
    description: `about ${p.slug}`,
    updated: "2026-10-20",
    body: p.body ?? `body of ${p.slug}`,
  });
  return {
    search: (_match, scopes, limit): Hit[] =>
      pages
        .filter((p) => p.score !== undefined && scopes.includes(p.scope))
        .map((p) => ({ ...stored(p), score: p.score ?? 0, snippet: "" }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit),
    page: (scope, slug) => {
      const p = pages.find((x) => x.scope === scope && x.slug === slug);
      return p ? stored(p) : null;
    },
    linksOf: (scope, slug, readable) =>
      (pages.find((x) => x.scope === scope && x.slug === slug)?.links ?? []).flatMap((l) => {
        const t = pages.find((x) => x.slug === l && readable.includes(x.scope));
        return t ? [{ scope: t.scope, slug: t.slug }] : [];
      }),
  };
}

const scopes: Scope[] = ["brain:ada", "team:eng", "company"];

describe("retrieve", () => {
  it("multiplies BM25 by how close the scope is", () => {
    const src = fake([
      { scope: "company", slug: "c", score: 10 },
      { scope: "team:eng", slug: "t", score: 9 }, // 10.8
      { scope: "brain:ada", slug: "b", score: 7.5 }, // 11.25
    ]);
    const out = retrieve(src, { query: "vitest mocks", scopes });
    expect(out.map((p) => p.slug)).toEqual(["b", "t", "c"]);
    expect(out[0]?.score).toBeCloseTo(11.25);
  });

  it("takes the top k, then adds pages one link from the best two, without duplicates", () => {
    const src = fake([
      { scope: "company", slug: "a", score: 9, links: ["x", "b"] },
      { scope: "company", slug: "b", score: 8, links: ["y"] },
      { scope: "company", slug: "c", score: 7, links: ["z"] },
      { scope: "company", slug: "x", body: "linked x" },
      { scope: "company", slug: "y", body: "linked y" },
      { scope: "company", slug: "z", body: "linked z" },
    ]);
    const out = retrieve(src, { query: "thing here", scopes, k: 3 });
    expect(out.map((p) => [p.slug, p.via])).toEqual([
      ["a", "search"],
      ["b", "search"],
      ["c", "search"],
      ["x", "link"],
      ["y", "link"],
    ]);
    expect(retrieve(src, { query: "thing here", scopes, k: 3, linkHops: 0 }).map((p) => p.slug)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does not follow links into scopes the reader can't read", () => {
    const src = fake([
      { scope: "company", slug: "a", score: 5, links: ["secret"] },
      { scope: "brain:pia", slug: "secret", body: "home data" },
    ]);
    expect(retrieve(src, { query: "anything", scopes }).map((p) => p.slug)).toEqual(["a"]);
  });

  it("skips pages already in context, and fills the slots with the next best", () => {
    const src = fake(["a", "b", "c"].map((slug, i) => ({ scope: "company" as Scope, slug, score: 9 - i })));
    const out = retrieve(src, {
      query: "alpha beta",
      scopes,
      k: 2,
      exclude: [pageKey("company", "a")],
    });
    expect(out.map((p) => p.slug)).toEqual(["b", "c"]);
  });

  it("stops at the token budget (about characters / 4), but always returns something useful", () => {
    const body = "word ".repeat(400); // 2000 chars, 500 tokens
    const src = fake(
      ["a", "b", "c", "d"].map((slug, i) => ({ scope: "company" as Scope, slug, score: 9 - i, body })),
    );
    const out = retrieve(src, { query: "alpha beta", scopes, tokenBudget: 1200 });
    expect(out.length).toBe(2);
    expect(out.reduce((n, p) => n + p.tokens, 0)).toBeLessThanOrEqual(1200);

    const tiny = retrieve(src, { query: "alpha beta", scopes, tokenBudget: 100 });
    expect(tiny.length).toBe(1);
    expect(tiny[0]?.tokens).toBeLessThanOrEqual(100);
    expect(tiny[0]?.text.endsWith("…")).toBe(true);
  });

  it("returns nothing for a query with no usable words or no scopes", () => {
    const src = fake([{ scope: "company", slug: "a", score: 1 }]);
    expect(retrieve(src, { query: "the of and", scopes })).toEqual([]);
    expect(retrieve(src, { query: "vitest", scopes: [] })).toEqual([]);
  });
});

describe("buildMap", () => {
  const page = (slug: string) => ({ slug, description: `about ${slug}` });

  it("lists one line per page under a section per folder", () => {
    const m = buildMap([page("tools/vitest"), page("personality"), page("tools/gh"), page("duties/review")]);
    expect(m.sections).toEqual({});
    expect(m.root).toEqual([
      "## general",
      "- [[personality]] — about personality",
      "",
      "## duties",
      "- [[duties/review]] — about duties/review",
      "",
      "## tools",
      "- [[tools/gh]] — about tools/gh",
      "- [[tools/vitest]] — about tools/vitest",
    ]);
  });

  it("splits beyond 150 lines into sections, each under the limit", () => {
    const pages = [
      ...Array.from({ length: 200 }, (_, i) => page(`tools/t${String(i).padStart(3, "0")}`)),
      ...Array.from({ length: 30 }, (_, i) => page(`facts/f${i}`)),
    ];
    const m = buildMap(pages);
    expect(m.root.length).toBeLessThanOrEqual(mapLineLimit);
    expect(Object.keys(m.sections)).toEqual(["facts", "tools", "tools#2"]);
    for (const lines of Object.values(m.sections)) expect(lines.length).toBeLessThanOrEqual(mapLineLimit);
    const all = Object.values(m.sections)
      .flat()
      .filter((l) => l.startsWith("- [["));
    expect(all.length).toBe(230);
    expect(m.root).toContain("- [[section:tools#2]] — 52 pages");
  });

  it("never lets the root pass the limit, however many folders there are", () => {
    const m = buildMap(Array.from({ length: 400 }, (_, i) => page(`f${i}/p`)));
    expect(m.root.length).toBeLessThanOrEqual(mapLineLimit);
    expect(m.root.at(-1)).toMatch(/more sections/);
  });

  it("treats folders named like Object.prototype members as plain names", () => {
    const pages = ["__proto__", "constructor", "toString"].flatMap((f) =>
      Array.from({ length: 80 }, (_, i) => page(`${f}/p${i}`)),
    );
    const m = buildMap(pages);
    expect(Object.keys(m.sections)).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.hasOwn(m.sections, "__proto__")).toBe(true);
    expect(m.sections.constructor?.length).toBe(81);
    expect(Object.hasOwn(buildMap([page("a/b")]).sections, "constructor")).toBe(false);
  });
});
