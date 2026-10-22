#!/usr/bin/env node
// End-to-end run of the Brain changes feed (T58) in Chromium, against a local daemon whose brain agents have
// already written to (apps/daemon/scripts/e2e-brain-server.ts, in a scratch HOME): the Changes view in four
// sizes and themes, the filters, the one-click revert and its effect on the brain, and the checker.
//
//   pnpm --filter @i-inc/web build
//   node tools/e2e/brain/run.mjs [--out dir]
//
// Exit code 1 when anything fails.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const args = process.argv.slice(2);
const outDir = resolve(args[args.indexOf("--out") + 1] ?? "e2e-out");
mkdirSync(outDir, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "i-inc-e2e-brain-home-"));
const PORT = 7451;
const base = `http://127.0.0.1:${PORT}/`;
const failures = [];
const ok = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
};

const combos = [
  { name: "1440-light", width: 1440, height: 900, scheme: "light", phone: false },
  { name: "1440-dark", width: 1440, height: 900, scheme: "dark", phone: false },
  { name: "390-light", width: 390, height: 844, scheme: "light", phone: true },
  { name: "390-dark", width: 390, height: 844, scheme: "dark", phone: true },
];

const problems = () => {
  const out = [];
  if (document.documentElement.scrollWidth > innerWidth) out.push("the page scrolls sideways");
  const deep = (r) =>
    [...r.querySelectorAll("*")].flatMap((e) => [e, ...(e.shadowRoot ? deep(e.shadowRoot) : [])]);
  for (const el of deep(document)) {
    if (!el.matches?.("button, a[href], select")) continue;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height || getComputedStyle(el).position === "fixed") continue;
    if (innerWidth < 600 && b.height < 43.5 && b.width < 43.5)
      out.push(
        `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24)}" is ${Math.round(b.width)}x${Math.round(b.height)}`,
      );
  }
  return out;
};

const server = spawn("bun", [join(root, "apps/daemon/scripts/e2e-brain-server.ts")], {
  env: { ...process.env, HOME: home, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => {
  log += d;
});
server.stderr.on("data", (d) => {
  log += d;
});
for (let i = 0; i < 200 && !log.includes("ready"); i++) {
  if (server.exitCode !== null) throw new Error(`the server stopped:\n${log}`);
  await new Promise((r) => setTimeout(r, 100));
}
if (!log.includes("ready")) throw new Error(`the server didn't start:\n${log}`);

const api = (path, init) => fetch(`${base.slice(0, -1)}${path}`, init).then((r) => r.json());
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
try {
  const feed = (await api("/api/brain/changes")).changes;
  ok(feed.length >= 10, `the seeded brain has a feed (${feed.length} entries)`);

  for (const combo of combos) {
    console.log(`\n== ${combo.name}`);
    const ctx = await browser.newContext({
      viewport: { width: combo.width, height: combo.height },
      colorScheme: combo.scheme,
      hasTouch: combo.phone,
    });
    const page = await ctx.newPage();
    await page.goto(`${base}#/company/brain/changes`);
    await page.locator("inc-brain-changes").waitFor();
    await page.getByText("Brain changes").first().waitFor();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, `changes-${combo.name}.png`) });
    const found = await page.evaluate(problems);
    ok(
      found.length === 0,
      `${combo.name}: no sideways scroll, tap targets fine${found.length ? ` (${found.join("; ")})` : ""}`,
    );
    await ctx.close();
  }

  // ---- The flows, once, on the laptop. ----
  console.log("\n== flows");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on(
    "console",
    (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()),
  );
  await page.goto(`${base}#/company/brain`);
  await page.getByRole("link", { name: "Changes" }).click();
  await page.locator("inc-brain-changes").waitFor();
  ok(page.url().endsWith("#/company/brain/changes"), "the Brain page links to Changes");
  const entries = page.locator("inc-brain-changes ol > li");
  await entries.first().waitFor();
  const total = await entries.count();
  ok(total === feed.length, `every change is listed (${total})`);

  // Filter by employee, then by what.
  const selects = page.locator("inc-brain-changes select");
  await selects.nth(1).selectOption("kit");
  await page.waitForFunction(
    (n) =>
      document
        .querySelector("inc-app")
        .shadowRoot.querySelector("inc-brain-changes")
        .shadowRoot.querySelectorAll("ol > li").length < n,
    total,
  );
  ok(
    (await entries.count()) === feed.filter((c) => c.employee.id === "kit").length,
    "filtering by employee shows only their changes",
  );
  await selects.nth(1).selectOption("");
  await selects.nth(2).selectOption("rejected");
  await page.waitForFunction(() =>
    [
      ...document
        .querySelector("inc-app")
        .shadowRoot.querySelector("inc-brain-changes")
        .shadowRoot.querySelectorAll("ol > li"),
    ].every((e) => e.classList.contains("refused")),
  );
  ok(true, "filtering by what shows only refused changes, each with its reason");
  await selects.nth(2).selectOption("");

  // One-click revert of the page Ada added: the brain no longer has it.
  const flaky = feed.find((c) => c.slug === "facts/flaky-tests" && c.op === "create");
  const before = await api("/api/knowledge/handbook");
  ok(
    before.pages.some((p) => p.path === "facts/flaky-tests.md"),
    "the page is in the handbook before the revert",
  );
  await page
    .locator("inc-brain-changes ol > li", { hasText: "facts/flaky-tests" })
    .getByRole("button", { name: /Revert/ })
    .click();
  await page
    .locator("inc-brain-changes ol > li", { hasText: "facts/flaky-tests" })
    .getByText("reverted by owner")
    .waitFor();
  const after = await api("/api/knowledge/handbook");
  ok(!after.pages.some((p) => p.path === "facts/flaky-tests.md"), "the revert removed it from the handbook");
  const again = (await api("/api/brain/changes")).changes.find((c) => c.id === flaky.id);
  ok(again.reverted === true && again.revertible === false, "the feed says it was reverted by the owner");
  ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
  await page.screenshot({ path: join(outDir, "changes-after-revert.png") });
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
}

// ---- The checker: contrast, overlap, names, in every combination. ----
console.log("\n== ui-check");
const check = join(root, "tools/ui-check/check.mjs");
const server2 = spawn("bun", [join(root, "apps/daemon/scripts/e2e-brain-server.ts")], {
  env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "i-inc-e2e-brain-home-")), PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log2 = "";
server2.stdout.on("data", (d) => {
  log2 += d;
});
for (let i = 0; i < 200 && !log2.includes("ready"); i++) await new Promise((r) => setTimeout(r, 100));
try {
  for (const combo of combos) {
    const r = spawnSync(
      "node",
      [
        check,
        "--out",
        join(outDir, `ui-check-${combo.name}`),
        "--size",
        `${combo.width}x${combo.height}`,
        ...(combo.scheme === "dark" ? ["--dark"] : []),
        `${base}#/company/brain/changes`,
      ],
      { encoding: "utf8" },
    );
    const errs = `${r.stdout}`.split("\n").filter((l) => /^\s*error\b/.test(l));
    ok(
      r.status === 0 && errs.length === 0,
      `ui-check ${combo.name}${errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""}`,
    );
  }
} finally {
  server2.kill();
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall good");
