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
    // an in-page anchor would move the app off the conversation: it is not a link
    expect(safeHref("#top")).toBeNull();
    expect(safeHref("#")).toBeNull();
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

describe("hostile input costs a pass over the text, not more", () => {
  const rep = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  /** One hostile text of each class, `n` characters long. */
  const cases = (n: number): Record<string, string> => ({
    "a heading with spaces": `# a${" ".repeat(n)}x`,
    "a run of #": rep("#", n),
    "headings of #": rep("# a #\n", n),
    spaces: rep(" ", n),
    "[": rep("[", n),
    "[a](": rep("[a](", n),
    "[a](b": rep("[a](b ", n),
    "*a ": rep("*a ", n),
    "**a ": rep("**a ", n),
    "_a ": rep("_a ", n),
    "nested emphasis": rep("**a *b ~~c ", n),
    backticks: rep("`", n),
    "unmatched code spans": rep("`a ``b ```c ", n),
    "fence-like lines": rep("``` ``` ```\n", n),
    "a fence with spaces": `\`\`\`${" ".repeat(n)}x`,
    "table rows": `|${rep("-|", n)}\n|${rep("-|", n)}\n|a|`,
    "table separators": rep("|-|-|-|-|-|-|-|-|-|-\n", n),
    "(": rep("(", n),
    "\\": rep("\\", n),
    "<": rep("<", n),
    "<http": rep("<http://a ", n),
    http: rep("http://a ", n),
    tildes: rep("~~a ~b ", n),
    unicode: rep("\u202e\u200b*a ", n),
    "list markers": rep("- - - - - -\n", n),
    "ordered markers": rep("1. 1. 1. 1.\n", n),
    quotes: rep("> > > > > > >\n", n),
    rules: rep("- - - - -x\n", n),
  });
  const names = Object.keys(cases(100));
  const timed = (fn: () => void): number => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };
  /** The best of three runs, so a busy machine cannot make one slow run look like growth. */
  const best = (fn: () => void) => Math.min(timed(fn), timed(fn), timed(fn));

  // Load-independent: not "under N ms" but "four times the text costs about four times the time". A backtracking
  // regex or a rescan per character grows with the square or the cube and fails this by a wide margin on a
  // machine of any speed; absolute milliseconds are in the opt-in bench below.
  it.each(names)("%s: four times the text costs about four times the work", (name) => {
    const small = cases(40 * 1024)[name] ?? "";
    const big = cases(160 * 1024)[name] ?? "";
    const t1 = best(() => renderMarkdown(small));
    const t4 = best(() => renderMarkdown(big));
    expect(t4, `${name}: ${t1.toFixed(1)} ms -> ${t4.toFixed(1)} ms`).toBeLessThan(8 * t1 + 20);
  });

  // Counting, not timing: while a reply streams, a render parses only the chunk that grew.
  it.each(names)("%s: streamed in pieces, each render parses at most the open chunk", (name) => {
    const text = cases(60 * 1024)[name] ?? "";
    const cache = new MarkdownCache();
    let worst = 0;
    for (let at = 4000; at <= text.length + 3999; at += 4000) {
      cache.render(text.slice(0, at), true);
      worst = Math.max(worst, cache.parsed);
    }
    expect(worst).toBeLessThanOrEqual(2);
  });

  it("shows a big block as plain text while it streams, and parses it when the turn ends", () => {
    const table = `| a | b |\n|---|---|\n${"| 1 | 2 |\n".repeat(3000)}`;
    const cache = new MarkdownCache();
    const host = document.createElement("div");
    render(cache.render(table, true), host);
    expect(host.querySelector("pre.plain-open")).not.toBeNull();
    expect(host.querySelector("table")).toBeNull();
    expect(cache.parsed).toBe(0);
    render(cache.render(table, false), host);
    expect(host.querySelector("table")).not.toBeNull();
    expect(host.querySelector("pre.plain-open")).toBeNull();
  });

  it("shows control characters in a reply's text, links and code visibly", () => {
    const out = htmlOf("see src/\u202egnp.exe and `x\u202ey` and [a\u200bb](https://example.com)\n\n```\nlet a\u202e = 1\n```");
    expect(out).not.toMatch(/[\u202e\u200b]/);
    expect(out.match(/⟨U\+202E⟩/g)?.length).toBe(3);
    expect(out).toContain("⟨U+200B⟩");
    // an emoji joiner is left alone in prose
    expect(htmlOf("\u{1F468}\u200d\u{1F469}")).toContain("\u200d");
  });

  it("highlights hostile code with work in proportion to its size, and keeps every character", () => {
    const hostile = (n: number) => [rep("<!--", n), rep('"a', n), rep("/*", n), rep("`", n), rep("<a b=", n)];
    for (const lang of ["html", "ts", "py", "sh", "css", "diff", "json"]) {
      const small = hostile(10_000);
      const big = hostile(40_000);
      small.forEach((text, i) => {
        const t1 = best(() => highlight(text, lang));
        const t4 = best(() => highlight(big[i] ?? "", lang));
        expect(t4, `${lang} #${i}: ${t1.toFixed(1)} -> ${t4.toFixed(1)} ms`).toBeLessThan(8 * t1 + 20);
        expect(tokensText(highlight(big[i] ?? "", lang))).toBe(big[i]);
      });
    }
  });

  // Absolute milliseconds, for a person to run on a quiet machine: I_INC_BENCH=1 pnpm --filter @i-inc/web test
  describe.skipIf(!process.env.I_INC_BENCH)("bench (opt in)", () => {
    it.each(names)("%s: 100 KB in under 50 ms, whole and streamed", (name) => {
      const text = cases(100 * 1024)[name] ?? "";
      expect(best(() => renderMarkdown(text))).toBeLessThan(name.includes("markers") || name === "quotes" || name === "rules" ? 250 : 50);
      const cache = new MarkdownCache();
      let worst = 0;
      for (let at = 4000; at <= text.length + 3999; at += 4000) worst = Math.max(worst, timed(() => cache.render(text.slice(0, at), true)));
      expect(worst).toBeLessThan(50);
    });
  });

  it("still reads the ordinary shapes the scanners replaced", () => {
    expect(parseBlocks("# Title ##")[0]).toMatchObject({ k: "h", level: 1 });
    expect(parseBlocks("####### seven")[0]).toMatchObject({ k: "p" });
    expect(parseBlocks("#nospace")[0]).toMatchObject({ k: "p" });
    expect(parseBlocks("## a # b")[0]).toMatchObject({ k: "h", level: 2 });
    expect(parseBlocks("~~~python extra\nx\n~~~")[0]).toMatchObject({
      k: "code",
      lang: "python",
      open: false,
    });
    expect(parseBlocks("```a`b\nx")[0]).toMatchObject({ k: "p" });
    expect(parseBlocks("- - -")[0]).toMatchObject({ k: "hr" });
    expect(parseBlocks("***")[0]).toMatchObject({ k: "hr" });
    expect(parseBlocks("| a | b |\n| :-: | --: |\n| 1 | 2 |")[0]).toMatchObject({ k: "table" });
  });

  it("shows a line over 4,000 characters as plain text", () => {
    const long = `**not bold** ${"x".repeat(4100)}`;
    const blocks = parseBlocks(`before\n${long}\nafter`);
    expect(blocks.map((b) => b.k)).toEqual(["p", "p", "p"]);
    expect(blocks[1]).toMatchObject({ c: [{ k: "text", s: long }] });
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
