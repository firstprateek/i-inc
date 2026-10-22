#!/usr/bin/env node
// End-to-end run of "Open the session" (T69) in Chromium, against a local daemon in a scratch HOME
// (apps/daemon/scripts/e2e-session-server.ts): the real pipeline runs a ticket's plan stage, whose scripted agent works
// in three steps that the run lets happen one at a time.
//
//   pnpm --filter @i-inc/web build
//   node tools/e2e/ticket-session/run.mjs [--out dir]
//
// It checks, in the real app:
//   1. the ticket page links the running stage with "Open the session";
//   2. the session opens read-only in the conversation thread, live: "Watching #N · plan", no composer;
//   3. parts stream in as the stage works (text, plan, a read, an edit with its diff, usage), and the context
//      panel lists the plan and the file changed;
//   4. the stage ends and the view says Finished;
//   5. a reload replays it, and so does a reload after the daemon restarted;
//   6. on a phone it is one column, Back returns to the ticket, and the context is a sheet.
// Exit code 1 when anything fails.
import { spawn } from "node:child_process";
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
const home = mkdtempSync(join(tmpdir(), "i-inc-e2e-session-"));
const PORT = Number(process.env.E2E_PORT ?? 7462);
const base = `http://127.0.0.1:${PORT}`;

const failures = [];
const ok = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures.push(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(60);
  }
}

let server;
let log = "";
async function start() {
  log = "";
  server = spawn("bun", [join(root, "apps/daemon/scripts/e2e-session-server.ts")], {
    env: { ...process.env, I_INC_HOME: home, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => {
    log += d;
  });
  server.stderr.on("data", (d) => {
    log += d;
  });
  await until(() => log.includes("e2e daemon on"), "the daemon to start", 30_000);
}
const stop = async () => {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await until(() => server.exitCode !== null || server.signalCode, "the daemon to stop", 10_000).catch(
    () => {},
  );
};
process.on("exit", () => server?.kill("SIGTERM"));

const control = (op) =>
  fetch(`${base}/__e2e`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op }),
  }).then((r) => r.json());
const getJson = (path) => fetch(`${base}${path}`).then((r) => r.json());

let browser;
try {
  await start();
  const { id } = await control("run");
  const plan = await until(
    async () =>
      (await getJson(`/api/tickets/${id}/sessions`)).sessions.find((s) => s.stage === "plan" && s.channel),
    "the plan stage's session",
  );
  ok(Number.isInteger(plan.id), `the plan stage is session ${plan.id} of ticket #${id}`);
  await until(async () => (await control("poll")).taken >= 1, "the first step");

  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
  });
  const page = await desktop.newPage();

  // 1. The ticket page links the stage.
  await page.goto(`${base}/#/ticket/${id}`);
  const link = page.locator("inc-transcript a.open-session").first();
  await link.waitFor({ timeout: 15_000 });
  ok(
    (await link.textContent()).includes("Open the session"),
    "the ticket page offers 'Open the session' on the running stage",
  );
  ok(
    (await link.getAttribute("href")) === `#/ticket/${id}/session/${plan.id}`,
    "it links to the session's address",
  );
  await page.screenshot({ path: join(outDir, "ticket-1440.png") });

  // 2. Opened, it is the read-only thread, live.
  await link.click();
  const title = page.locator("inc-conv-thread .head .title");
  await title.waitFor({ timeout: 15_000 });
  ok(
    (await title.textContent()).trim() === `Watching #${id} · plan`,
    `the header says "${(await title.textContent()).trim()}"`,
  );
  const status = page.locator("inc-conv-thread .head .status");
  await until(async () => (await status.textContent()).includes("Live"), "the Live mark");
  ok(true, "a live mark shows while the stage runs");
  ok((await page.locator("inc-conv-composer").count()) === 0, "there is no composer");
  ok(
    (await page.locator("inc-conv-thread .ro-note").textContent()).includes("Read-only"),
    "it says it is read-only",
  );

  // 3. Parts stream in as the stage works.
  await page.getByText("Looking at the spending sum.").first().waitFor({ timeout: 15_000 });
  ok(true, "the first words of the stage are there");
  ok(
    (await page.getByText("Find where refunds are counted").count()) > 0,
    "the plan shows in the context panel",
  );
  ok((await page.getByText("Files changed").count()) === 0, "no files changed yet");
  await page.screenshot({ path: join(outDir, "live-1-1440.png") });
  await control("step");
  await page.getByText("Read src/spending.ts").first().waitFor({ timeout: 15_000 });
  await page.getByText("Files changed · 1").first().waitFor({ timeout: 15_000 });
  ok(true, "the read and the edit arrive, and the context panel lists the file changed");
  ok((await status.textContent()).includes("Live"), "still live between steps");
  await page.screenshot({ path: join(outDir, "live-2-1440.png") });
  await control("step");
  await page.getByText("Approach: ignore refunds in the sum.").first().waitFor({ timeout: 15_000 });
  await until(async () => (await status.textContent()).includes("Finished"), "Finished");
  ok(true, "the stage ends and the view says Finished");
  await page
    .getByText("1,800")
    .first()
    .waitFor({ timeout: 5_000 })
    .catch(() => {});
  await page.screenshot({ path: join(outDir, "finished-1440.png") });

  // 4. A reload replays it from the store.
  await page.reload();
  await page.getByText("Approach: ignore refunds in the sum.").first().waitFor({ timeout: 15_000 });
  ok(
    (await page.locator("inc-conv-thread .head .status").textContent()).includes("Finished"),
    "after a reload the finished stage replays",
  );
  ok((await page.locator("inc-conv-composer").count()) === 0, "still no composer");

  // 5. And after the daemon restarted.
  await stop();
  await start();
  await page.reload();
  await page.getByText("Approach: ignore refunds in the sum.").first().waitFor({ timeout: 20_000 });
  await page.getByText("Read src/spending.ts").first().waitFor({ timeout: 5_000 });
  ok(true, "after the daemon restarted the stage replays from its store, parts and all");

  // 6. A phone: one column, Back to the ticket, the context as a sheet.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
    isMobile: true,
    hasTouch: true,
  });
  const p = await phone.newPage();
  await p.goto(`${base}/#/ticket/${id}`);
  await p.locator("inc-transcript a.open-session").first().waitFor({ timeout: 15_000 });
  await p.locator("inc-transcript a.open-session").first().click();
  await p.locator("inc-conv-thread .head .title").waitFor({ timeout: 15_000 });
  await p.getByText("Approach: ignore refunds in the sum.").first().waitFor({ timeout: 15_000 });
  const sideways = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  ok(!sideways, "no sideways scroll on a phone");
  ok(
    (await p.locator("inc-ticket-session aside").count()) === 0,
    "the context is not beside the thread on a phone",
  );
  await p.screenshot({ path: join(outDir, "session-390.png") });
  await p.locator('inc-conv-thread [aria-label="Context panel"]').click();
  await p.locator("inc-ticket-session .sheet").waitFor({ timeout: 5_000 });
  await p.getByText("Files changed · 1").first().waitFor({ timeout: 5_000 });
  ok(true, "the context opens as a sheet with the file changed");
  await p.screenshot({ path: join(outDir, "sheet-390.png") });
  await p.keyboard.press("Escape");
  await p.locator("inc-ticket-session .sheet").waitFor({ state: "detached", timeout: 5_000 });
  await p.locator("inc-conv-thread .back").click();
  await p.locator("inc-transcript a.open-session").first().waitFor({ timeout: 15_000 });
  ok(p.url().endsWith(`#/ticket/${id}`), "Back returns to the ticket");
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.log(`  FAIL ${e?.message ?? e}`);
  console.log(log.split("\n").slice(-15).join("\n"));
} finally {
  await browser?.close();
  await stop();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall ok");
process.exit(failures.length ? 1 : 0);
