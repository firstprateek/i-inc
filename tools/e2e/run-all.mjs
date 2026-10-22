#!/usr/bin/env node
// Runs every end-to-end script, tools/e2e/<name>/run.mjs, one after another, in Chromium.
//
//   pnpm e2e:install              # once: downloads the Chromium that the pinned Playwright drives
//   pnpm e2e                      # builds the web app, then runs every script
//   pnpm e2e projects ship        # only these
//   pnpm e2e --no-build           # the web app is already built (apps/web/dist)
//   pnpm e2e --out some/dir       # screenshots under some/dir/<name> (default e2e-out/<name>)
//
// Before anything runs, each script is read for a way out of the repo (a best-effort scan of its text, not a
// sandbox): it may import only node built-ins, `playwright` by its bare name, and files inside the repo; it may
// not name an absolute path or a `file:` URL, a `../` path that leaves the repo, or read the home folder,
// NODE_PATH or the global npm folder. A script has to work from a clean clone with `pnpm install`, nothing
// borrowed from the machine it was written on. The servers it starts need `bun` on PATH.
// Exit code 1 when a script fails or breaks that rule.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  return args.splice(at, name === "--out" ? 2 : 1)[name === "--out" ? 1 : 0] ?? "";
};
const noBuild = flag("--no-build") !== undefined;
const outBase = resolve(flag("--out") ?? "e2e-out");
const wanted = args.filter((a) => !a.startsWith("-"));

const scripts = readdirSync(here, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(here, d.name, "run.mjs")))
  .map((d) => d.name)
  .sort();
const unknown = wanted.filter((w) => !scripts.includes(w));
if (unknown.length) {
  console.error(`No such script: ${unknown.join(", ")}. There are: ${scripts.join(", ")}.`);
  process.exit(2);
}
const chosen = wanted.length ? scripts.filter((s) => wanted.includes(s)) : scripts;

const inside = (p) => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !r.startsWith("/"));
};
const ROOTS =
  /^(?:\/(?:Users|home|opt|usr|var|private|tmp|etc|root|mnt|Volumes|Library|Applications|bin|sbin|nix)\b|~[/\\]|file:|[A-Za-z]:[\\/])/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'`])([^"'`\n]+)\1/g;
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n$])+)\1/g;
const ENV =
  /\bNODE_PATH\b|homedir\s*\(|\benv\s*(?:\.\s*HOME\b|\[\s*["'`]HOME["'`]\s*\])|["'`]root["'`]\s*,\s*["'`]-g["'`]|\broot\s+-g\b/;

/** Why a script reaches outside the repo, as a list of sentences (empty when it does not). */
function wayOut(file) {
  const text = readFileSync(file, "utf8");
  const dir = dirname(file);
  const found = [];
  for (const [, , spec] of text.matchAll(SPECIFIER)) {
    if (spec.startsWith(".")) {
      if (!inside(resolve(dir, spec))) found.push(`imports ${spec}, outside the repo`);
    } else if (spec !== "playwright" && !spec.startsWith("node:") && !builtinModules.includes(spec)) {
      found.push(`imports "${spec}" (only node built-ins, "playwright" and files in the repo)`);
    }
  }
  for (const [, , lit] of text.matchAll(LITERAL)) {
    if (ROOTS.test(lit)) found.push(`names ${lit.slice(0, 40)}, an absolute path`);
    else if (/^\.\.?\//.test(lit) && !inside(resolve(dir, lit))) found.push(`names ${lit}, outside the repo`);
  }
  if (ENV.test(text)) found.push("reads the home folder, NODE_PATH or the global npm folder");
  return [...new Set(found)];
}

const problems = [];
for (const name of chosen) {
  const file = join(here, name, "run.mjs");
  if (!/\bfrom\s*["']playwright["']/.test(readFileSync(file, "utf8")))
    problems.push(`tools/e2e/${name}/run.mjs does not import "playwright" by its bare name`);
  for (const w of wayOut(file)) problems.push(`tools/e2e/${name}/run.mjs ${w}`);
}
if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  console.error(
    "A script may use the repo's own node_modules and files, and temporary folders it makes itself.",
  );
  process.exit(1);
}

const run = (cmd, argv) => spawnSync(cmd, argv, { cwd: root, stdio: "inherit" }).status ?? 1;

if (!noBuild && run("pnpm", ["--filter", "@i-inc/web", "build"]) !== 0) {
  console.error("FAIL building the web app");
  process.exit(1);
}

const failed = [];
for (const name of chosen) {
  console.log(`\n=== e2e ${name} ===`);
  const code = run("node", [join("tools", "e2e", name, "run.mjs"), "--out", join(outBase, name)]);
  if (code !== 0) failed.push(name);
}
console.log(
  failed.length
    ? `\nFAILED: ${failed.join(", ")}. If Chromium would not start, run: pnpm e2e:install`
    : `\nAll ${chosen.length} end-to-end script${chosen.length === 1 ? "" : "s"} passed.`,
);
process.exit(failed.length ? 1 : 0);
