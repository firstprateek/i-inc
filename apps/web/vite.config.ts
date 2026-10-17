import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
      outDir = join(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "post",
      handler() {
        const files = listFiles(outDir)
          .filter((f) => f !== "sw.js")
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

function listFiles(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path, root) : [relative(root, path).split(sep).join("/")];
  });
}

// In development the API comes from the daemon; in production the daemon serves this build.
export default defineConfig({
  plugins: [precachePlugin()],
  server: { proxy: { "/api": "http://127.0.0.1:7420" } },
  build: { outDir: "dist", emptyOutDir: true },
});
