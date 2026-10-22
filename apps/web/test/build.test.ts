// @vitest-environment node
// What `vite build` produces (T63): a small entry chunk, one chunk per screen group, self-hosted fonts, and a
// brotli and gzip copy of every text file for the daemon to send.
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
let out: string;
const file = (p: string) => readFileSync(join(out, p), "utf8");
const assets = () => readdirSync(join(out, "assets"));

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "i-inc-build-"));
  await build({ root: web, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
}, 120_000);

describe("the build", () => {
  it("keeps the entry chunk small and splits the screens out of it", () => {
    const html = file("index.html");
    const entry = /<script type="module"[^>]* src="\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(entry).toBeTruthy();
    const entryBytes = statSync(join(out, entry as string)).size;
    // It was one 613 KB file. Now it is the shell, the router and Lit.
    expect(entryBytes).toBeLessThan(130_000);
    const js = assets().filter((f) => f.endsWith(".js"));
    for (const f of js) expect(statSync(join(out, "assets", f)).size, f).toBeLessThan(200_000);
    for (const group of [
      "group-conversations",
      "group-work",
      "group-brain",
      "group-projects",
      "setup",
      "hiring",
      "chat",
      "desk",
      "office",
    ]) {
      expect(
        js.some((f) => f.startsWith(`${group}-`)),
        group,
      ).toBe(true);
    }
    // The AHP client is not in the entry chunk.
    expect(file(entry as string)).not.toContain("WebSocketTransport");
  });

  it("serves the fonts itself: no request to another origin, three swapping faces", () => {
    const html = file("index.html");
    expect(html).not.toMatch(/googleapis|gstatic/);
    expect(html).not.toMatch(/(?:href|src)="https?:/);
    const css = file(`assets/${assets().find((f) => f.endsWith(".css"))}`);
    expect(css).not.toMatch(/googleapis|gstatic|@import/);
    const faces = css.match(/@font-face\{[^}]*\}/g) ?? [];
    expect(faces.length).toBe(3);
    for (const face of faces) {
      expect(face).toContain("font-display:swap");
      const url = /url\(([^)]+)\)/.exec(face)?.[1]?.replace(/["']/g, "") as string;
      expect(url).toMatch(/^\/assets\/.+\.woff2$/);
      expect(statSync(join(out, url)).size).toBeGreaterThan(5000);
    }
    for (const family of ["Figtree", "Bricolage Grotesque", "JetBrains Mono"])
      expect(faces.join("")).toContain(family);
    // The two fonts the first paint needs are preloaded from the page.
    expect(html.match(/rel="preload"[^>]*as="font"/g)?.length).toBe(2);
  });

  it("writes a brotli and a gzip copy beside every text file that decode to it", () => {
    const texts = [...assets().map((f) => `assets/${f}`), "index.html", "sw.js"].filter(
      (f) => /\.(js|css|html)$/.test(f) && statSync(join(out, f)).size >= 1024,
    );
    expect(texts.length).toBeGreaterThan(8);
    for (const f of texts) {
      const raw = readFileSync(join(out, f));
      const br = readFileSync(join(out, `${f}.br`));
      const gz = readFileSync(join(out, `${f}.gz`));
      expect(br.length, f).toBeLessThan(raw.length);
      expect(gz.length, f).toBeLessThan(raw.length);
      expect(brotliDecompressSync(br).equals(raw), f).toBe(true);
      expect(gunzipSync(gz).equals(raw), f).toBe(true);
    }
    // Fonts are already compressed.
    expect(assets().filter((f) => f.endsWith(".woff2.br"))).toEqual([]);
  });

  it("precaches every file the shell can need, but not the compressed copies", () => {
    const sw = file("sw.js");
    const list = JSON.parse(/const PRECACHE = (\[.*?\]);/s.exec(sw)?.[1] ?? "[]") as string[];
    expect(list).toContain("/index.html");
    expect(list.some((u) => u.endsWith(".woff2"))).toBe(true);
    expect(list.some((u) => /\/group-work-/.test(u))).toBe(true);
    expect(list.filter((u) => /\.(br|gz)$/.test(u))).toEqual([]);
  });
});
