import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";

/**
 * Fills the service worker's two placeholders in dist/sw.js once the build is written: the list of
 * files to precache (index.html, every hashed asset, the manifest and icons) and a build id made from
 * their contents, so the cache name changes exactly when something the shell holds has changed.
 */
function precachePlugin(): Plugin {
  let outDir = "dist";
  return {
    name: "i-inc-precache",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "post",
      handler() {
        const files = listFiles(outDir)
          .filter((f) => f !== "sw.js" && !/\.(br|gz)$/.test(f))
          .sort();
        const urls = files.map((f) => `/${f}`);
        const hash = createHash("sha256");
        for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
        const sw = join(outDir, "sw.js");
        const source = readFileSync(sw, "utf8")
          .replace('"__BUILD_ID__"', JSON.stringify(hash.digest("hex").slice(0, 12)))
          .replace('"__PRECACHE__"', JSON.stringify(urls));
        writeFileSync(sw, source);
      },
    },
  };
}

/** What compresses (text); images and fonts are already compressed. Kept in step with apps/daemon/src/web-static.ts. */
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

/**
 * Writes `<file>.br` and `<file>.gz` beside every text file in the build, after the service worker is filled
 * in, so the daemon sends the smallest form the browser accepts without compressing anything per request.
 * A copy is kept only when it is smaller than the file.
 */
function compressPlugin(): Plugin {
  let outDir = "dist";
  return {
    name: "i-inc-compress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "post",
      handler() {
        /** What each copy was made from and is, so the daemon trusts a copy by content and not by its date. */
        const manifest: Record<string, { src: string; br?: string; gz?: string }> = {};
        const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
        for (const f of listFiles(outDir)) {
          if (!COMPRESSIBLE.has(extname(f)) || /\.(br|gz)$/.test(f)) continue;
          const path = join(outDir, f);
          const raw = readFileSync(path);
          if (raw.length < 1024) continue;
          const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
          const gz = gzipSync(raw, { level: 9 });
          const entry: { src: string; br?: string; gz?: string } = { src: sha(raw) };
          if (br.length < raw.length) {
            writeFileSync(`${path}.br`, br);
            entry.br = sha(br);
          }
          if (gz.length < raw.length) {
            writeFileSync(`${path}.gz`, gz);
            entry.gz = sha(gz);
          }
          manifest[f] = entry;
        }
        writeFileSync(join(outDir, "precompressed.json"), JSON.stringify(manifest));
      },
    },
  };
}

function listFiles(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path, root) : [relative(root, path).split(sep).join("/")];
  });
}

// In development the API comes from the daemon; in production the daemon serves this build.
export default defineConfig({
  plugins: [precachePlugin(), compressPlugin()],
  server: { proxy: { "/api": "http://127.0.0.1:7420" } },
  build: { outDir: "dist", emptyOutDir: true },
});
