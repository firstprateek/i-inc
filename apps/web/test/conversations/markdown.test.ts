import { render } from "lit";
import { describe, expect, it } from "vitest";
import { diffLines, diffStats, diffWithContext } from "../../src/conversations/diff.ts";
import { highlight, tokensText } from "../../src/conversations/highlight.ts";
import {
  chunkStarts,
  inline,
  MarkdownCache,
  parseBlocks,
  renderMarkdown,
  safeHref,
} from "../../src/conversations/markdown.ts";

function htmlOf(text: string): string {
  const host = document.createElement("div");
  render(renderMarkdown(text), host);
  return host.innerHTML.replace(/<!--[^>]*-->/g, "");
}

describe("markdown", () => {
  it("renders the usual shapes", () => {
    const out = htmlOf(
      "# Title\n\nSome **bold**, *italic*, `code` and ~~gone~~ text.\n\n- one\n- two\n  - nested\n\n1. a\n2. b\n\n> quoted\n\n---",
    );
    expect(out).toContain("<h3");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain('<code class="ic">code</code>');
    expect(out).toContain("<del>gone</del>");
    expect(out).toMatch(/<ul>.*<li>.*one.*<\/li>.*<li>.*two.*<ul>.*nested/s);
    expect(out).toContain("<ol");
    expect(out).toContain("<blockquote>");
    expect(out).toContain("<hr");
  });

  it("never turns the text into HTML", () => {
    const host = document.createElement("div");
    render(
      renderMarkdown(
        '<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) [data](data:text/html;base64,AAAA) ![pic](https://evil.example/x.png "t")\n\n<a href="javascript:alert(1)">x</a>',
      ),
      host,
    );
    // what is in the document is text, plus the one link that is safe
    expect([...host.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "https://evil.example/x.png",
    ]);
    expect(host.querySelector("script,img")).toBeNull();
    const out = htmlOf(
      '<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) [data](data:text/html;base64,AAAA) ![pic](https://evil.example/x.png "t")\n\n<a href="javascript:alert(1)">x</a>',
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("onerror=alert(1)>");
    // the raw text is shown as text
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // a link to a dangerous scheme is its label, an image is a link, not a load
    expect(out).toContain("click");
    expect(out).toContain("pic (image)</a>");
  });

  it("opens external links safely and leaves anchors alone", () => {
    expect(htmlOf("[docs](https://example.com/a?b=1)")).toContain(
      'target="_blank" rel="noopener noreferrer"',
    );
    expect(htmlOf("see https://example.com/x.")).toContain('href="https://example.com/x"');
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("#top")).toBe("#top");
    expect(safeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
  });

  it("highlights fenced code and keeps every character", () => {
    const code = 'const x: number = 42; // answer\nfunction f(a) { return "s" + a; }';
    const out = htmlOf(`\`\`\`ts\n${code}\n\`\`\``);
    expect(out).toContain('class="tk-kw"');
    expect(out).toContain('class="tk-str"');
    expect(out).toContain('class="tk-com"');
    expect(out).toContain('class="tk-num"');
    expect(tokensText(highlight(code, "ts"))).toBe(code);
    for (const lang of ["py", "sh", "json", "css", "html", "diff", "sql", "go", "yaml", "nope"]) {
      expect(tokensText(highlight('a = 1 # x\n<b c="d">$HOME</b> -- y', lang))).toBe(
        'a = 1 # x\n<b c="d">$HOME</b> -- y',
      );
    }
  });

  it("shows an unfinished code block plain while it streams, and does not lose it", () => {
    const out = htmlOf("```ts\nconst a = 1;");
    expect(out).toContain("const a = 1;");
    expect(out).not.toContain("tk-kw");
    expect(parseBlocks("```ts\nconst a = 1;")[0]).toMatchObject({ k: "code", open: true });
    expect(parseBlocks("```ts\nconst a = 1;\n```")[0]).toMatchObject({ k: "code", open: false });
  });

  it("keeps snake_case and stray markers as text", () => {
    expect(inline("my_snake_case_name and 2 * 3 * 4")).toEqual([
      { k: "text", s: "my_snake_case_name and 2 * 3 * 4" },
    ]);
    expect(inline("**unclosed")).toEqual([{ k: "text", s: "**unclosed" }]);
  });

  it("renders tables and task lists", () => {
    const out = htmlOf("| a | b |\n|:--|--:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo");
    expect(out).toContain("<table>");
    expect(out).toContain("text-align:right");
    expect(out).toContain('type="checkbox"');
  });

  it("cuts chunks at blank lines but not inside code", () => {
    const text = "para one\nstill one\n\npara two\n\n```\ncode\n\nmore code\n```\n\nlast";
    const starts = chunkStarts(text);
    expect(starts.map((s) => text.slice(s).split("\n")[0])).toEqual(["para one", "para two", "```", "last"]);
  });

  it("parses only the growing last chunk while a reply streams", () => {
    const cache = new MarkdownCache();
    let text = "";
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with some **words** in it.`);
    let maxParsed = 0;
    for (const p of paragraphs) {
      for (const piece of [`${p.slice(0, 10)}`, `${p.slice(10)}`, "\n\n"]) {
        text += piece;
        cache.render(text);
        maxParsed = Math.max(maxParsed, cache.parsed);
      }
    }
    expect(maxParsed).toBeLessThanOrEqual(2);
    // and the result is the same as rendering it whole
    const host1 = document.createElement("div");
    const host2 = document.createElement("div");
    render(cache.render(text), host1);
    render(renderMarkdown(text), host2);
    expect(host1.innerHTML).toBe(host2.innerHTML);
  });

  it("handles a streaming code fence that closes later", () => {
    const cache = new MarkdownCache();
    cache.render("intro\n\n```js\nlet a");
    const host = document.createElement("div");
    render(cache.render("intro\n\n```js\nlet a = 1;\n```\n\ndone"), host);
    expect(host.innerHTML).toContain("tk-kw");
    expect(host.innerHTML).toContain("done");
  });
});

describe("diff", () => {
  it("diffs lines with context and gaps", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 15", "line fifteen");
    const rows = diffWithContext(before, after, 2);
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
    expect(rows.filter((r) => r.kind === "gap")).toHaveLength(2);
    const del = rows.find((r) => r.kind === "del");
    expect(del).toMatchObject({ oldNo: 16, newNo: null, text: "line 15" });
  });
  it("shows a new file as all added and an empty edit as no rows", () => {
    expect(diffStats(diffLines("", "a\nb\n"))).toEqual({ added: 2, removed: 0 });
    expect(diffWithContext("same\n", "same\n")).toEqual([]);
  });
});
