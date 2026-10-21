#!/usr/bin/env node
// End-to-end run of shipping a conversation's work (T62b) in Chromium, against a local daemon in a scratch HOME
// (apps/daemon/scripts/e2e-ship-server.ts): real git against local bare repos, the real ticket pipeline, a fake
// GitHub PR API and scripted agents. No real credentials.
//
//   pnpm --filter @i-inc/web build
//   node tools/e2e/ship/run.mjs [--out dir]
//
// For each of 1440x900 and 390x844 (light, and the dialog in dark too) it drives the real screens: make a
// conversation a ticket (owner-merges), watch it hold the conversation and run, follow the links both ways,
// open a PR, make a direct project's conversation a ticket, and meet a credential. Screenshots go to --out
// (never committed). Exit code 1 when anything fails.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const { chromium } = await import("playwright").catch(() => {
  const dir = process.env.NODE_PATH || execFileSync("npm", ["root", "-g"]).toString().trim();
  return import(pathToFileURL(`${dir}/playwright/index.mjs`).href);
});

const args = process.argv.slice(2);
const outDir = resolve(args[args.indexOf("--out") + 1] ?? "e2e-out");
mkdirSync(outDir, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "i-inc-e2e-ship-"));
const PORT = Number(process.env.E2E_PORT ?? 7461);
const base = `http://127.0.0.1:${PORT}`;

const failures = [];
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
};

async function start() {
  const child = spawn("bun", [join(root, "apps/daemon/scripts/e2e-ship-server.ts")], {
    env: { ...process.env, HOME: home, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => {
    log += d;
  });
  child.stderr.on("data", (d) => {
    log += d;
  });
  for (let i = 0; i < 150; i++) {
    if (log.includes("ready:")) return child;
    if (child.exitCode !== null) throw new Error(`the server stopped:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server didn't start:\n${log}`);
}

const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  return { status: res.status, body: await res.json() };
};
const control = (body) => api("POST", "/__e2e", body).then((r) => r.body);
const until = async (fn, what, ms = 40000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

const combos = [
  { name: "1440-light", width: 1440, height: 900, scheme: "light", phone: false },
  { name: "390-light", width: 390, height: 844, scheme: "light", phone: true },
  { name: "1440-dark", width: 1440, height: 900, scheme: "dark", phone: false },
  { name: "390-dark", width: 390, height: 844, scheme: "dark", phone: true },
];

const layoutProblems = () => {
  const out = [];
  const de = document.documentElement;
  if (de.scrollWidth > innerWidth)
    out.push(`the page is ${de.scrollWidth - innerWidth}px wider than the window`);
  if (document.scrollingElement && document.scrollingElement.scrollHeight > innerHeight + 1)
    out.push(
      `the document scrolls (${document.scrollingElement.scrollHeight}px in a ${innerHeight}px window)`,
    );
  const deep = (r) =>
    [...r.querySelectorAll("*")].flatMap((e) => [e, ...(e.shadowRoot ? deep(e.shadowRoot) : [])]);
  for (const el of deep(document)) {
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden") continue;
    let p = el.parentElement ?? el.getRootNode().host;
    let scrolls = false;
    while (p) {
      const ps = getComputedStyle(p);
      if (/(auto|scroll)/.test(ps.overflowX) && p.scrollWidth > p.clientWidth) scrolls = true;
      p = p.parentElement ?? p.getRootNode().host;
    }
    if (!scrolls && b.right > innerWidth + 1)
      out.push(`${el.tagName.toLowerCase()} runs ${Math.round(b.right - innerWidth)}px past the right edge`);
    if (out.length > 6) break;
  }
  return out;
};

/** Every visible control inside `scope` (a selector for a custom element) smaller than 44px tall (and not 44 wide). */
const smallTargets = (scope) => {
  const out = [];
  const deep = (r) =>
    [...r.querySelectorAll("*")].flatMap((e) => [e, ...(e.shadowRoot ? deep(e.shadowRoot) : [])]);
  const find = (r) => {
    const hit = r.querySelector(scope);
    if (hit) return hit;
    for (const e of r.querySelectorAll("*")) {
      const inner = e.shadowRoot ? find(e.shadowRoot) : null;
      if (inner) return inner;
    }
    return null;
  };
  const start = find(document);
  const rootEl = start?.shadowRoot ?? start;
  if (!rootEl) return [`${scope} not found`];
  for (const el of deep(rootEl)) {
    if (!el.matches?.("button, a[href], input:not([type=hidden]):not([type=file]), select, textarea"))
      continue;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.opacity === "0") continue;
    if (b.height < 43.5 && b.width < 43.5)
      out.push(
        `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" is ${Math.round(b.width)}x${Math.round(b.height)}`,
      );
    else if (b.height < 43.5)
      out.push(
        `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" is ${Math.round(b.height)}px tall`,
      );
  }
  return out;
};

async function audit(page, combo, label, scope) {
  const problems = await page.evaluate(layoutProblems);
  ok(
    problems.length === 0,
    `${combo.name} ${label}: no sideways or document scroll${problems.length ? ` (${problems.join("; ")})` : ""}`,
  );
  if (combo.phone) {
    const small = await page.evaluate(smallTargets, scope);
    ok(
      small.length === 0,
      `${combo.name} ${label}: tap targets are at least 44px${small.length ? ` (${small.slice(0, 5).join("; ")})` : ""}`,
    );
  }
}

const shot = (page, combo, name) => page.screenshot({ path: join(outDir, `${name}-${combo.name}.png`) });

const newConversation = async (project, employeeId = "ada") => {
  const r = await api("POST", "/api/conversations", { employeeId, ...(project ? { project } : {}) });
  if (r.status !== 201) throw new Error(`couldn't make a conversation: ${JSON.stringify(r.body)}`);
  return r.body.conversation;
};

async function say(page, text) {
  const box = page.locator("inc-conv-composer textarea");
  await box.fill(text);
  await page.locator('inc-conv-composer button[aria-label="Send"]').click();
}

async function openShipMenu(page) {
  await page.getByRole("button", { name: "Ship this work", exact: true }).first().click();
  await page.getByRole("menu", { name: "Ship this work" }).waitFor();
}

async function flow(browser, combo) {
  console.log(`\n== ${combo.name}`);
  await control({ op: "gate", open: false });
  const ctx = await browser.newContext({
    viewport: { width: combo.width, height: combo.height },
    colorScheme: combo.scheme,
    hasTouch: combo.phone,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on(
    "console",
    (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()),
  );

  // ---- 1. Owner-merges: make a conversation a ticket ----
  const a = await newConversation("Duet");
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/#/conversations/${a.id}`);
  await page.locator("inc-conv-composer textarea").waitFor();
  await say(page, "plain add a greeting file");
  await until(
    async () =>
      (await api("GET", `/api/conversations/${a.id}`)).body.conversation.title ===
      "plain add a greeting file",
    "the title",
  );
  await control({
    op: "write",
    conversation: a.id,
    path: "src/greeting.ts",
    text: "export const hi = 'hi';\nexport const bye = 'bye';\n",
  });
  await control({ op: "write", conversation: a.id, path: "src/app.ts", text: "export const app = 2;\n" });
  await control({
    op: "write",
    conversation: a.id,
    path: ".github/workflows/ci.yml",
    text: "name: ci\non: push\n",
  });
  await page.waitForTimeout(500);
  await shot(page, combo, "01-conversation");

  await openShipMenu(page);
  const items = await page.getByRole("menuitem").allInnerTexts();
  ok(
    items.some((t) => /Make this a ticket/.test(t)) && items.some((t) => /Open a PR/.test(t)),
    `${combo.name}: the menu offers a ticket and a PR (${items.length} items)`,
  );
  await shot(page, combo, "02-menu");
  await page.getByRole("menuitem", { name: /Make this a ticket/ }).click();
  const dialog = page.getByRole("dialog", { name: "Make this a ticket" });
  await dialog.getByText("What gets committed").waitFor();
  const dtext = await dialog.innerText();
  ok(
    /3 files differ from the project's main/.test(dtext) && /src\/greeting\.ts/.test(dtext),
    `${combo.name}: the dialog lists the files (${dtext.match(/\d files differ/)?.[0]})`,
  );
  ok(
    /protected/.test(dtext) && /pull request opens on GitHub/.test(dtext) && /only you can merge/.test(dtext),
    `${combo.name}: it says where it goes, what is protected and what the owner still does`,
  );
  ok(
    (await dialog.locator("#ship-title").inputValue()) === "plain add a greeting file",
    `${combo.name}: the title starts from the conversation`,
  );
  await shot(page, combo, "03-dialog-ticket");
  await audit(page, combo, "ticket dialog", "inc-conv-ship");
  await dialog.locator("#ship-title").fill("Add a greeting");
  await dialog.getByRole("button", { name: "Make the ticket" }).click();
  await dialog.getByText(/This work is now ticket #\d+/).waitFor();
  const ticketId = (await dialog.innerText()).match(/ticket #(\d+)/)[1];
  await shot(page, combo, "04-dialog-done");
  await dialog.locator("footer").getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "detached" });
  ok(true, `${combo.name}: the ticket is #${ticketId}`);

  // ---- 2. Held: the conversation says so, and the ticket runs on the conversation's branch ----
  await page.locator("inc-conv-thread .held, .held").first().waitFor();
  const held = await page.locator(".held").first().innerText();
  ok(
    /This work is now ticket #\d+/.test(held),
    `${combo.name}: the conversation says "${held.split("\n")[0].slice(0, 60)}"`,
  );
  await until(
    async () => (await page.getByText(/can't change the code until it is done/).count()) > 0,
    "the composer's hint",
    6000,
  ).catch(() => {});
  ok(
    (await page.getByText(/can't change the code until it is done/).count()) > 0,
    `${combo.name}: the composer says it waits`,
  );
  ok(
    await page
      .locator("inc-conv-composer button[aria-label='Send']")
      .isDisabled()
      .catch(() => true),
    `${combo.name}: nothing can be sent`,
  );
  const t = (await api("GET", `/api/tickets/${ticketId}`)).body.ticket;
  ok(t.fromConversation?.id === a.id, `${combo.name}: the ticket knows its conversation`);
  if (combo.phone) {
    await page.getByRole("button", { name: "Context panel" }).click();
    await page.getByRole("dialog", { name: "Conversation context" }).waitFor();
  }
  const panelText = async () =>
    page
      .locator("inc-conv-context")
      .first()
      .evaluate((el) => el.shadowRoot?.textContent?.replace(/\s+/g, " ") ?? "");
  await until(
    async () => /Ticket #\d+/.test(await panelText()) && /Running/.test(await panelText()),
    "the ticket in the panel",
  );
  await until(async () => /Running · Review/.test(await panelText()), "the ticket's stage in the panel");
  ok(true, `${combo.name}: the panel shows the ticket's stage live ("Running · Review")`);
  await shot(page, combo, "05-held-panel");
  await audit(page, combo, "held with the panel", "inc-conv-context");

  // ---- 3. The ticket finishes its work: ready for the owner, with the PR in the panel ----
  await control({ op: "gate", open: true });
  await until(
    async () => (await api("GET", `/api/tickets/${ticketId}`)).body.ticket.status === "ready",
    "the ticket to be ready",
  );
  await until(async () => /Ready for you/.test(await panelText()), "Ready for you in the panel");
  ok(/Pull request #\d+ on GitHub/.test(await panelText()), `${combo.name}: the PR link is in the panel`);
  const prs = (await control({ op: "prs" })).prs;
  ok(
    prs.at(-1)?.head === `conv/${a.id}` &&
      prs.at(-1)?.draft === false &&
      prs.filter((p) => p.head === `conv/${a.id}`).length === 1,
    `${combo.name}: one PR, on the conversation's branch, out of draft`,
  );
  await control({ op: "checks", checks: { state: "success", total: 2, passed: 2, failed: 0, pending: 0 } });
  await page.reload();
  await page.locator("inc-conv-composer textarea").waitFor();
  if (combo.phone) {
    await page.getByRole("button", { name: "Context panel" }).click();
    await page.getByRole("dialog", { name: "Conversation context" }).waitFor();
  }
  await until(async () => /Checks: all 2 passed/.test(await panelText()), "the PR's checks");
  ok(true, `${combo.name}: the PR's checks show in the panel`);
  await shot(page, combo, "06-ready-panel");
  await control({ op: "checks", checks: { state: "pending", total: 2, passed: 1, failed: 0, pending: 1 } });

  // ---- 4. The links both ways ----
  await page.goto(`${base}/#/ticket/${ticketId}`);
  await page.locator("inc-ticket .from a, .from a").first().waitFor();
  ok(
    /From conversation/.test(await page.locator(".from").first().innerText()),
    `${combo.name}: the ticket says which conversation it came from`,
  );
  await shot(page, combo, "07-ticket");
  await audit(page, combo, "ticket page", "inc-ticket");
  await page.locator(".from a").first().click();
  await page.locator("inc-conv-composer textarea").waitFor();
  ok(page.url().endsWith(`#/conversations/${a.id}`), `${combo.name}: the link goes back to the conversation`);

  // ---- 5. The owner merges: the conversation has its copy back ----
  ok(
    (await api("POST", `/api/tickets/${ticketId}/decide`, { decision: "approve" })).status === 200,
    `${combo.name}: the owner approves`,
  );
  await until(
    async () => (await api("GET", `/api/tickets/${ticketId}`)).body.ticket.status === "done",
    "the ticket to be done",
  );
  await until(async () => (await page.locator(".held").count()) === 0, "the banner to go");
  await say(page, "plain carry on");
  await until(async () => (await page.locator("inc-conv-turn").count()) >= 2, "a second turn");
  ok(true, `${combo.name}: after the ticket, the conversation takes a message again`);
  await shot(page, combo, "08-after");

  // ---- 6. Open a PR: the quick path ----
  const b = await newConversation("Duet");
  await page.goto(`${base}/#/conversations/${b.id}`);
  await page.locator("inc-conv-composer textarea").waitFor();
  await say(page, "plain add a readme line");
  await until(
    async () =>
      (await api("GET", `/api/conversations/${b.id}`)).body.conversation.title === "plain add a readme line",
    "the title",
  );
  await control({
    op: "write",
    conversation: b.id,
    path: "README.md",
    text: `duet\nA second line (${combo.name}).\n`,
  });
  await openShipMenu(page);
  await page.getByRole("menuitem", { name: /Open a PR/ }).click();
  const pdialog = page.getByRole("dialog", { name: "Open a pull request" });
  await pdialog.getByText("What gets committed").waitFor();
  ok(
    /draft pull request/.test(await pdialog.innerText()) &&
      /hasn't been through i\.inc's checks and review/.test(await pdialog.innerText()),
    `${combo.name}: the PR dialog says it is a draft without a review`,
  );
  await shot(page, combo, "09-dialog-pr");
  await audit(page, combo, "pr dialog", "inc-conv-ship");
  await pdialog.getByRole("button", { name: "Open the pull request" }).click();
  await pdialog.getByText(/Pull request #\d+ is open as a draft/).waitFor();
  await pdialog.locator("footer").getByRole("button", { name: "Close" }).click();
  if (!combo.phone) {
    try {
      await until(
        async () => /Pull request #\d+ on GitHub/.test(await panelText()),
        "the PR in the panel",
        8000,
      );
    } catch (e) {
      await shot(page, combo, "debug-pr-panel");
      console.log(`  panel: ${(await panelText()).slice(0, 500)}`);
      throw e;
    }
  }
  const prs2 = (await control({ op: "prs" })).prs;
  ok(
    prs2.at(-1)?.draft === true && prs2.at(-1)?.head === `conv/${b.id}` && prs2.length === prs.length + 1,
    `${combo.name}: a second, draft PR on the second conversation's branch`,
  );
  ok(
    (await control({ op: "git", repo: "acme/duet", args: ["show", `conv/${b.id}:README.md`] })).out.includes(
      "second line",
    ),
    `${combo.name}: the branch on GitHub has the commit`,
  );
  await shot(page, combo, "10-pr-opened");

  // ---- 7. Direct: no PR button; straight to main after the review ----
  const c = await newConversation("Notes");
  await page.goto(`${base}/#/conversations/${c.id}`);
  await page.locator("inc-conv-composer textarea").waitFor();
  await say(page, "plain add a note");
  await until(
    async () =>
      (await api("GET", `/api/conversations/${c.id}`)).body.conversation.title === "plain add a note",
    "the title",
  );
  await control({
    op: "write",
    conversation: c.id,
    path: "src/notes.ts",
    text: `export const notes = ['${combo.name}'];\n`,
  });
  await page.waitForTimeout(600);
  await openShipMenu(page);
  const direct = await page.getByRole("menuitem").allInnerTexts();
  ok(!direct.some((x) => /Open a PR/.test(x)), `${combo.name}: a direct project has no "Open a PR"`);
  await page.getByRole("menuitem", { name: /Make this a ticket/ }).click();
  const ddialog = page.getByRole("dialog", { name: "Make this a ticket" });
  await ddialog
    .getByText("Where it goes")
    .waitFor({ timeout: 10000 })
    .catch(async (e) => {
      await shot(page, combo, "debug-direct");
      console.log(await ddialog.innerText().catch(() => "(no dialog)"));
      throw e;
    });
  ok(
    /Straight to main/.test(await ddialog.innerText()),
    `${combo.name}: it says straight to main, after a review`,
  );
  await shot(page, combo, "11-dialog-direct");
  await ddialog.getByRole("button", { name: "Make the ticket" }).click();
  await ddialog.getByText(/This work is now ticket #\d+/).waitFor();
  const dTicket = (await ddialog.innerText()).match(/ticket #(\d+)/)[1];
  await ddialog.locator("footer").getByRole("button", { name: "Close" }).click();
  await until(
    async () => (await api("GET", `/api/tickets/${dTicket}`)).body.ticket.status === "done",
    "the direct ticket to finish",
  );
  ok(
    (await control({ op: "git", repo: "acme/notes", args: ["show", "main:src/notes.ts"] })).out.includes(
      combo.name,
    ),
    `${combo.name}: the reviewed work reached main`,
  );

  // ---- 8. A credential stops it ----
  const e = await newConversation("Duet");
  await page.goto(`${base}/#/conversations/${e.id}`);
  await page.locator("inc-conv-composer textarea").waitFor();
  await say(page, "plain add the config");
  await until(
    async () =>
      (await api("GET", `/api/conversations/${e.id}`)).body.conversation.title === "plain add the config",
    "the title",
  );
  await control({
    op: "write",
    conversation: e.id,
    path: "config.ts",
    text: 'export const token = "gh\u0070_abcdefghijklmnopqrstuvwxyz0123456789";\n',
  });
  await openShipMenu(page);
  await page.getByRole("menuitem", { name: /Make this a ticket/ }).click();
  const sdialog = page.getByRole("dialog", { name: "Make this a ticket" });
  await sdialog.getByText(/Can't ship yet/).waitFor();
  const stext = await sdialog.innerText();
  ok(
    /config\.ts/.test(stext) && !/ghp_/.test(stext),
    `${combo.name}: the credential stops it, names the file and never shows the value`,
  );
  ok(
    await sdialog.getByRole("button", { name: "Make the ticket" }).isDisabled(),
    `${combo.name}: it cannot be confirmed`,
  );
  await shot(page, combo, "12-dialog-blocked");
  await page.keyboard.press("Escape");
  await sdialog.waitFor({ state: "detached" });

  // ---- 9. No project: no Ship button ----
  const f = await newConversation(null);
  await page.goto(`${base}/#/conversations/${f.id}`);
  await page.locator("inc-conv-composer textarea").waitFor();
  ok(
    (await page.getByRole("button", { name: "Ship this work", exact: true }).count()) === 0,
    `${combo.name}: a conversation with no project has no Ship button`,
  );
  const refused = await api("POST", `/api/conversations/${f.id}/ticket`, {});
  ok(
    refused.status === 409 && /no project/.test(refused.body.error),
    `${combo.name}: the API refuses it in a sentence`,
  );

  ok(
    errors.length === 0,
    `${combo.name}: no console errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`,
  );
  await ctx.close();
}

let server;
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
try {
  server = await start();
  for (const combo of combos) await flow(browser, combo);
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.log(`  FAIL ${e?.stack ?? e}`);
} finally {
  await browser.close();
  server?.kill();
}
console.log(failures.length ? `\n${failures.length} problem(s)` : "\nall passed");
console.log(`screenshots: ${outDir}`);
process.exit(failures.length ? 1 : 0);
