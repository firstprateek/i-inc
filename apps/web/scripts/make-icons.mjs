#!/usr/bin/env node
// Renders public/icon.svg to the PNG icons the manifest and iOS need, using Playwright's Chromium
// (the same one tools/ui-check uses). Run it when icon.svg changes and commit the PNGs:
//
//   node apps/web/scripts/make-icons.mjs
//
// Uses the repo's pinned Playwright (`pnpm install`, then `pnpm e2e:install` for its Chromium).
// Set PW_CHROMIUM to use another Chromium executable.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const out = join(dirname(fileURLToPath(import.meta.url)), "../public/icons");
mkdirSync(out, { recursive: true });

const ink = "#1E2421";
const ground = "#EEF0EA";
const mark = (size) =>
  `<text x="32" y="42" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="700" font-size="${size}" fill="${ground}">i.i</text>`;

// "any" icons keep the rounded corners of icon.svg.
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${ink}"/>${mark(26)}</svg>`;
// Maskable and Apple icons are full-bleed squares (the OS rounds them), with the mark well inside the
// maskable safe zone, a circle of 80% of the width.
const bleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${ink}"/>${mark(26)}</svg>`;

const icons = [
  ["icon-192.png", 192, rounded],
  ["icon-512.png", 512, rounded],
  ["icon-maskable-512.png", 512, bleed],
  ["apple-touch-icon.png", 180, bleed],
];

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
for (const [name, px, svg] of icons) {
  const page = await browser.newPage({ viewport: { width: px, height: px } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${px}px;height:${px}px}</style>${svg}`,
  );
  await page.screenshot({ path: join(out, name), omitBackground: true });
  await page.close();
  console.log(`wrote public/icons/${name}`);
}
await browser.close();
