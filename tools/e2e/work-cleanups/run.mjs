#!/usr/bin/env node
// End-to-end run of the Work clean-ups (T64 PR 2) in Chromium, against the daemon in demo mode (I_INC_DEMO=1) in a
// scratch HOME. No sandbox, network or tokens.
//
//   pnpm --filter @i-inc/web build
//   node tools/e2e/work-cleanups/run.mjs [--out dir]
//
// It checks, in the real app, at 1440x900 and 390x844:
//   1. the board: the kanban is the first thing under the header, its four columns share the content width, there is
//      no Proposed band, form or "Recent reports" above it, and a finished ticket's card carries its report;
//   2. New ticket is a header button that opens the form as a dialog (Escape closes it), and filing a ticket closes
//      it and says what was filed;
//   3. a ticket page shows what was asked (the done-when list) above its gate or status;
//   4. times are local and plain: no "UTC", no "Coffee break", and a paused ticket says "Waiting for tokens until ...";
//   5. Releases: a project with nothing unreleased says "Up to date" and has no Cut release button, and there is no
//      "General" row; Projects (no GitHub App in demo) has one compact notice and one button;
//   6. the Brain page has no approve or decline button; the policy proposal is a Needs you card;
//   7. no document scroll or sideways overflow on any of these, and 44px controls on the phone.
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
const home = mkdtempSync(join(tmpdir(), "i-inc-e2e-work-"));
const PORT = 7464;
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
  return all(document, "button, a.btn, select, [role=tab], .tabs button")
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
/** Inside the page: the text of everything on screen, through shadow roots. */
const pageText = () => {
  const all = (node, out = []) => {
    for (const child of node.querySelectorAll?.("*") ?? []) {
      if (child.shadowRoot) {
        out.push(child.shadowRoot.textContent ?? "");
        all(child.shadowRoot, out);
      }
    }
    return out;
  };
  return all(document, [document.body.textContent ?? ""])
    .join(" ")
    .replace(/\s+/g, " ");
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
    const checkFit = async (what) => {
      const f = await page.evaluate(fit);
      ok(
        f.vertical <= 0 && f.horizontal <= 0,
        `${what}: no document scroll or sideways overflow (${JSON.stringify(f)})`,
      );
      if (mobile) {
        const small = await page.evaluate(smallTargets);
        ok(
          small.length === 0,
          `${what}: every control is 44px tall${small.length ? `: ${small.join("; ")}` : ""}`,
        );
      }
    };
    const go = async (hash, ready) => {
      await page.goto(`${base}/${hash}`);
      await page.waitForFunction(
        (h) => location.hash === h || location.hash.startsWith(h.split("?")[0]),
        hash,
      );
      if (ready) await page.locator(ready).first().waitFor({ timeout: 15_000 });
    };

    // 1. The board.
    await go("#/work/board", "inc-board .cols");
    const header = await page.locator("main inc-layout [slot=actions]").boundingBox();
    const cols = await page.locator("inc-board .cols").boundingBox();
    ok(
      cols.y >= header.y && cols.y - (header.y + header.height) < 160,
      `the kanban comes straight after the header (${Math.round(cols.y - (header.y + header.height))}px below the button)`,
    );
    const sections = await page
      .locator("inc-board .cols > section")
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
    ok(sections.length === 4, "four columns");
    if (!mobile) {
      const span = sections.at(-1).right - sections[0].left;
      ok(
        span > cols.width - 2 && sections.every((s) => Math.abs(s.width - sections[0].width) < 2),
        `the columns share the full width (${Math.round(span)} of ${Math.round(cols.width)}px)`,
      );
    }
    ok((await page.locator("inc-board inc-proposals").count()) === 0, "no Proposed band on the board");
    ok(!(await page.evaluate(pageText)).includes("Recent reports"), 'no "Recent reports" list');
    ok(
      (await page.locator("inc-board section[aria-label=Done] .report").count()) > 0,
      "a finished ticket's card carries its report",
    );
    await page.screenshot({ path: join(outDir, `board-${viewport.width}.png`) });
    await checkFit("the board");

    // 2. New ticket, as a dialog.
    const newTicket = page
      .locator('main [slot=actions]:has-text("New ticket"), main button.btn:has-text("New ticket")')
      .first();
    await newTicket.click();
    const dialog = page.locator("inc-board dialog.new-ticket");
    await dialog.waitFor({ state: "visible" });
    ok(true, "New ticket opens the form in a dialog");
    await page.screenshot({ path: join(outDir, `new-ticket-${viewport.width}.png`) });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    ok(true, "Escape closes it");
    await newTicket.click();
    await dialog.waitFor({ state: "visible" });
    await dialog.locator("input[name=title]").fill(`Check the e2e ${name}`);
    await dialog.locator("textarea").fill("It shows up on the board\nIt has a done-when list");
    await dialog.locator("button[type=submit]").click();
    await page.locator("inc-board .filed").waitFor();
    ok(!(await dialog.isVisible()), "filing closes the dialog");
    const filed = (await page.locator("inc-board .filed").textContent()).replace(/\s+/g, " ").trim();
    ok(/^Filed #\d+: Check the e2e/.test(filed), `the board says what was filed (${filed})`);

    // 3. What was asked, above the gate.
    const href = await page.locator("inc-board .filed a").getAttribute("href");
    await go(href, "inc-ticket section.asked");
    const askedBox = await page.locator("inc-ticket section.asked").boundingBox();
    ok(
      (await page.locator("inc-ticket section.asked li").count()) === 2,
      "the done-when list is at the top of the ticket",
    );
    const title = await page.locator("inc-ticket h2").first().boundingBox();
    ok(askedBox.y > title.y, "it is under the title");
    const gateAfter = await page.evaluate(() => {
      const t = document.querySelector("inc-app")?.shadowRoot?.querySelector("inc-ticket")?.shadowRoot;
      const asked = t?.querySelector("section.asked");
      const status = t?.querySelector(".ask, .assign, .waits, p.muted");
      return !status || !!(asked.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    ok(gateAfter, "it comes before the gate or status");
    await page.screenshot({ path: join(outDir, `ticket-${viewport.width}.png`) });
    await checkFit("the ticket");

    // 4. Plain statuses, local times.
    await go("#/work/board", "inc-board .cols");
    const text = await page.evaluate(pageText);
    ok(!/UTC/.test(text), "no UTC on the board");
    ok(!/coffee/i.test(text), "no coffee break on the board");
    ok(
      /Waiting for tokens until [^·]*\d:\d\d\s?[AP]M/i.test(text),
      "a paused ticket says Waiting for tokens until a local time",
    );

    // 5. Releases and Projects.
    await go("#/work/releases", "inc-desk .release-project");
    const rel = await page.evaluate(pageText);
    ok(
      !/General/.test(rel) || /No project/.test(rel),
      'no "General" row (it is "No project", or left out when empty)',
    );
    const rows = await page.locator("inc-desk .release-project").evaluateAll((els) =>
      els.map((e) => ({
        text: e.textContent.replace(/\s+/g, " ").trim(),
        button: !!e.querySelector("button"),
      })),
    );
    ok(
      rows.every((r) => r.button === !r.text.includes("Up to date")),
      `Cut release only where something is unreleased (${rows.length} rows)`,
    );
    await page.screenshot({ path: join(outDir, `releases-${viewport.width}.png`) });
    await checkFit("Releases");

    await go("#/company/projects", "inc-setup-projects");
    await sleep(500);
    const notice = page.locator("inc-setup-projects .notice");
    ok(
      (await notice.count()) === 1 && /Connect GitHub to add repos/.test(await notice.textContent()),
      "Projects has one compact GitHub notice",
    );
    ok((await notice.locator("a.btn").count()) === 1, "with one button");
    ok(!(await page.evaluate(pageText)).includes("github-app.md"), "and not the long paragraph");
    await page.screenshot({ path: join(outDir, `projects-${viewport.width}.png`) });
    await checkFit("Projects");

    // 6. Brain, and the policy proposal in Needs you.
    await go("#/company/brain", "inc-knowledge");
    await sleep(400);
    const labels = await page.locator("inc-knowledge button").allTextContents();
    ok(
      !labels.some((l) => /^(Approve|Decline)$/.test(l.trim())),
      "the Brain page has no approve or decline button",
    );
    await page.screenshot({ path: join(outDir, `brain-${viewport.width}.png`) });
    await checkFit("Brain");
    await go("#/needs-you", "inc-inbox");
    await sleep(400);
    ok(/handbook policy/.test(await page.evaluate(pageText)), "the policy proposal is a Needs you card");
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
