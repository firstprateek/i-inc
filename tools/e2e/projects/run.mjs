#!/usr/bin/env node
// End-to-end run of the GitHub projects flow (T62) in Chromium, against a local daemon with a stand-in
// GitHub (apps/daemon/scripts/e2e-projects-server.ts) in a scratch HOME. No real credentials are used.
//
//   pnpm --filter @i-inc/web build
//   node tools/e2e/projects/run.mjs [--out dir]
//
// It drives the real screens: Company -> Projects, adding a repo (with the keyboard only), creating a new project
// through the bot (an organization) and by hand (a personal account, with a reload in the middle and the
// page noticing the repo), and a project's page. It screenshots every state at 1440x900 and 390x844, light and dark,
// checks that nothing scrolls sideways and that the document itself doesn't scroll, and runs tools/ui-check for
// contrast, overlap, tap targets and accessible names. Exit code 1 when anything fails.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The repo's own Playwright (a root devDependency; `pnpm e2e:install` downloads its browser).
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

const args = process.argv.slice(2);
const outDir = resolve(args[args.indexOf("--out") + 1] ?? "e2e-out");
mkdirSync(outDir, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "i-inc-e2e-home-"));

const ORG = { port: 7441, stub: 7442 };
const PERSONAL = { port: 7443, stub: 7444 };
const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`  FAIL ${msg}`);
};
const ok = (cond, msg) => (cond ? console.log(`  ok   ${msg}`) : fail(msg));

/** Starts a daemon and its stand-in GitHub, and waits until it answers. Only this run's own PIDs are ever killed. */
async function start(scenario, ports) {
  const child = spawn("bun", [join(root, "apps/daemon/scripts/e2e-projects-server.ts")], {
    env: {
      ...process.env,
      HOME: join(home, scenario),
      SCENARIO: scenario,
      PORT: String(ports.port),
      STUB_PORT: String(ports.stub),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => {
    log += d;
  });
  child.stderr.on("data", (d) => {
    log += d;
  });
  for (let i = 0; i < 100; i++) {
    if (log.includes("ready")) return child;
    if (child.exitCode !== null) throw new Error(`the ${scenario} server stopped:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the ${scenario} server didn't start:\n${log}`);
}

const stubCall = (ports, body) =>
  fetch(`http://127.0.0.1:${ports.stub}/__stub`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
    r.json(),
  );

const combos = [
  { name: "1440-light", width: 1440, height: 900, scheme: "light", phone: false },
  { name: "1440-dark", width: 1440, height: 900, scheme: "dark", phone: false },
  { name: "390-light", width: 390, height: 844, scheme: "light", phone: true },
  { name: "390-dark", width: 390, height: 844, scheme: "dark", phone: true },
];

/** Runs inside the page. Nothing may scroll sideways, and the document itself never scrolls (the app's panes do). */
const layoutProblems = () => {
  const out = [];
  const de = document.documentElement;
  if (de.scrollWidth > innerWidth)
    out.push(`the page is ${de.scrollWidth - innerWidth}px wider than the window`);
  if (document.scrollingElement && document.scrollingElement.scrollHeight > innerHeight + 1) {
    out.push(
      `the document scrolls (${document.scrollingElement.scrollHeight}px in a ${innerHeight}px window)`,
    );
  }
  const deep = (r) =>
    [...r.querySelectorAll("*")].flatMap((e) => [e, ...(e.shadowRoot ? deep(e.shadowRoot) : [])]);
  for (const el of deep(document)) {
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.position === "fixed") continue;
    // Clipped by a scroller on purpose (the tab strip): skip anything inside an overflow-x scroller.
    let p = el.parentElement ?? el.getRootNode().host;
    let scrolls = false;
    while (p) {
      const ps = getComputedStyle(p);
      if (/(auto|scroll)/.test(ps.overflowX) && p.scrollWidth > p.clientWidth) scrolls = true;
      p = p.parentElement ?? p.getRootNode().host;
    }
    if (!scrolls && b.right > innerWidth + 1 && !el.closest?.(".sr")) {
      out.push(
        `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""} runs ${Math.round(b.right - innerWidth)}px past the right edge`,
      );
      if (out.length > 6) break;
    }
  }
  return out;
};

/** Runs inside the page: every visible control that is smaller than 44px in both directions. */
const smallTargets = () => {
  const out = [];
  const deep = (r) =>
    [...r.querySelectorAll("*")].flatMap((e) => [e, ...(e.shadowRoot ? deep(e.shadowRoot) : [])]);
  for (const el of deep(document)) {
    if (!el.matches?.("button, a[href], input:not([type=hidden]), select, textarea, summary, [role=tab]"))
      continue;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.opacity === "0") continue;
    // A radio or checkbox sits inside a label that is the real target.
    const label = el.closest?.("label");
    const lb = label ? label.getBoundingClientRect() : null;
    const w = Math.max(b.width, lb?.width ?? 0);
    const h = Math.max(b.height, lb?.height ?? 0);
    if (h < 43.5 && w < 43.5)
      out.push(
        `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" is ${Math.round(w)}x${Math.round(h)}`,
      );
    else if (h < 43.5)
      out.push(
        `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" is ${Math.round(h)}px tall`,
      );
  }
  return out;
};

const activeLabel = (page) =>
  page.evaluate(() => {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    if (!a) return "";
    return (
      a.getAttribute?.("aria-label") ||
      a.textContent ||
      a.value ||
      a.getAttribute?.("name") ||
      a.tagName
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 60);
  });

/** "Refresh now" within 3 s of the last list fetch is held back by the daemon, so let that pass first. */
const refreshNow = async (page) => {
  await page.waitForTimeout(3300);
  await page.getByRole("button", { name: "Refresh now" }).click();
};

const settle = (page, ms = 600) => page.waitForTimeout(ms);

async function audit(page, combo, label) {
  const problems = await page.evaluate(layoutProblems);
  ok(
    problems.length === 0,
    `${combo.name} ${label}: no sideways or document scroll${problems.length ? ` (${problems.join("; ")})` : ""}`,
  );
  if (combo.phone) {
    const small = await page.evaluate(smallTargets);
    ok(
      small.length === 0,
      `${combo.name} ${label}: tap targets are at least 44px${small.length ? ` (${small.slice(0, 5).join("; ")})` : ""}`,
    );
  }
}

const shot = (page, combo, name) =>
  page.screenshot({ path: join(outDir, `${name}-${combo.name}.png`), fullPage: true });

const servers = [];
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
try {
  servers.push(await start("org", ORG), await start("personal", PERSONAL));
  const orgUrl = `http://127.0.0.1:${ORG.port}/`;
  const personalUrl = `http://127.0.0.1:${PERSONAL.port}/`;

  // ---- 1. Every combination: the screens, screenshotted and audited. ----
  for (const combo of combos) {
    console.log(`\n== ${combo.name}`);
    const ctx = await browser.newContext({
      viewport: { width: combo.width, height: combo.height },
      colorScheme: combo.scheme,
      hasTouch: combo.phone,
    });
    const page = await ctx.newPage();
    const states = [
      ["list", orgUrl, "#/company/projects", async () => page.getByText("Your projects").first().waitFor()],
      [
        "project",
        orgUrl,
        "#/company/projects/Duet",
        async () => page.getByText("Recent tickets").first().waitFor(),
      ],
      [
        "add",
        orgUrl,
        "#/company/projects/add?repo=acme%2Fnotes-api",
        async () => page.getByRole("button", { name: "Add project" }).waitFor(),
      ],
      ["new", orgUrl, "#/company/projects/new", async () => page.getByText("Start from").first().waitFor()],
      [
        "empty",
        personalUrl,
        "#/company/projects",
        async () => page.getByText("No projects yet").first().waitFor(),
      ],
    ];
    for (const [name, base, hash, ready] of states) {
      await page.goto(base);
      await page.evaluate(() => localStorage.clear());
      await page.goto(`${base}${hash}`);
      await page.reload();
      await ready();
      await settle(page, 400);
      await shot(page, combo, name);
      await audit(page, combo, name);
    }
    // The ticket form opened from a project page, and the steps of a by-hand start.
    await page.goto(`${orgUrl}#/company/projects/Duet`);
    await page.getByRole("button", { name: "New ticket" }).click();
    await page.locator("inc-new-ticket").waitFor();
    await settle(page, 500);
    ok(
      (await page.locator("select[name=project]").inputValue()) === "Duet",
      `${combo.name}: New ticket is preset to Duet`,
    );
    await shot(page, combo, "project-new-ticket");
    await audit(page, combo, "project + new ticket");

    await page.goto(personalUrl);
    await page.evaluate(() =>
      localStorage.setItem(
        "inc.new-project",
        JSON.stringify({
          name: "fresh-start",
          visibility: "private",
          template: "web",
          mode: "owner-merges",
          description: "",
          via: "manual",
        }),
      ),
    );
    await page.goto(`${personalUrl}#/company/projects/new`);
    await page.reload();
    await page.getByText("Waiting for you").first().waitFor();
    await settle(page, 400);
    await shot(page, combo, "new-steps-manual");
    await audit(page, combo, "new project steps (by hand)");
    await ctx.close();
  }

  // ---- 2. The real flows, once, at the laptop size in light. ----
  console.log("\n== flows");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on(
    "console",
    (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()),
  );

  // Add a repo with the keyboard only: Tab to the controls, ArrowDown to change the mode, Enter to submit.
  await page.goto(orgUrl);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${orgUrl}#/company/projects`);
  await page.getByText("Repos you can add").waitFor();
  const adds = await page.getByRole("link", { name: /^Add acme\// }).allInnerTexts();
  ok(adds.length === 2, `the list offers the 2 repos that aren't projects yet (${adds.length})`);
  await page.getByRole("link", { name: "Add acme/notes-api as a project" }).click();
  await page.getByRole("button", { name: "Add project" }).waitFor();
  ok(
    (await page.getByText("Found a Node project").count()) === 1,
    "the checks of acme/notes-api were detected",
  );
  await page.locator("inc-project-flow input[type=text]").first().focus();
  const seen = [];
  let reachedMode = false;
  for (let i = 0; i < 80; i++) {
    const label = await activeLabel(page);
    seen.push(label);
    if (/^(owner-merges|direct)$/.test(label) && !reachedMode) {
      reachedMode = true;
      await page.keyboard.press("ArrowDown");
    }
    if (label === "Add project") break;
    await page.keyboard.press("Tab");
  }
  ok(reachedMode, "the mode radios can be reached with Tab");
  ok(seen.at(-1) === "Add project", `Tab reaches "Add project" (${seen.slice(-4).join(" > ")})`);
  await page.keyboard.press("Enter");
  await page.getByText("Added notes-api").waitFor();
  const added = await (await fetch(`http://127.0.0.1:${ORG.port}/api/projects/notes-api`)).json();
  ok(
    added.project?.repo === "acme/notes-api" && added.mode === "owner-merges",
    `the project was added in the mode chosen with the arrow key (${added.mode})`,
  );
  ok(added.project?.checks?.[0] === "pnpm install --frozen-lockfile", "it kept the detected recipe");
  await shot(page, combos[0], "flow-add-done");
  const convo = await page.getByRole("link", { name: "Start a conversation" }).getAttribute("href");
  ok(
    convo === "#/conversations?new=1&project=notes-api",
    `Start a conversation links to the Conversations screen (${convo})`,
  );

  // Start a new project through the bot (an organization with Administration: write), with the keyboard.
  await page.goto(`${orgUrl}#/company/projects/new`);
  await page.locator("input[name=name]").fill("brand-new");
  await page.locator("input[name=name]").press("Enter");
  await page.getByText("Started brand-new").waitFor({ timeout: 15000 });
  const created = await (await fetch(`http://127.0.0.1:${ORG.port}/api/projects/brand-new`)).json();
  ok(created.project?.repo === "acme/brand-new", "the bot created acme/brand-new and the project was added");
  const orgCalls = (await stubCall(ORG, { op: "calls" })).calls;
  ok(
    orgCalls.some((c) => c.method === "POST" && c.path === "/orgs/acme/repos"),
    "the bot created the repo in the organization",
  );
  ok(
    orgCalls.some((c) => c.method === "PUT" && c.path === "/repos/acme/brand-new/contents/package.json"),
    "the starter files were written",
  );
  ok(!(await page.content()).includes("ghs_STUBTOKEN"), "the installation token is nowhere in the page");
  await shot(page, combos[0], "flow-new-bot-done");

  // Start a new project in a personal account: by hand, with a reload, and the page notices the repo.
  await page.goto(personalUrl);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${personalUrl}#/company/projects`);
  await page.getByText("No projects yet").first().waitFor();
  await shot(page, combos[0], "flow-empty-list");
  await page.getByRole("link", { name: "New project" }).first().click();
  await page.locator("input[name=name]").fill("fresh-start");
  await page.getByText("You create the repo; i.inc fills it").waitFor();
  await page.getByRole("button", { name: "Next: create it on GitHub" }).click();
  const gh = await page.getByRole("link", { name: /Open GitHub to create fresh-start/ }).getAttribute("href");
  ok(
    gh === "https://github.com/new?name=fresh-start&visibility=private",
    `the GitHub link is filled in and encoded (${gh})`,
  );
  await shot(page, combos[0], "flow-new-manual-waiting");
  await page.reload();
  await page.getByText("Waiting for you").first().waitFor();
  ok(true, "after a reload the steps are still there");
  ok((await page.locator("input[name=name]").count()) === 0, "a reload does not start the form over");
  await refreshNow(page);
  await page.getByText("Not there yet").waitFor();
  const personalCalls = (await stubCall(PERSONAL, { op: "calls" })).calls;
  ok(
    !personalCalls.some((c) => c.method === "POST" && /\/repos$/.test(c.path)),
    "the bot did not try to create a repo in a personal account",
  );
  // The owner creates the empty repo on GitHub; the page looks for it politely (every 15 s) and fills it.
  await stubCall(PERSONAL, { op: "addRepo", name: "fresh-start", owner: "someone", files: {} });
  await page.getByText("Started fresh-start").waitFor({ timeout: 40000 });
  const fresh = await (await fetch(`http://127.0.0.1:${PERSONAL.port}/api/projects/fresh-start`)).json();
  ok(
    fresh.project?.repo === "someone/fresh-start",
    "the page noticed the new repo, filled it and added the project",
  );
  await shot(page, combos[0], "flow-new-manual-done");
  // A repo that has a README but that GitHub still reports as 0 KB must never be written over.
  await page.goto(`${personalUrl}#/company/projects/new`);
  await page.reload();
  await page.locator("input[name=name]").fill("my-notes");
  await page.getByRole("button", { name: "Next: create it on GitHub" }).click();
  await page.getByText("Waiting for you").first().waitFor();
  await stubCall(PERSONAL, {
    op: "addRepo",
    name: "my-notes",
    owner: "someone",
    files: { "README.md": "# mine" },
    sizeLag: true,
  });
  await refreshNow(page);
  await page.waitForFunction(
    () =>
      document
        .querySelector("inc-app")
        ?.shadowRoot?.querySelector("inc-project-flow")
        ?.shadowRoot?.textContent?.includes("already has files"),
    null,
    { timeout: 15000 },
  );
  const notes = (await stubCall(PERSONAL, { op: "calls" })).calls;
  ok(
    !notes.some((c) => c.method === "PUT" && c.path.startsWith("/repos/someone/my-notes/")),
    "a README-only repo (size 0 on GitHub) was not written over",
  );
  ok((await page.getByRole("button", { name: "Try again" }).count()) === 0, "and it is not offered a retry");
  await shot(page, combos[0], "flow-new-repo-has-files");

  ok(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
  await ctx.close();

  // GitHub failing is a sentence, never the offline panel or a raw status.
  await stubCall(ORG, { op: "fail", fail: { status: 500, message: "boom" } });
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const p2 = await ctx2.newPage();
  await p2.goto(`${orgUrl}#/company/projects/add?repo=acme%2Fsketchbook`);
  await p2
    .getByText(/having trouble|can't see|reach/)
    .first()
    .waitFor({ timeout: 15000 });
  const body = await p2.locator("inc-app").innerText();
  ok(
    !/Can't reach i\.inc/.test(body) && !/\b(500|502|503)\b/.test(body),
    'a GitHub failure is a sentence, not "Can\'t reach i.inc" or a status code',
  );
  await shot(p2, combos[0], "github-failing");
  await ctx2.close();
  await stubCall(ORG, { op: "fail", fail: null });
} finally {
  await browser.close();
  for (const s of servers) s.kill();
}

// ---- 3. The checker: contrast, overlap, tap targets, names, in every combination. ----
console.log("\n== ui-check");
const check = join(root, "tools/ui-check/check.mjs");
const beforeNew = join(outDir, "before-new-steps.js");
writeFileSync(
  beforeNew,
  `localStorage.setItem("inc.new-project", JSON.stringify({ name: "fresh-start", visibility: "private", template: "web", mode: "owner-merges", description: "", via: "manual" }));\nlocation.hash = "#/company/projects/new";\nawait new Promise((r) => setTimeout(r, 1500));`,
);
const beforeForeign = join(outDir, "before-new-foreign.js");
writeFileSync(
  beforeForeign,
  `localStorage.setItem("inc.new-project", JSON.stringify({ name: "recipes", visibility: "private", template: "web", mode: "direct", description: "", via: "manual" }));\nlocation.hash = "#/company/projects/new";\nawait new Promise((r) => setTimeout(r, 1500));`,
);
const servers2 = [await start("org", ORG), await start("personal", PERSONAL)];
try {
  for (const combo of combos) {
    const targets = [
      [`http://127.0.0.1:${ORG.port}/#/company/projects`, null],
      [`http://127.0.0.1:${ORG.port}/#/company/projects/Duet`, null],
      [`http://127.0.0.1:${ORG.port}/#/company/projects/add?repo=acme%2Fnotes-api`, null],
      [`http://127.0.0.1:${ORG.port}/#/company/projects/new`, null],
      [`http://127.0.0.1:${PERSONAL.port}/#/company/projects`, null],
      [`http://127.0.0.1:${PERSONAL.port}/#/company/projects`, beforeNew],
      [`http://127.0.0.1:${PERSONAL.port}/#/company/projects`, beforeForeign],
    ];
    for (const [url, before] of targets) {
      const argv = [
        check,
        "--out",
        join(outDir, `ui-check-${combo.name}`),
        "--size",
        `${combo.width}x${combo.height}`,
        ...(combo.scheme === "dark" ? ["--dark"] : []),
        ...(before ? ["--before", before] : []),
        url,
      ];
      let out = "";
      let code = 0;
      try {
        out = execFileSync("node", argv, {
          encoding: "utf8",
          env: process.env,
        });
      } catch (e) {
        out = String(e.stdout ?? e.message);
        code = e.status ?? 1;
      }
      const errs = out.split("\n").filter((l) => /^\s+error /.test(l));
      const warns = out
        .split("\n")
        .filter(
          (l) =>
            /^\s+warn\s+(target|near-miss|sparse|overflow|clipped)/.test(l) &&
            (combo.phone || !/target/.test(l)),
        );
      ok(
        code === 0 && errs.length === 0,
        `ui-check ${combo.name} ${url.replace(/^http:\/\/127\.0\.0\.1:\d+\//, "")}${errs.length ? `\n      ${errs.join("\n      ")}` : ""}`,
      );
      for (const w of warns) console.log(`       ${w.trim()}`);
    }
  }
} finally {
  for (const s of servers2) s.kill();
}

console.log(failures.length ? `\n${failures.length} problem(s)` : "\nall passed");
console.log(`screenshots: ${outDir}`);
process.exit(failures.length ? 1 : 0);
