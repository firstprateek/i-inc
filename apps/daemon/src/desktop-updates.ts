// The desktop app's updates (apps/desktop), served under /desktop/ without a login: the app asks from Rust,
// with no cookie, and what it gets is useless without the signing key's approval (each build is signed on the
// host, and the app installs only what its built-in public key verifies).
//
// `pnpm --filter @i-inc/desktop release` writes the folder (`~/.i-inc/desktop/`):
//   release.json             { version, notes, pub_date, file, signature }: the newest build
//   i.inc_<version>.app.tar.gz  that build, for the updater (Tauri's updater plugin format)
//   i.inc.zip                the same build zipped, for a first install by hand
//
//   GET /desktop/latest.json   the updater's answer, built from release.json, with the download address on the
//                              host the request came to (loopback on the Mac mini, the tailnet name elsewhere);
//                              204 when there is no release
//   GET /desktop/<file>        the build named in release.json, or i.inc.zip
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface DesktopRelease {
  version: string;
  notes?: string;
  pub_date?: string;
  file: string;
  signature: string;
}

/** The platforms one universal macOS build answers for (the plugin asks for `darwin-<arch>` of the slice). */
export const DESKTOP_PLATFORMS = ["darwin-aarch64", "darwin-x86_64"] as const;

const FILE = /^i\.inc_[0-9A-Za-z.+-]+\.app\.tar\.gz$/;
const ZIP = "i.inc.zip";
const HOST = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

/** A release.json that has every field, with a file name of the expected shape; otherwise null. */
export function parseRelease(text: string): DesktopRelease | null {
  try {
    const r = JSON.parse(text) as Partial<DesktopRelease>;
    if (typeof r.version !== "string" || !/^\d+\.\d+\.\d+$/.test(r.version)) return null;
    if (typeof r.file !== "string" || !FILE.test(r.file)) return null;
    if (typeof r.signature !== "string" || !r.signature) return null;
    return {
      version: r.version,
      file: r.file,
      signature: r.signature,
      ...(typeof r.notes === "string" ? { notes: r.notes } : {}),
      ...(typeof r.pub_date === "string" ? { pub_date: r.pub_date } : {}),
    };
  } catch {
    return null;
  }
}

/** The address the request came to, as the app can reach it again: plain http on loopback, https otherwise. */
export function originOf(host: string | null): string | null {
  if (!host || !HOST.test(host)) return null;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  const loopback = name === "127.0.0.1" || name === "localhost" || name === "[::1]";
  return `${loopback ? "http" : "https"}://${host}`;
}

/** The updater plugin's answer for `release`, downloading from `origin`. */
export function updaterManifest(release: DesktopRelease, origin: string) {
  const entry = { signature: release.signature, url: `${origin}/desktop/${release.file}` };
  return {
    version: release.version,
    notes: release.notes ?? "",
    ...(release.pub_date ? { pub_date: release.pub_date } : {}),
    platforms: Object.fromEntries(DESKTOP_PLATFORMS.map((p) => [p, entry])),
  };
}

export type DesktopServer = (req: Request) => Promise<Response>;

export function serveDesktopUpdates(dir: string): DesktopServer {
  async function release(): Promise<DesktopRelease | null> {
    try {
      return parseRelease(await readFile(join(dir, "release.json"), "utf8"));
    } catch {
      return null;
    }
  }

  return async (req) => {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405 });
    const name = new URL(req.url).pathname.slice("/desktop/".length);
    const current = await release();
    if (name === "latest.json") {
      const origin = originOf(req.headers.get("host"));
      if (!origin) return new Response(null, { status: 400 });
      if (!current) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      return new Response(JSON.stringify(updaterManifest(current, origin)), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    // Only the current build and the zip; nothing else in the folder is ever served.
    const ok = name === ZIP ? current !== null : current !== null && name === current.file;
    if (!ok) return new Response("not found", { status: 404 });
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (!s.isFile()) throw new Error("not a file");
      return new Response(req.method === "HEAD" ? null : new Uint8Array(await readFile(path)), {
        headers: {
          "content-type": name === ZIP ? "application/zip" : "application/gzip",
          "content-length": String(s.size),
          "cache-control": name === ZIP ? "no-cache" : "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
          ...(name === ZIP ? { "content-disposition": 'attachment; filename="i.inc.zip"' } : {}),
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  };
}
