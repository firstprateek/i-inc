// The web build is served compressed, cached by hash, and never answers a missing asset with HTML (T63).
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { chooseEncoding, contentSecurityPolicy, serveWebFrom } from "../src/web-static.ts";

const JS = "export const answer = 42; // padding so it compresses well\n".repeat(200);
const INDEX = `<!doctype html><html><head><title>i.inc</title></head><body>${"<p>shell</p>".repeat(120)}</body></html>`;
let dir: string;
let serve: ReturnType<typeof serveWebFrom>;

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

  it("distrusts a precompressed copy older than its file", async () => {
    writeFileSync(join(dir, "assets/new-fff000.js"), JS);
    writeFileSync(join(dir, "assets/new-fff000.js.gz"), gzipSync(Buffer.from("old build")));
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "assets/new-fff000.js.gz"), past, past);
    const res = await get("/assets/new-fff000.js", { "accept-encoding": "gzip" });
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(JS);
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
