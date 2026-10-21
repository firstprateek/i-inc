#!/usr/bin/env node
// Runs every end-to-end script, tools/e2e/<name>/run.mjs, one after another, in Chromium.
//
//   pnpm e2e:install              # once: downloads the Chromium that the pinned Playwright drives
//   pnpm e2e                      # builds the web app, then runs every script
//   pnpm e2e projects ship        # only these
//   pnpm e2e --no-build           # the web app is already built (apps/web/dist)
//   pnpm e2e --out some/dir       # screenshots under some/dir/<name> (default e2e-out/<name>)
//
// Before anything runs, each script is checked for a way out of the repo: an absolute path to someone's home,
// a global `npm root -g` lookup, NODE_PATH. A script has to work from a clean clone with `pnpm install`, nothing
// borrowed from the machine it was written on. Exit code 1 when a script fails or breaks that rule.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/** What would take a script out of the repo, as [pattern, what it is]. */
const OUTSIDE = [
  [/\/(?:Users|home)\/[A-Za-z0-9._-]+\//, "an absolute path in someone's home"],
  [/\bnpm\b[^\n]*\broot\b[^\n]*-g\b|["']root["'],\s*["']-g["']/, "a lookup in the global npm folder"],
  [/\bNODE_PATH\b/, "NODE_PATH"],
  [/homedir\(\)|process\.env\.HOME\b(?!\s*=)/, "the home folder"],
];
const problems = [];
for (const name of chosen) {
  const file = join(here, name, "run.mjs");
  const text = readFileSync(file, "utf8");
  for (const [re, what] of OUTSIDE)
    if (re.test(text)) problems.push(`tools/e2e/${name}/run.mjs uses ${what}`);
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
    ? `\nFAILED: ${failed.join(", ")}. If the browser is missing, run: pnpm e2e:install`
    : `\nAll ${chosen.length} end-to-end script${chosen.length === 1 ? "" : "s"} passed.`,
);
process.exit(failed.length ? 1 : 0);
