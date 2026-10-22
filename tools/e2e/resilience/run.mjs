#!/usr/bin/env node
// End-to-end check that a daemon outage doesn't wipe the owner's work (T63): in Chromium, against a demo daemon
// in a scratch home, type a name in Company -> Team -> Hire someone, stop the daemon for a few seconds, and check
// the same form (and its text) is still on screen under a "Can't reach i.inc" banner; start the daemon again
// and check the banner goes and the text is still there. Also loads a deep link with a broken escape, which used
// to leave a blank page.
//
//   pnpm --filter @i-inc/web build
//   node tools/e2e/resilience/run.mjs [--out dir]
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
const home = mkdtempSync(join(tmpdir(), "i-inc-e2e-home-"));
const PORT = 7451;
const base = `http://127.0.0.1:${PORT}`;
const failures = [];
const ok = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
};

/** Starts the demo daemon and waits until it answers. Only this run's own PID is ever killed. */
async function start() {
  const child = spawn("bun", [join(root, "apps/daemon/src/main.ts")], {
    env: { ...process.env, I_INC_HOME: home, I_INC_DEMO: "1", PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("the daemon stopped");
    try {
      if ((await fetch(`${base}/api/health`)).ok) return child;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the daemon didn't start");
}
const stop = (child) =>
  new Promise((r) => {
    child.once("exit", r);
    child.kill();
  });

let daemon = await start();
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(`${base}/#/company/team/hiring`);
  const name = page.getByLabel("Name").first();
  await name.waitFor();
  await name.fill("Half-typed Nell");
  const handle = await name.elementHandle();

  await stop(daemon);
  // Anything that asks the daemon notices; the live stream's reconnect does.
  await page.waitForSelector("inc-offline", { timeout: 30000 });
  await page.screenshot({ path: join(outDir, "offline.png") });
  ok(true, "the offline banner appears");
  ok(
    await handle.evaluate((el) => el.isConnected && el.value === "Half-typed Nell"),
    "the same form field is still on the page, with its text",
  );

  daemon = await start();
  await page.waitForSelector("inc-offline", { state: "detached", timeout: 30000 });
  ok(
    await handle.evaluate((el) => el.isConnected && el.value === "Half-typed Nell"),
    "after the daemon is back, the banner is gone and the text is still there",
  );
  await page.screenshot({ path: join(outDir, "recovered.png") });

  // A truncated escape in a link used to throw while the app started: a blank page.
  await page.goto(`${base}/#/conversations/new/%E0%A4%A`);
  await page.reload();
  await page.waitForSelector("inc-app", { timeout: 10000 });
  ok(
    await page.evaluate(() => document.querySelector("inc-app")?.shadowRoot?.querySelector("main") != null),
    "a malformed link opens the app instead of a blank page",
  );
} finally {
  await browser.close();
  await stop(daemon).catch(() => {});
}
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
