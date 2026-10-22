// The brain's page format: frontmatter in and out, links, and pages from before frontmatter existed.
import { describe, expect, it } from "vitest";
import {
  clip,
  extractLinks,
  firstSentence,
  parsePage,
  serializePage,
  titleFromSlug,
  wordCount,
} from "../src/index.ts";

const full = `---
title: Duet release process
description: How Duet cuts a release with Release Please, and the signing step only the owner can do
tags: [duet, Releases]
updated: 2026-10-20
sources: [ticket-14, conversation-3f2a]
---
Cut the release with [[tools/release-please]]. See also [[Duet Money|money]].
`;

describe("parsing a page", () => {
  it("reads every frontmatter field and the links", () => {
    const p = parsePage(full, "projects/duet");
    expect(p.hasFrontmatter).toBe(true);
    expect(p.meta).toEqual({
      title: "Duet release process",
      description: "How Duet cuts a release with Release Please, and the signing step only the owner can do",
      tags: ["duet", "releases"],
      updated: "2026-10-20",
      sources: ["ticket-14", "conversation-3f2a"],
    });
    expect(p.derived).toEqual({ title: false, description: false });
    expect(p.links).toEqual(["tools/release-please", "duet-money"]);
    expect(p.body).toBe("Cut the release with [[tools/release-please]]. See also [[Duet Money|money]].\n");
  });

  it("reads block lists, quoted values, source: external and needs-tidy", () => {
    const p = parsePage(
      [
        "---",
        'title: "Gh: the CLI"',
        "description: 'It''s handy'",
        "tags:",
        "  - gh",
        "  - cli",
        "sources:",
        "  - https://example.com/a",
        "source: external",
        "needs-tidy: true",
        "owner: kit",
        "---",
        "Body",
      ].join("\n"),
    );
    expect(p.meta).toMatchObject({
      title: "Gh: the CLI",
      description: "It's handy",
      tags: ["gh", "cli"],
      sources: ["https://example.com/a"],
      source: "external",
      needsTidy: true,
      extra: { owner: "kit" },
    });
  });

  it("is tolerant of today's pages: title from the heading or slug, description from the first sentence", () => {
    const legacy =
      "# Vitest mocks\n\nReset mocks between tests with vi.restoreAllMocks(). It saves a day.\n\nMore.\n";
    const p = parsePage(legacy, "tools/vitest-mocks");
    expect(p.hasFrontmatter).toBe(false);
    expect(p.meta.title).toBe("Vitest mocks");
    expect(p.meta.description).toBe("Reset mocks between tests with vi.restoreAllMocks().");
    expect(p.meta.tags).toEqual([]);
    expect(p.meta.updated).toBeUndefined();
    expect(p.derived).toEqual({ title: true, description: true });
    expect(p.body).toBe(legacy);

    expect(parsePage("no heading, just text", "reference/odd_page").meta.title).toBe("Odd page");
    expect(parsePage("", "x").meta.description).toBe("");
  });

  it("caps derived and written descriptions at 160 characters", () => {
    const long = `${"word ".repeat(80)}end.`;
    expect(parsePage(long, "a").meta.description.length).toBeLessThanOrEqual(160);
    expect(parsePage(`---\ndescription: ${long}\n---\nx`, "a").meta.description.length).toBeLessThanOrEqual(
      160,
    );
    expect(clip("short", 160)).toBe("short");
  });

  it("treats an unterminated or non-leading frontmatter fence as plain body", () => {
    expect(parsePage("---\ntitle: x\nno end", "a").hasFrontmatter).toBe(false);
    expect(parsePage("text\n---\ntitle: x\n---\n", "a").hasFrontmatter).toBe(false);
  });

  it("handles CRLF files and a BOM", () => {
    const p = parsePage("﻿---\r\ntitle: A\r\ndescription: B\r\n---\r\nBody\r\n", "x");
    expect(p.meta).toMatchObject({ title: "A", description: "B" });
  });
});

describe("links and sentences", () => {
  it("normalizes links, dedupes them and ignores code", () => {
    const body = "[[A b]] [[a-b]] [[tools/X.md#part]] `[[nope]]`\n```\n[[also-nope]]\n```\n[[../escape]]";
    expect(extractLinks(body)).toEqual(["a-b", "tools/x"]);
  });

  it("takes the first real sentence, skipping headings and lists markers", () => {
    expect(firstSentence("# T\n\n- **Always** run `pnpm check` first. Then test.\n")).toBe(
      "Always run pnpm check first.",
    );
    expect(firstSentence("```\ncode\n```\n\nAfter the code. More.")).toBe("After the code.");
  });

  it("titles from slugs and counts words", () => {
    expect(titleFromSlug("tools/gh-cli.md")).toBe("Gh cli");
    expect(wordCount("a b-c, d")).toBe(4);
  });
});

describe("serializing", () => {
  it("round-trips meta and body", () => {
    const p = parsePage(full, "x");
    const again = parsePage(serializePage(p), "x");
    expect(again.meta).toEqual(p.meta);
    expect(again.body).toBe(p.body);
  });

  it("quotes values that would break YAML and keeps unknown keys", () => {
    const meta = {
      title: "Colons: and #hashes",
      description: 'He said "hi"\nacross lines',
      tags: ["a b", "x,y"],
      sources: [],
      needsTidy: true,
      source: "external" as const,
      updated: "2026-01-02",
      extra: { owner: "kit", n: 3 },
    };
    const text = serializePage({ meta, body: "Body\n" });
    const back = parsePage(text, "x");
    expect(back.meta.title).toBe("Colons: and #hashes");
    expect(back.meta.description).toBe('He said "hi" across lines');
    expect(back.meta.tags).toEqual(["a b", "x,y"]);
    expect(back.meta).toMatchObject({ needsTidy: true, source: "external", updated: "2026-01-02" });
    expect(back.meta.extra).toEqual({ owner: "kit", n: 3 });
    expect(back.body).toBe("Body\n");
  });
});

describe("frontmatter is real YAML", () => {
  const rich = [
    "---",
    'title: "Release: the \\"signing\\" step"',
    "description: >",
    "  Folded text that spans",
    "  two lines.",
    "Owner: Kit",
    "notes: |",
    "  line one",
    "  line two: with a colon",
    "",
    "  after a blank",
    "nested:",
    "  team: eng",
    "  oncall:",
    "    - ada",
    "    - kit",
    "  limits: {cpu: 2, mem: 4G}",
    "checks:",
    "  - name: lint",
    "    cmd: 'pnpm check'",
    "  - name: test",
    '    cmd: "pnpm test"',
    'emoji: "café ☕ 日本語"',
    "tags: [A, 'b c']",
    "updated: 2026-10-20",
    "---",
    "Body with [[link]].",
    "",
  ].join("\n");

  it("reads block scalars, nested maps and lists, and keeps keys in their case", () => {
    const p = parsePage(rich, "x");
    expect(p.frontmatterError).toBeUndefined();
    expect(p.meta.title).toBe('Release: the "signing" step');
    expect(p.meta.description).toBe("Folded text that spans two lines.");
    expect(p.meta.tags).toEqual(["a", "b c"]);
    expect(p.meta.updated).toBe("2026-10-20");
    expect(p.meta.extra).toEqual({
      Owner: "Kit",
      notes: "line one\nline two: with a colon\n\nafter a blank\n",
      nested: { team: "eng", oncall: ["ada", "kit"], limits: { cpu: 2, mem: "4G" } },
      checks: [
        { name: "lint", cmd: "pnpm check" },
        { name: "test", cmd: "pnpm test" },
      ],
      emoji: "café ☕ 日本語",
    });
  });

  it("round-trips: meta and body survive a rewrite, unknown keys and their case included", () => {
    const p = parsePage(rich, "x");
    const text = serializePage(p);
    const again = parsePage(text, "x");
    expect(again.frontmatterError).toBeUndefined();
    expect(again.meta).toEqual(p.meta);
    expect(again.body).toBe(p.body);
    expect(text).toContain("\nOwner: Kit\n");
    expect(text).not.toContain("\nowner:");
    // Writing the same page again changes nothing.
    expect(serializePage(again)).toBe(text);
  });

  it("round-trips CRLF files, quotes, colons and unicode in the usual fields", () => {
    const meta = {
      title: 'Qu\'ote "d": café ☕',
      description: "Colon: here, # hash, - dash, and 日本語",
      tags: ["x: y", "日本"],
      sources: ["ticket-1", "https://example.com/a?b=c#d"],
      updated: "2026-10-20",
    };
    const text = serializePage({ meta, body: "Line\r\nTwo\r\n" });
    const crlf = text.split("\n").join("\r\n");
    for (const t of [text, crlf]) {
      const p = parsePage(t, "x");
      expect(p.frontmatterError).toBeUndefined();
      expect(p.meta).toMatchObject(meta);
    }
    expect(parsePage(text, "x").body).toBe("Line\r\nTwo\r\n");
  });

  it("keeps a date-looking updated unquoted and a number-looking title a string", () => {
    const text = serializePage({
      meta: { title: "2026", description: "true", tags: [], sources: [], updated: "2026-10-20" },
      body: "",
    });
    expect(text).toContain("updated: 2026-10-20\n");
    const p = parsePage(text, "x");
    expect(p.meta.title).toBe("2026");
    expect(p.meta.description).toBe("true");
  });

  it("reports invalid YAML instead of throwing, and still reads its plain lines (an unquoted colon)", () => {
    const p = parsePage(
      "---\ntitle: Release: the signing step\ndescription: 'Quoted: yes'\ntags: [a, b]\nsources:\n  - ticket-1\n---\nBody. More.\n",
      "a/b",
    );
    expect(p.hasFrontmatter).toBe(true);
    expect(p.frontmatterError).toBeTruthy();
    expect(p.meta).toMatchObject({
      title: "Release: the signing step",
      description: "Quoted: yes",
      tags: ["a", "b"],
      sources: ["ticket-1"],
    });
    expect(p.body).toBe("Body. More.\n");
    // Rewriting repairs it.
    expect(parsePage(serializePage(p), "a/b").frontmatterError).toBeUndefined();
    const junk = parsePage("---\n{{{ nonsense\n---\nBody. More.\n", "a/b");
    expect(junk.frontmatterError).toBeTruthy();
    expect(junk.meta.title).toBe("B");
    expect(parsePage("---\n- a\n- b\n---\nx", "x").frontmatterError).toMatch(/mapping/);
  });

  it("survives YAML alias bombs", () => {
    const bomb = `---\na: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\n---\nx`;
    const t = performance.now();
    const p = parsePage(bomb, "x");
    expect(performance.now() - t).toBeLessThan(5_000); // one run, a budget only a blow-up reaches
    expect(p.body).toBe("x");
  });
});
