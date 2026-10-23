// The web build is served compressed, cached by hash, and never answers a missing asset with HTML (T63).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { chooseEncoding, contentSecurityPolicy, serveWebFrom } from "../src/web-static.ts";

const JS = "export const answer = 42; // padding so it compresses well\n".repeat(200);
const INDEX = `<!doctype html><html><head><title>i.inc</title></head><body>${"<p>shell</p>".repeat(120)}</body></html>`;
let dir: string;
let serve: ReturnType<typeof serveWebFrom>;

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** What `vite build` writes: for each file, the hash of its source and of each copy. */
function writeManifest(files: Record<string, string>) {
  const map: Record<string, { src: string; br: string; gz: string }> = {};
  for (const [f, text] of Object.entries(files)) {
    map[f] = {
      src: sha(text),
      br: sha(brotliCompressSync(Buffer.from(text))),
      gz: sha(gzipSync(Buffer.from(text))),
    };
  }
  writeFileSync(join(dir, "precompressed.json"), JSON.stringify(map));
}

const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  serve(new Request(`http://127.0.0.1:7420${path}`, { headers, method }));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "i-inc-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), INDEX);
  writeFileSync(join(dir, "sw.js"), JS);
  writeFileSync(join(dir, "manifest.webmanifest"), '{"name":"i.inc"}');
  // A build that wrote its own .br and .gz (vite.config.ts)...
  writeFileSync(join(dir, "assets/app-abc123.js"), JS);
  writeFileSync(join(dir, "assets/app-abc123.js.br"), brotliCompressSync(Buffer.from(JS)));
  writeFileSync(join(dir, "assets/app-abc123.js.gz"), gzipSync(Buffer.from(JS)));
  writeManifest({ "assets/app-abc123.js": JS });
  // ...and one from an older build that did not.
  writeFileSync(join(dir, "assets/old-def456.js"), JS);
  writeFileSync(join(dir, "assets/font-aaa111.woff2"), Buffer.alloc(4000, 7));
  serve = serveWebFrom(dir);
});

describe("Accept-Encoding", () => {
  it("prefers brotli, then gzip, and honours q=0", () => {
    expect(chooseEncoding("gzip, deflate, br")).toBe("br");
    expect(chooseEncoding("gzip")).toBe("gzip");
    expect(chooseEncoding("br;q=0, gzip")).toBe("gzip");
    expect(chooseEncoding("identity")).toBeNull();
    expect(chooseEncoding("*")).toBe("br");
    expect(chooseEncoding(null)).toBeNull();
  });
});

describe("hashed assets", () => {
  it("go out brotli-compressed from the precompressed file, immutable for a year", async () => {
    const res = await get("/assets/app-abc123.js", { "accept-encoding": "gzip, br" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBeLessThan(JS.length / 5);
    expect(brotliDecompressSync(bytes).toString()).toBe(JS);
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
  });

  it("go out gzip-compressed to a client that only takes gzip", async () => {
    const res = await get("/assets/app-abc123.js", { "accept-encoding": "gzip" });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(JS);
  });

  it("go out as they are to a client that takes neither", async () => {
    const res = await get("/assets/app-abc123.js");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(JS);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("are compressed on the first request when a build did not precompress them", async () => {
    const res = await get("/assets/old-def456.js", { "accept-encoding": "br" });
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(JS);
    const again = await get("/assets/old-def456.js", { "accept-encoding": "gzip" });
    expect(gunzipSync(Buffer.from(await again.arrayBuffer())).toString()).toBe(JS);
  });

  it("leave fonts alone (already compressed) but still cache them for a year", async () => {
    const res = await get("/assets/font-aaa111.woff2", { "accept-encoding": "br, gzip" });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("are a 404 when missing, never index.html", async () => {
    const res = await get("/assets/gone-123456.js", { "accept-encoding": "br" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("html");
    expect(await res.text()).not.toContain("<html");
  });

  it("trusts a precompressed copy by what it is, not by its date", async () => {
    // Older than its source by the clock, but the manifest vouches for both: served as the copy.
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, "assets/app-abc123.js.br"), past, past);
    const res = await get("/assets/app-abc123.js", { "accept-encoding": "br" });
    expect(Buffer.from(await res.arrayBuffer()).equals(brotliCompressSync(Buffer.from(JS)))).toBe(true);
  });

  it("does not trust a copy the manifest does not vouch for: swapped, or made from another file", async () => {
    writeFileSync(join(dir, "assets/swap-111111.js"), JS);
    writeFileSync(join(dir, "assets/swap-111111.js.gz"), gzipSync(Buffer.from("something else entirely")));
    writeManifest({ "assets/app-abc123.js": JS, "assets/swap-111111.js": JS });
    const swapped = await get("/assets/swap-111111.js", { "accept-encoding": "gzip" });
    expect(gunzipSync(Buffer.from(await swapped.arrayBuffer())).toString()).toBe(JS);
    // The source changed after the build wrote its copy (a later copy over it): the copy is no longer its copy.
    writeFileSync(join(dir, "assets/edit-222222.js"), JS);
    writeFileSync(join(dir, "assets/edit-222222.js.gz"), gzipSync(Buffer.from(JS)));
    writeManifest({ "assets/app-abc123.js": JS, "assets/edit-222222.js": JS });
    writeFileSync(join(dir, "assets/edit-222222.js"), `${JS}// edited\n`);
    const edited = await get("/assets/edit-222222.js", { "accept-encoding": "gzip" });
    expect(gunzipSync(Buffer.from(await edited.arrayBuffer())).toString()).toBe(`${JS}// edited\n`);
  });

  it("compresses itself when a build has no manifest (an older build's copies are not taken on trust)", async () => {
    const other = mkdtempSync(join(tmpdir(), "i-inc-web-nomanifest-"));
    mkdirSync(join(other, "assets"));
    writeFileSync(join(other, "index.html"), INDEX);
    writeFileSync(join(other, "assets/x-333333.js"), JS);
    writeFileSync(join(other, "assets/x-333333.js.gz"), gzipSync(Buffer.from("not the same")));
    const res = await serveWebFrom(other)(
      new Request("http://127.0.0.1:7420/assets/x-333333.js", { headers: { "accept-encoding": "gzip" } }),
    );
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(JS);
  });
});

describe("links inside the build", () => {
  let outside: string;
  beforeAll(() => {
    outside = mkdtempSync(join(tmpdir(), "i-inc-outside-"));
    writeFileSync(join(outside, "secret.js"), "export const secret = 'do not serve';\n".repeat(60));
    symlinkSync(join(outside, "secret.js"), join(dir, "assets/leak-444444.js"));
    symlinkSync(outside, join(dir, "assets/linked-dir"));
    // A link that stays inside the build is not followed either: the file must be where its address says.
    symlinkSync(join(dir, "assets/old-def456.js"), join(dir, "assets/alias-555555.js"));
  });

  it("never serves a file that is a link, to somewhere outside or inside the build", async () => {
    for (const path of [
      "/assets/leak-444444.js",
      "/assets/linked-dir/secret.js",
      "/assets/alias-555555.js",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("do not serve");
    }
    // ...and outside /assets it falls back to the app, never to the linked file.
    symlinkSync(join(outside, "secret.js"), join(dir, "leak.txt"));
    const res = await get("/leak.txt");
    expect(await res.text()).toBe(INDEX);
  });

  it("serves a build reached through a link to its folder (a release behind `current`)", async () => {
    const parent = mkdtempSync(join(tmpdir(), "i-inc-release-"));
    const via = join(parent, "current");
    symlinkSync(dir, via);
    const res = await serveWebFrom(via)(new Request("http://127.0.0.1:7420/assets/app-abc123.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JS);
  });
});

describe("the shell and everything else", () => {
  it("serves index.html and sw.js with no-cache, so a deploy shows up at once", async () => {
    for (const path of ["/", "/index.html", "/sw.js", "/manifest.webmanifest", "/conversations/deep/link"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
    }
    expect(await (await get("/conversations/deep/link")).text()).toBe(INDEX);
    expect((await get("/")).headers.get("content-type")).toContain("text/html");
  });

  it("compresses index.html too", async () => {
    const res = await get("/", { "accept-encoding": "br" });
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(INDEX);
  });

  it("answers a repeat request with 304, per representation", async () => {
    const first = await get("/", { "accept-encoding": "gzip" });
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toBeTruthy();
    const again = await get("/", { "accept-encoding": "gzip", "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    const other = await get("/", { "accept-encoding": "br", "if-none-match": etag });
    expect(other.status).toBe(200);
  });

  it("does not read outside the build", async () => {
    for (const path of ["/../package.json", "/%2e%2e/%2e%2e/etc/passwd", "/assets/../../x", "/%00"]) {
      const res = await get(path);
      expect(await res.text(), path).not.toContain("root:");
      expect([200, 400, 404], path).toContain(res.status);
    }
  });

  it("answers HEAD without a body", async () => {
    const res = await get("/assets/app-abc123.js", { "accept-encoding": "br" }, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(await res.text()).toBe("");
  });
});

describe("what the shell may do (T63)", () => {
  it("sends the app shell a Content-Security-Policy that keeps it to its own origin", async () => {
    const res = await get("/", { host: "iinc.tail.ts.net" });
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const d of [
      "default-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "worker-src 'self'",
      "font-src 'self'",
    ]) {
      expect(csp, d).toContain(d);
    }
    // No remote script, style or frame; inline script is not allowed (only styles are).
    expect(csp).not.toMatch(/script-src[^;]*('unsafe-inline'|'unsafe-eval'|https?:|\*)/);
    expect(csp).not.toMatch(/default-src[^;]*(https?:|\*)/);
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob:");
    // The AHP WebSocket is this host, and only this host.
    expect(csp).toContain("connect-src 'self' ws://iinc.tail.ts.net wss://iinc.tail.ts.net");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("gives every file nosniff, and the policy only to documents", async () => {
    for (const path of [
      "/",
      "/sw.js",
      "/assets/app-abc123.js",
      "/assets/font-aaa111.woff2",
      "/manifest.webmanifest",
    ]) {
      const res = await get(path);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
    expect((await get("/assets/app-abc123.js")).headers.get("content-security-policy")).toBeNull();
    expect((await get("/conversations/deep/link")).headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
  });

  it("never lets a Host header widen the policy", () => {
    for (const evil of ["evil.test; script-src *", "a b", "x:abc", "", "host/../x", "h\nx"]) {
      const csp = contentSecurityPolicy(evil);
      expect(csp, evil).toContain("connect-src 'self'");
      expect(csp, evil).not.toContain("ws://");
      expect(csp, evil).not.toMatch(/script-src[^;]*(\*|evil)/);
    }
    expect(contentSecurityPolicy(null)).not.toContain("ws://");
    expect(contentSecurityPolicy("127.0.0.1:7420")).toContain("ws://127.0.0.1:7420 wss://127.0.0.1:7420");
  });
});
