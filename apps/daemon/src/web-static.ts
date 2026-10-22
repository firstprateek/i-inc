// The web app's build, served from disk (T63).
//
// - Hashed files under /assets are immutable: a year, no revalidation. Everything else (index.html, sw.js,
//   the manifest, the icons) is `no-cache`: the browser keeps it but asks first, and an ETag makes the ask a 304.
// - Text files go out compressed by `Accept-Encoding`, brotli first. `vite build` writes `<file>.br` and
//   `<file>.gz` next to each one (vite.config.ts); a file without them (an older build) is compressed on its
//   first request and kept in memory.
// - A path under /assets that is not there is a 404, never index.html: a stale tab asking for a chunk a newer
//   build replaced must get an error it can act on, not HTML where script was expected.
// - Any other path that is not a file is the app (index.html), for the hash-routed shell.
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** Text compresses; images and fonts are already compressed. */
const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".webmanifest",
  ".svg",
  ".txt",
  ".map",
]);
/** Below this, the headers cost more than the bytes saved. */
const MIN_COMPRESS = 1024;

type Encoding = "br" | "gzip";

/** The best encoding the client accepts (`br;q=0` and `gzip;q=0` mean no), or none. */
export function chooseEncoding(header: string | null): Encoding | null {
  if (!header) return null;
  const q = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const weight = params.map((p) => /^\s*q=([\d.]+)/.exec(p)?.[1]).find((v) => v !== undefined);
    q.set(name.trim(), weight === undefined ? 1 : Number(weight));
  }
  const ok = (e: string) => (q.get(e) ?? q.get("*") ?? 0) > 0;
  if (ok("br")) return "br";
  if (ok("gzip")) return "gzip";
  return null;
}

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const REVALIDATE = "no-cache";

export type WebServer = (req: Request) => Promise<Response>;

export function serveWebFrom(root: string): WebServer {
  const base = resolve(root);
  /** Files compressed on demand: `<mtime>:<size>:<encoding>:<path>` to the bytes. */
  const made = new Map<string, Buffer>();

  async function fileAt(urlPath: string): Promise<{ path: string; size: number; mtimeMs: number } | null> {
    const path = resolve(join(base, normalize(urlPath)));
    if (path !== base && !path.startsWith(base + sep)) return null;
    try {
      const s = await stat(path);
      return s.isFile() ? { path, size: s.size, mtimeMs: s.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  return async (req) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (urlPath.includes("\0")) return new Response("bad request", { status: 400 });
    let file = urlPath === "/" ? null : await fileAt(urlPath);
    if (!file && urlPath.startsWith("/assets/")) {
      return new Response("not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    file ??= await fileAt("/index.html");
    if (!file) return new Response("not found", { status: 404 });

    const ext = extname(file.path).toLowerCase();
    const hashed = file.path.startsWith(join(base, "assets") + sep);
    const encoding =
      COMPRESSIBLE.has(ext) && file.size >= MIN_COMPRESS
        ? chooseEncoding(req.headers.get("accept-encoding"))
        : null;
    const headers = new Headers({
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": hashed ? IMMUTABLE : REVALIDATE,
    });
    if (COMPRESSIBLE.has(ext)) headers.set("vary", "Accept-Encoding");
    // One ETag per file and encoding, so a 304 is never taken for the wrong representation.
    const etag = `"${file.size.toString(36)}-${Math.round(file.mtimeMs).toString(36)}${encoding ? `-${encoding}` : ""}"`;
    headers.set("etag", etag);
    const match = req.headers.get("if-none-match");
    if (match?.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
      return new Response(null, { status: 304, headers });
    }

    let body: Buffer;
    if (encoding) {
      const suffix = encoding === "br" ? ".br" : ".gz";
      const pre = file.path + suffix;
      const preStat = await stat(pre).catch(() => null);
      // A precompressed copy older than its source belongs to an earlier build: not trusted.
      if (preStat?.isFile() && preStat.mtimeMs >= file.mtimeMs) {
        body = await readFile(pre);
      } else {
        const key = `${file.mtimeMs}:${file.size}:${encoding}:${file.path}`;
        let hit = made.get(key);
        if (!hit) {
          const raw = await readFile(file.path);
          hit =
            encoding === "br"
              ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })
              : gzipSync(raw, { level: 9 });
          made.set(key, hit);
        }
        body = hit;
      }
      headers.set("content-encoding", encoding);
    } else {
      body = await readFile(file.path);
    }
    headers.set("content-length", String(body.length));
    return new Response(req.method === "HEAD" ? null : new Uint8Array(body), { headers });
  };
}
