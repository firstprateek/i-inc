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
  const KB = 100 * 1024;
  const rep = (unit: string, n = KB) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const cases: Record<string, string> = {
    "a heading with spaces": `# a${" ".repeat(KB)}x`,
    "a run of #": rep("#"),
    "headings of #": rep("# a #\n"),
    spaces: rep(" "),
    "[": rep("["),
    "[a](": rep("[a]("),
    "[a](b": rep("[a](b "),
    "*a ": rep("*a "),
    "**a ": rep("**a "),
    "_a ": rep("_a "),
    "nested emphasis": rep("**a *b ~~c "),
    backticks: rep("`"),
    "unmatched code spans": rep("`a ``b ```c "),
    "fence-like lines": rep("``` ``` ```\n"),
    "a fence with spaces": `\`\`\`${" ".repeat(KB)}x`,
    "table rows": `|${rep("-|")}\n|${rep("-|")}\n|a|`,
    "table separators": rep("|-|-|-|-|-|-|-|-|-|-\n"),
    "(": rep("("),
    "\\": rep("\\"),
    "<": rep("<"),
    "<http": rep("<http://a "),
    http: rep("http://a "),
    tildes: rep("~~a ~b "),
    unicode: rep("\u202e\u200b*a "),
  };
  const timed = (fn: () => void): number => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };
  // Text that really is thousands of nested list items and quotes builds thousands of them: linear, but a
  // heavier constant, so it gets a wider budget (a ReDoS would be seconds).
  const structural: Record<string, string> = {
    "list markers": rep("- - - - - -\n"),
    "ordered markers": rep("1. 1. 1. 1.\n"),
    quotes: rep("> > > > > > >\n"),
    rules: rep("- - - - -x\n"),
  };
  it.each(Object.entries(structural))("%s: 100 KB of nested structure in under 250 ms", (_name, text) => {
    expect(
      Math.min(
        timed(() => renderMarkdown(text)),
        timed(() => renderMarkdown(text)),
      ),
    ).toBeLessThan(250);
  });

  it.each(Object.entries(cases))("%s: 100 KB in a single pass", (_name, text) => {
    // the faster of two runs: a cold first run pays for compiling, and a ReDoS is seconds, not milliseconds
    expect(
      Math.min(
        timed(() => renderMarkdown(text)),
        timed(() => renderMarkdown(text)),
      ),
    ).toBeLessThan(50);
  });

  it.each(Object.entries(cases))("%s: 100 KB streamed in pieces, every render", (_name, text) => {
    // the better of two passes: a loaded machine can stall one, a ReDoS stalls both
    const pass = () => {
      const cache = new MarkdownCache();
      let worst = 0;
      for (let at = 4000; at <= text.length + 3999; at += 4000) {
        worst = Math.max(
          worst,
          timed(() => cache.render(text.slice(0, at))),
        );
      }
      return worst;
    };
    expect(Math.min(pass(), pass())).toBeLessThan(50);
  });

  it("highlights hostile code in bounded time and keeps every character", () => {
    for (const lang of ["html", "ts", "py", "sh", "css", "diff", "json"]) {
      for (const text of [
        rep("<!--", 40_000),
        rep('"a', 40_000),
        rep("/*", 40_000),
        rep("`", 40_000),
        rep("<a b=", 40_000),
      ]) {
        let tokens: ReturnType<typeof highlight> = [];
        expect(
          timed(() => {
            tokens = highlight(text, lang);
          }),
          `${lang}`,
        ).toBeLessThan(80);
        expect(tokensText(tokens)).toBe(text);
      }
    }
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
