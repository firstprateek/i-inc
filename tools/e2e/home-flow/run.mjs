#!/usr/bin/env node
// End-to-end run of the owner's first minutes (T64) in Chromium, against the daemon in demo mode (I_INC_DEMO=1:
// the scripted agent, a morning of tickets, and the scripted conversation agent of src/demo-agent.ts), in a
// scratch HOME. No sandbox, network or tokens.
//
//   pnpm --filter @i-inc/web build
//   node tools/e2e/home-flow/run.mjs [--out dir]
//
// It checks, in the real app, at 1440x900 and 390x844:
//   1. Needs you is ONE destination: the top-bar link (laptop) or the bottom tab (phone) opens #/needs-you, the old
//      #/work/needs-you and #/inbox addresses land there, and Work keeps only Board and Releases;
//   2. the New conversation screen: one centred composer with the employee, project and mode pickers, and the
//      left list's "No conversations yet" as a small line (laptop);
//   3. the Getting started card does not shift the layout: with its data held back, the composer and the heading
//      stay where they are when it appears, and it sits below the composer;
//   4. no document scroll and no sideways overflow, and every control 44px tall on the phone;
//   5. a first message makes the conversation (the address changes only then), the demo agent streams a reply
//      with a tool call and a permission card, and answering it finishes the turn.
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
const home = mkdtempSync(join(tmpdir(), "i-inc-e2e-home-"));
const PORT = 7463;
const base = `http://127.0.0.1:${PORT}`;

const failures = [];
const ok = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures.push(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 10_000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// The daemon, started here; only this PID is ever stopped.
const server = spawn("bun", [join(root, "apps/daemon/src/main.ts")], {
  env: { ...process.env, HOME: home, I_INC_HOME: home, I_INC_DEMO: "1", PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => {
  log += d;
});
server.stderr.on("data", (d) => {
  log += d;
});
const stop = () => server.kill("SIGTERM");
process.on("exit", stop);

/** Inside the page: how the document sits in the window (no document scroll, no sideways overflow). */
const fit = () => ({
  vertical: document.documentElement.scrollHeight - window.innerHeight,
  horizontal: document.documentElement.scrollWidth - window.innerWidth,
});
/** Inside the page: visible controls (through shadow roots) shorter than 44px. */
const smallTargets = () => {
  const all = (node, sel, out = []) => {
    out.push(...(node.querySelectorAll?.(sel) ?? []));
    for (const child of node.querySelectorAll?.("*") ?? [])
      if (child.shadowRoot) all(child.shadowRoot, sel, out);
    return out;
  };
  return all(document, "button, a[href], select, textarea, [role=tab]")
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        r.width > 1 &&
        r.height > 1 &&
        s.visibility !== "hidden" &&
        s.display !== "none" &&
        !el.closest("[hidden]")
      );
    })
    .filter((el) => el.getBoundingClientRect().height < 43.5)
    .map(
      (el) =>
        `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().height)}px`,
    );
};

let browser;
try {
  await until(() => log.includes("daemon") && log.includes("demo mode"), 30_000, "the daemon to start");
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});

  for (const [name, viewport, mobile] of [
    ["laptop", { width: 1440, height: 900 }, false],
    ["phone", { width: 390, height: 844 }, true],
  ]) {
    console.log(`\n${name} ${viewport.width}x${viewport.height}`);
    const ctx = await browser.newContext({
      viewport,
      serviceWorkers: "block",
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await ctx.newPage();
    // Hold back what the Getting started card waits for, so it appears well after everything else.
    await page.route("**/api/github/repos", async (route) => {
      await sleep(1500);
      await route.continue();
    });

    // 3. The card appears late, and nothing above it moves.
    await page.goto(`${base}/#/conversations`);
    const composer = page.locator("inc-conv-composer textarea");
    await composer.waitFor({ timeout: 15_000 });
    const heading = page.locator("inc-conv-draft .draft > h2");
    const before = { composer: await composer.boundingBox(), heading: await heading.boundingBox() };
    const card = page.locator("inc-getting-started section");
    ok(!(await card.isVisible()), "the Getting started card is not there while it loads");
    await card.waitFor({ state: "visible", timeout: 15_000 });
    const after = { composer: await composer.boundingBox(), heading: await heading.boundingBox() };
    const moved = Math.max(
      Math.abs(before.composer.y - after.composer.y),
      Math.abs(before.heading.y - after.heading.y),
      Math.abs(before.composer.x - after.composer.x),
    );
    ok(moved < 0.5, `the composer and heading did not move when the card appeared (${moved}px)`);
    const cardBox = await card.boundingBox();
    ok(cardBox.y >= after.composer.y + after.composer.height, "the card sits below the composer");
    await page.screenshot({ path: join(outDir, `new-conversation-${viewport.width}.png`) });

    // 2. The New conversation screen.
    ok(
      (await page.locator("inc-conv-draft .draft > h2").textContent()) === "Start a conversation",
      "one empty state, in the centre",
    );
    ok((await page.locator("inc-conv-draft select").count()) >= 2, "employee and project pickers are there");
    ok(
      (await page.locator("inc-conv-composer .pickers select").count()) === 1,
      "the mode picker is in the composer",
    );
    ok(
      (await page.locator("inc-conv-composer .pickers select").getAttribute("aria-label")).startsWith(
        "Mode: ",
      ),
      "the mode picker says which mode",
    );
    if (!mobile) {
      ok(
        (await page.locator("inc-conv-list p.none").textContent()) === "No conversations yet.",
        "the list says so in one small line",
      );
      ok((await page.locator("inc-conv-list form").count()) === 0, "there is no form in the left column");
    }

    // 4. Fit.
    const f = await page.evaluate(fit);
    ok(
      f.vertical <= 0 && f.horizontal <= 0,
      `no document scroll or sideways overflow (${JSON.stringify(f)})`,
    );
    if (mobile) {
      const small = await page.evaluate(smallTargets);
      ok(small.length === 0, `every control is 44px tall${small.length ? `: ${small.join("; ")}` : ""}`);
    }

    // 1. Needs you is one destination.
    if (mobile) {
      await page.locator('.tabs button:has-text("Needs you")').click();
    } else {
      await page.locator("header a.needs-link").click();
    }
    await page.waitForFunction(() => location.hash === "#/needs-you");
    await page.locator("#view-heading", { hasText: "Needs you" }).waitFor();
    ok((await page.locator("#view-heading").textContent()) === "Needs you", 'the page is titled "Needs you"');
    await page.waitForFunction(() => document.title === "Needs you · i.inc");
    ok(true, `the tab title is "${await page.title()}"`);
    ok((await page.locator('[role="tablist"].subnav').count()) === 0, "it has no tab row");
    const current = mobile
      ? await page.locator('.tabs button[aria-current="page"]').allTextContents()
      : await page.locator("header a.needs-link[aria-current=page]").allTextContents();
    ok(current.length === 1 && current[0].includes("Needs you"), "its link or tab is the current one");
    await page.screenshot({ path: join(outDir, `needs-you-${viewport.width}.png`) });
    for (const old of ["#/work/needs-you", "#/inbox"]) {
      await page.evaluate(() => {
        location.hash = "#/work/board";
      });
      await page.evaluate((h) => {
        location.hash = h;
      }, old);
      await page.waitForFunction(() => location.hash === "#/needs-you");
      ok(true, `${old} lands on #/needs-you`);
    }
    await page.evaluate(() => {
      location.hash = "#/work/board";
    });
    await page.locator('.subnav [role="tab"]').first().waitFor();
    const tabs = await page.locator('.subnav [role="tab"]').allTextContents();
    ok(tabs.join("|") === "Board|Releases", `Work has only Board and Releases (${tabs.join("|")})`);

    await ctx.close();
  }

  // 5. A first message makes the conversation and the demo agent answers (after the checks above, which
  // need an owner with no conversations yet).
  for (const [name, viewport, mobile] of [
    ["laptop", { width: 1440, height: 900 }, false],
    ["phone", { width: 390, height: 844 }, true],
  ]) {
    console.log(`\n${name} ${viewport.width}x${viewport.height}: the first message`);
    const ctx = await browser.newContext({
      viewport,
      serviceWorkers: "block",
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await ctx.newPage();
    if (mobile) {
      // The Back button appears once the list has loaded: its row is reserved, so nothing moves.
      await page.route("**/api/conversations*", async (route) => {
        await sleep(1200);
        await route.continue();
      });
      await page.goto(`${base}/#/conversations?new=1`);
      await page.locator("inc-conv-composer textarea").waitFor();
      const early = await page.locator("inc-conv-composer textarea").boundingBox();
      const earlyH = await page.locator("inc-conv-draft .draft > h2").boundingBox();
      await page.locator("inc-conv-draft button.back").waitFor({ timeout: 10_000 });
      const late = await page.locator("inc-conv-composer textarea").boundingBox();
      const lateH = await page.locator("inc-conv-draft .draft > h2").boundingBox();
      const shift = Math.max(Math.abs(early.y - late.y), Math.abs(earlyH.y - lateH.y));
      ok(shift < 0.5, `the Back button appearing moves nothing (${shift}px)`);
      await page.unroute("**/api/conversations*");
    }
    await page.goto(`${base}/#/conversations?new=1`);
    await page.locator("inc-conv-composer textarea").waitFor();
    const url0 = page.url();
    await page.locator("inc-conv-composer textarea").fill("Fix the money formatting");
    ok(page.url() === url0, "nothing is created before the first message");
    await page
      .locator("inc-conv-composer textarea")
      .press(mobile ? "Control+Enter" : "Enter")
      .catch(() => {});
    if (mobile) await page.locator('inc-conv-composer button[aria-label="Send"]').click();
    await page.waitForFunction(() => /#\/conversations\/[0-9a-f]{8}/.test(location.hash), null, {
      timeout: 15_000,
    });
    ok(true, `the conversation was made on the first send (${page.url().split("#")[1]})`);
    const allow = page.locator('inc-conv-tool button[data-option="allow-once"]');
    await allow.waitFor({ timeout: 20_000 });
    ok(true, "the demo agent streamed a reply and asked for permission");
    await page.screenshot({ path: join(outDir, `permission-${viewport.width}.png`) });
    const f2 = await page.evaluate(fit);
    ok(
      f2.vertical <= 0 && f2.horizontal <= 0,
      `still no document scroll or sideways overflow (${JSON.stringify(f2)})`,
    );
    await allow.click();
    await page.getByText("Done.", { exact: false }).first().waitFor({ timeout: 20_000 });
    ok(true, "answering the card finishes the turn");
    await ctx.close();
  }
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.log(`  FAIL ${e?.message ?? e}`);
  console.log(log.split("\n").slice(-15).join("\n"));
} finally {
  await browser?.close();
  stop();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall ok");
process.exit(failures.length ? 1 : 0);
