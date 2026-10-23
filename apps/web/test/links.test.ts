// Addresses from data become links only when they are safe (T63 group 8).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apiPath, appHref, webHref } from "../src/links.ts";

describe("webHref", () => {
  it("allows http(s) and nothing else", () => {
    expect(webHref("https://github.com/acme/duet/pull/4")).toBe("https://github.com/acme/duet/pull/4");
    expect(webHref("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    for (const bad of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,<b>",
      "file:///etc/passwd",
      "vbscript:x",
      "//evil.test/x",
      "/relative",
      "#",
      "",
      "mailto:a@b.c",
    ]) {
      expect(webHref(bad), bad).toBeUndefined();
    }
    expect(webHref(undefined)).toBeUndefined();
    expect(webHref({ toString: () => "https://x.test" })).toBeUndefined();
    expect(webHref(`https://x.test/${"a".repeat(3000)}`)).toBeUndefined();
  });
});

describe("appHref and apiPath", () => {
  it("keep to the app's own hash routes and the daemon's own paths", () => {
    expect(appHref("#/ticket/7")).toBe("#/ticket/7");
    expect(appHref("#/conversations/ab12cd34?card=x")).toBe("#/conversations/ab12cd34?card=x");
    for (const bad of ["javascript:alert(1)", "https://x.test", "#nope", "#/a b", "/api/x"])
      expect(appHref(bad), bad).toBeUndefined();
    expect(apiPath("/api/tickets/7/attachments/1")).toBe("/api/tickets/7/attachments/1");
    for (const bad of ["//evil.test/x", "https://x.test", "javascript:1", "api/x", "/a b", "/\\evil"])
      expect(apiPath(bad), bad).toBeUndefined();
  });
});

describe("the views", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );

  it("never put data into an href unchecked: every non-hash href with a value goes through links.ts", () => {
    const unchecked: string[] = [];
    for (const f of files(src)) {
      if (f.endsWith("links.ts")) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const m of line.matchAll(/\bhref=\$\{([^}]+)\}/g)) {
            const expr = (m[1] ?? "").trim();
            const own =
              /^(web|app|apiHref)\(/.test(expr) ||
              /Href\(|HREF\b|Hash\(|hash\(|brainHref|projectHref|conversationHref|newRepoLink|addRepoHref|homeHash|t\.href|a\.href|\bhref\b$|\bhref as string|^href$/.test(
                expr,
              );
            if (!own) unchecked.push(`${f.slice(src.length + 1)}:${i + 1}: ${expr}`);
          }
        });
    }
    expect(unchecked).toEqual([]);
  });
});
