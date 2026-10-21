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
    expect(back.meta.extra).toEqual({ owner: "kit", n: "3" });
    expect(back.body).toBe("Body\n");
  });
});
