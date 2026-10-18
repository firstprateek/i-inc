#!/usr/bin/env node
// Focused regression check for viewport clipping and scroll-container end checks.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtures = [
  "fixtures/clipped-shadow-content.html",
  "fixtures/visible-overlap.html",
  "fixtures/grid-row-underlap.html",
  "fixtures/grid-row-cleared.html",
  "fixtures/text-overflow.html",
  "fixtures/below-fold-audits.html",
  "fixtures/viewport-at-load.html",
].map((name) => resolve(here, name));
const result = spawnSync(
  process.execPath,
  [resolve(here, "check.mjs"), "--size", "400x300", "--out", "/tmp/ui-check-regression", ...fixtures],
  { encoding: "utf8", env: process.env },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
if (result.error) throw result.error;
if (result.status !== 1)
  throw new Error(`expected intentional findings (exit 1), got ${result.status}\n${output}`);
const section = (name) => {
  const at = output.indexOf(name);
  if (at < 0) return "";
  const start = output.lastIndexOf("\n", at) + 1;
  const next = output.indexOf("\n\n", at);
  return output.slice(start, next < 0 ? output.length : next);
};
if (/\n[ \t]+error[ \t]+overlap/.test(section("clipped-shadow-content.html")))
  throw new Error(`clipped shadow content was reported as overlap\n${output}`);
if (/\n[ \t]+error[ \t]+covered/.test(section("clipped-shadow-content.html")))
  throw new Error(`clipped shadow content was reported as covered\n${output}`);
if (!/\n[ \t]+error[ \t]+overlap/.test(section("visible-overlap.html")))
  throw new Error(`visible overlap was not reported\n${output}`);
if (!/\n[ \t]+error[ \t]+covered[^\n]*Last content under tabs/.test(section("grid-row-underlap.html")))
  throw new Error(`last content under the grid-row tabs was not reported\n${output}`);
if (/\n[ \t]+error[ \t]+covered/.test(section("grid-row-cleared.html")))
  throw new Error(`content that clears the grid-row tabs was reported as covered\n${output}`);
if (!/\n[ \t]+error[ \t]+overflow/.test(section("text-overflow.html")))
  throw new Error(`visible text overflow was not reported\n${output}`);
if (!/\n[ \t]+warn[ \t]+clipped/.test(section("clipped-shadow-content.html")))
  throw new Error(`partial top/left clipping was not reported\n${output}`);
if (!/\n[ \t]+error[ \t]+overflow/.test(section("below-fold-audits.html")))
  throw new Error(`below-fold text overflow was not reported\n${output}`);
if (!/\n[ \t]+error[ \t]+contrast/.test(section("below-fold-audits.html")))
  throw new Error(`below-fold low contrast was not reported\n${output}`);
if (/\n[ \t]+error[ \t]+contrast/.test(section("viewport-at-load.html")))
  throw new Error(`the requested viewport was not set before page startup\n${output}`);
console.log("ui-check clipping and scroll-end regressions passed");
