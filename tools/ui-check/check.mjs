#!/usr/bin/env node
// ui-check: render pages in Chromium and report layout problems a screenshot hides.
//
//   node tools/ui-check/check.mjs [--out dir] [--size 1440x900] [--dark] <file.html | url> ...
//
// For each page it saves a full-page screenshot and prints findings:
//   overlap     two visible leaf elements (text, images, icons, controls) intersect
//   covered     another element paints over text (probed with elementFromPoint)
//   clipped     an element is cut off by an ancestor with overflow hidden
//   overflow    text is wider than its box (not ellipsized), or taller than a fixed-height box
//   covered     (also) text still under a fixed or sticky bar once the page is scrolled to the end
//   sideways    the page is wider than the viewport, so it scrolls sideways (something spills out)
//   sparse      a tall box whose content ends before 60% of its height
//   near-miss   siblings whose edges are 1-3 px apart: almost aligned, so probably meant to be
//   target      a button, link or input smaller than 44 px in both directions
//   contrast    text below WCAG AA against its effective background
//   font        a declared web font was not used for rendering (Chrome DevTools Protocol)
//   name        a button or link with no accessible name (CDP accessibility tree)
//
// Exit code 1 when anything at "error" level is found. Uses the Chromium that Playwright finds;
// set PW_CHROMIUM to point at another executable.

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Use the workspace's Playwright once there is one; until then, the global install.
const { chromium, request } = await import("playwright").catch(() => {
  const root = execSync("npm root -g").toString().trim();
  return import(pathToFileURL(`${root}/playwright/index.mjs`).href);
});

const args = process.argv.slice(2);
let outDir = "ui-check-out";
let size = null;
let dark = false;
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") outDir = args[++i];
  else if (args[i] === "--size") size = args[++i];
  else if (args[i] === "--dark") dark = true;
  else targets.push(args[i]);
}
if (targets.length === 0) {
  console.error("usage: check.mjs [--out dir] [--size WxH] [--dark] <file.html | url> ...");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// Chromium connects directly, so pages on localhost load. When the environment has an HTTPS proxy
// (web fonts come over the network), HTTPS requests go through a Playwright request context that
// uses the proxy from Node, where its CA is trusted (NODE_EXTRA_CA_CERTS): certificates stay verified.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const outside = proxy ? await request.newContext({ proxy: { server: proxy } }) : null;
let errors = 0;

for (const target of targets) {
  const url = /^https?:|^file:/.test(target) ? target : pathToFileURL(resolve(target)).href;
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    colorScheme: dark ? "dark" : "light",
  });
  if (outside) {
    await page.route(/^https:/, async (route) => {
      const r = route.request();
      const res = await outside
        .fetch(r.url(), { method: r.method(), headers: r.headers() })
        .catch(() => null);
      await (res ? route.fulfill({ response: res }) : route.abort());
    });
  }
  const res = await page.goto(url, { waitUntil: "networkidle" }).catch((e) => e);
  if (res instanceof Error || (res && !res.ok() && !url.startsWith("file:"))) {
    console.log(
      `\n${target}\n  error load      the page didn't load: ${res instanceof Error ? res.message.split("\n")[0] : res.status()}`,
    );
    errors++;
    await page.close();
    continue;
  }
  await page.evaluate(() => document.fonts.ready);

  // Size the viewport to the page's fixed root (design artboards) unless told otherwise.
  const dims = size
    ? size.split("x").map(Number)
    : await page.evaluate(() => {
        // A design artboard's root is its first element with a fixed inline width.
        const root = document.querySelector('body [style*="width"]');
        const r = root?.getBoundingClientRect();
        return [Math.ceil(r?.width) || 1440, Math.ceil(r?.height) || 900];
      });
  await page.setViewportSize({ width: dims[0], height: dims[1] });

  const findings = await page.evaluate(auditInPage);
  findings.push(...(await cdpChecks(page)));
  findings.push(...(await page.evaluate(endOfPage)));
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) {
    findings.push({
      level: "error",
      kind: "sideways",
      msg: `the page is ${wide} px wider than the viewport, so it scrolls sideways`,
    });
  }

  const shot = `${outDir}/${basename(target).replace(/[^\w.-]+/g, "_")}${dark ? "-dark" : ""}.png`;
  await page.screenshot({ path: shot, fullPage: true });

  const errs = findings.filter((f) => f.level === "error");
  errors += errs.length;
  console.log(`\n${target}  (${dims[0]}x${dims[1]})  screenshot: ${shot}`);
  if (findings.length === 0) console.log("  no findings");
  for (const f of findings) console.log(`  ${f.level.padEnd(5)} ${f.kind.padEnd(9)} ${f.msg}`);
  await page.close();
}

await outside?.dispose();
await browser.close();
process.exit(errors > 0 ? 1 : 0);

// Chrome DevTools Protocol checks: fonts actually used, and accessible names.
async function cdpChecks(page) {
  const out = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });

  // Declared families vs the platform fonts Chrome really rendered with.
  const declared = await page.evaluate(() => {
    const fams = new Set();
    const deep = (root) =>
      [...root.querySelectorAll("*")].flatMap((el) => [el, ...(el.shadowRoot ? deep(el.shadowRoot) : [])]);
    for (const el of deep(document.body)) {
      const first = getComputedStyle(el).fontFamily.split(",")[0].trim().replace(/['"]/g, "");
      if (el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
        fams.add(first);
    }
    return [...fams];
  });
  const used = new Set();
  // Walk the tree, shadow roots included (Lit components render into them).
  const nodeIds = [];
  const walk = (n) => {
    if (n.nodeType === 1) nodeIds.push(n.nodeId);
    for (const k of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(k);
  };
  walk(root);
  for (const nodeId of nodeIds.slice(0, 1500)) {
    try {
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      for (const f of fonts) used.add(f.familyName);
    } catch {}
  }
  const generic = new Set(["system-ui", "sans-serif", "serif", "monospace", "inherit"]);
  for (const fam of declared) {
    if (generic.has(fam)) continue;
    if (![...used].some((u) => u.toLowerCase().startsWith(fam.toLowerCase())))
      out.push({
        level: "warn",
        kind: "font",
        msg: `"${fam}" is declared but Chrome rendered with ${[...used].join(", ")}`,
      });
  }

  // Accessible names from the accessibility tree.
  await cdp.send("Accessibility.enable");
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  for (const n of nodes) {
    const role = n.role?.value;
    if ((role === "button" || role === "link") && !n.ignored && !(n.name?.value ?? "").trim())
      out.push({ level: "error", kind: "name", msg: `a ${role} has no accessible name` });
  }
  return out;
}

// Runs inside the page: scrolled to the end, is anything still under a fixed bar? (Content may scroll
// under a bar; the last of it must clear it.)
function endOfPage() {
  scrollTo(0, document.documentElement.scrollHeight);
  const deep = (root) =>
    [...root.querySelectorAll("*")].flatMap((el) => [el, ...(el.shadowRoot ? deep(el.shadowRoot) : [])]);
  const parentOf = (el) => el.parentElement ?? el.getRootNode()?.host ?? null;
  const fixedOf = (el) => {
    for (let p = el; p; p = parentOf(p)) if (getComputedStyle(p).position === "fixed") return p;
    return null;
  };
  const all = deep(document.body);
  const bars = all.filter(
    (el) => getComputedStyle(el).position === "fixed" && el.getBoundingClientRect().height > 2,
  );
  const out = [];
  for (const bar of bars) {
    const b = bar.getBoundingClientRect();
    for (const el of all) {
      if (fixedOf(el) || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || getComputedStyle(el).visibility === "hidden") continue;
      const w = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const h = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      if (w > 2 && h > 2) {
        const text = el.textContent.trim().replace(/\s+/g, " ").slice(0, 40);
        out.push({
          level: "error",
          kind: "covered",
          msg: `"${text}" stays under a fixed bar at the end of the page`,
        });
      }
    }
  }
  scrollTo(0, 0);
  return out;
}

// Runs inside the page.
function auditInPage() {
  const out = [];
  const add = (level, kind, el, msg) => out.push({ level, kind, msg: `${describe(el)}: ${msg}` });
  const describe = (el) => {
    const text = (el.innerText || el.getAttribute("aria-label") || el.tagName).trim().replace(/\s+/g, " ");
    return `<${el.tagName.toLowerCase()}> "${text.slice(0, 40)}"`;
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // Skip hidden elements and screen-reader-only ones (1 px boxes).
    return (
      s.visibility !== "hidden" &&
      s.display !== "none" &&
      Number(s.opacity) > 0.05 &&
      r.width > 2 &&
      r.height > 2
    );
  };
  // Shadow roots are part of the page: Lit components render into them.
  const deep = (root) =>
    [...root.querySelectorAll("*")].flatMap((el) => [el, ...(el.shadowRoot ? deep(el.shadowRoot) : [])]);
  const parentOf = (el) => el.parentElement ?? el.getRootNode()?.host ?? null;
  const holds = (a, b) => {
    for (let p = b; p; p = parentOf(p)) if (p === a) return true;
    return false;
  };
  const upTo = (el, sel) => {
    for (let p = el; p; p = parentOf(p)) if (p.matches?.(sel)) return p;
    return null;
  };
  const kidsOf = (el) => [...el.children, ...(el.shadowRoot ? el.shadowRoot.children : [])];
  // Fixed and sticky bars cover whatever scrolls under them; that's checked at the end of the page.
  const pinned = (el) => {
    for (let p = el; p; p = parentOf(p))
      if (["fixed", "sticky"].includes(getComputedStyle(p).position)) return true;
    return false;
  };
  const pointAt = (x, y) => {
    let e = document.elementFromPoint(x, y);
    while (e?.shadowRoot) {
      const inner = e.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e;
  };
  const els = deep(document.body).filter(
    (el) =>
      !["SCRIPT", "STYLE", "LINK", "HELMET"].includes(el.tagName) &&
      !el.closest("svg")?.parentElement?.closest("svg") &&
      !(el.closest("svg") && el.tagName !== "svg") &&
      visible(el),
  );
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const isLeaf = (el) =>
    ownText(el) || ["IMG", "svg", "INPUT", "BUTTON", "SELECT", "TEXTAREA"].includes(el.tagName);
  const leaves = els.filter(
    (el) =>
      isLeaf(el) && !el.closest("svg:not(:scope)") && !(parentOf(el) && upTo(parentOf(el), "button, svg")),
  );

  // overlap: leaf elements that intersect and are not nested.
  const rects = leaves.map((el) => [el, textRect(el)]);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [a, ra] = rects[i];
      const [b, rb] = rects[j];
      if (holds(a, b) || holds(b, a) || pinned(a) !== pinned(b)) continue;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && h > 2)
        add("error", "overlap", a, `overlaps ${describe(b)} by ${Math.round(w)}x${Math.round(h)} px`);
    }
  }

  // covered: text that another element paints over. Probe points inside the text itself.
  for (const [el, r] of rects) {
    if (!ownText(el)) continue;
    const probes = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 2, r.top + r.height / 2],
      [r.right - 2, r.top + r.height / 2],
    ];
    for (const [x, y] of probes) {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const top = pointAt(x, y);
      if (top && top !== el && !holds(el, top) && !holds(top, el) && pinned(top) === pinned(el)) {
        add("error", "covered", el, `text is painted over by ${describe(top)}`);
        break;
      }
    }
  }

  for (const el of els) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();

    // overflow: text that runs past its box's content area (into the padding, or out of the box).
    if (ownText(el) && s.textOverflow !== "ellipsis") {
      const t = textRect(el);
      const px = (v) => Number.parseFloat(v) || 0;
      const content = {
        left: r.left + px(s.borderLeftWidth) + px(s.paddingLeft),
        right: r.right - px(s.borderRightWidth) - px(s.paddingRight),
        top: r.top + px(s.borderTopWidth) + px(s.paddingTop),
        bottom: r.bottom - px(s.borderBottomWidth) - px(s.paddingBottom),
      };
      const past = Math.max(
        t.bottom - content.bottom,
        t.right - content.right,
        content.top - t.top,
        content.left - t.left,
      );
      const outside = Math.max(t.bottom - r.bottom, t.right - r.right);
      // Glyphs of tightly set large type poke out a little; allow for it.
      if (outside > Math.max(1, px(s.fontSize) * 0.12))
        add("error", "overflow", el, `text runs ${Math.round(outside)} px outside its box`);
      else if (past > Math.max(1.5, px(s.fontSize) * 0.12))
        add(
          "warn",
          "overflow",
          el,
          `text runs ${Math.round(past)} px into the padding (it wrapped or is too big)`,
        );
    }

    // sparse: a tall grid cell (a card in a grid) whose content ends before 60% of its height.
    // Columns and sidebars are allowed to be empty at the bottom.
    const up = parentOf(el);
    if (r.height > 240 && kidsOf(el).length && up && getComputedStyle(up).display.includes("grid")) {
      const bottom = Math.max(...kidsOf(el).map((k) => k.getBoundingClientRect().bottom));
      const used = (bottom - r.top) / r.height;
      if (used < 0.6 && !ownText(el))
        add(
          "warn",
          "sparse",
          el,
          `content fills only ${Math.round(used * 100)}% of its ${Math.round(r.height)} px height`,
        );
    }

    // clipped: cut off by an ancestor that hides overflow.
    for (let p = parentOf(el); p && p !== document.body; p = parentOf(p)) {
      const ps = getComputedStyle(p);
      if (ps.overflow === "visible" && ps.overflowX === "visible" && ps.overflowY === "visible") continue;
      const pr = p.getBoundingClientRect();
      const cut = Math.max(pr.left - r.left, r.right - pr.right, pr.top - r.top, r.bottom - pr.bottom);
      if (cut > 1 && isLeaf(el) && r.top < pr.bottom && r.left < pr.right)
        add("warn", "clipped", el, `cut off by ${Math.round(cut)} px (partly visible)`);
      break;
    }

    // overflow: text wider than its box, unless ellipsized on purpose.
    if (
      ownText(el) &&
      el.scrollWidth > el.clientWidth + 1 &&
      s.textOverflow !== "ellipsis" &&
      s.overflow !== "visible"
    )
      add("error", "overflow", el, `text is ${el.scrollWidth - el.clientWidth} px wider than its box`);

    // target: small interactive controls.
    if (
      el.matches("button, a[href], input:not([type=checkbox]):not([type=radio]), select") &&
      r.width < 44 &&
      r.height < 44
    )
      add("warn", "target", el, `only ${Math.round(r.width)}x${Math.round(r.height)} px`);

    // contrast: text vs effective background.
    if (ownText(el)) {
      const fg = rgba(s.color);
      const bg = backgroundOf(el);
      if (fg && bg) {
        const ratio = contrast(blend(fg, bg), bg);
        const size = Number.parseFloat(s.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
        const need = large ? 3 : 4.5;
        if (ratio < need) add("error", "contrast", el, `${ratio.toFixed(2)}:1, needs ${need}:1`);
      }
    }
  }

  // near-miss: siblings that are almost aligned. Stacked siblings should share a left edge;
  // side-by-side boxes of similar height should share a top edge. 1-3 px apart is probably a slip.
  const inFlow = (el) => !["absolute", "fixed"].includes(getComputedStyle(el).position);
  for (const parent of new Set(els.map(parentOf).filter(Boolean))) {
    const kids = kidsOf(parent).filter((k) => els.includes(k) && inFlow(k) && k.tagName !== "svg");
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect();
        const b = kids[j].getBoundingClientRect();
        const stacked = a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
        const similar = Math.abs(a.height - b.height) <= 0.2 * Math.max(a.height, b.height);
        // In a row, compare the edge the parent aligns on: centres for align-items: center.
        const align = getComputedStyle(parent).alignItems;
        if (!stacked && align === "baseline") continue;
        const edge = stacked ? "left" : align === "center" ? "middle" : similar ? "top" : null;
        if (!edge) continue;
        const at = (q) => (edge === "middle" ? q.top + q.height / 2 : q[edge]);
        const d = Math.abs(at(a) - at(b));
        if (d >= 1 && d <= 3)
          add("warn", "near-miss", kids[i], `${edge} edge is ${d.toFixed(1)} px off ${describe(kids[j])}`);
      }
    }
  }
  return out;

  function textRect(el) {
    if (!ownText(el)) return el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect();
  }
  function rgba(str) {
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    return [r, g, b, a];
  }
  function backgroundOf(el) {
    let color = [255, 255, 255, 0];
    const stack = [];
    for (let p = el; p; p = parentOf(p)) {
      const c = rgba(getComputedStyle(p).backgroundColor);
      if (c && c[3] > 0) {
        stack.push(c);
        if (c[3] >= 1) break;
      }
    }
    color = [255, 255, 255, 1];
    for (const c of stack.reverse()) color = blend(c, color);
    return color;
  }
  function blend([r, g, b, a], [R, G, B]) {
    return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
  }
  function lum([r, g, b]) {
    const f = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrast(a, b) {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  }
}
