#!/usr/bin/env node
// End-to-end run of push for conversations (T65) in Chromium, against a local daemon in a scratch HOME. The
// agent behind the conversation is the scripted fake ACP agent, and the push sender is a fake that records what
// the daemon sends (apps/daemon/test/ahp/e2e-server.ts), so no real push key, subscription, sandbox or network
// is involved.
//
//   pnpm --filter @i-inc/web build
//   node tools/e2e/conversation-push/run.mjs [--out dir]
//
// It checks, in the real app:
//   1. a permission request while no client is watching gives exactly one recorded push, with the employee's
//      name, a short label, the conversation's tag and a link that carries only ids;
//   2. opening that link lands on the focused card (first button focused, outlined);
//   3. answering it records a "resolve" push with the same tag;
//   4. while the app is open on the conversation (page visible and focused), a new request is not pushed;
//   5. the old link, opened after the card was answered, says "Already answered on another device".
// Exit code 1 when anything fails.
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
const home = mkdtempSync(join(tmpdir(), "i-inc-e2e-push-"));
const PORT = 7461;
const base = `http://127.0.0.1:${PORT}`;
const GRACE = 1200;

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
const server = spawn("bun", [join(root, "apps/daemon/test/ahp/e2e-server.ts")], {
  env: { ...process.env, HOME: home, I_INC_HOME: home, PORT: String(PORT), E2E_PUSH_GRACE: String(GRACE) },
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

const pushes = async () => (await (await fetch(`${base}/__e2e/pushes`)).json()).pushes;
const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", host: `127.0.0.1:${PORT}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

/** A bare AHP client (no page, so nobody is "watching"): starts a turn in a chat. */
async function startTurn(conv, text, turnId) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ahp`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ahp socket failed"));
  });
  let id = 1;
  const wait = new Map();
  ws.onmessage = (m) => {
    const f = JSON.parse(m.data);
    if (f.id !== undefined) wait.get(f.id)?.(f);
  };
  const rpc = (method, params) =>
    new Promise((res) => {
      const n = id++;
      wait.set(n, res);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
    });
  await rpc("initialize", {
    channel: "ahp-root://",
    protocolVersions: ["1.0.0"],
    clientId: `e2e-${turnId}`,
    initialSubscriptions: ["ahp-root://", conv.ahpSession, conv.ahpChat],
  });
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "dispatchAction",
      params: {
        channel: conv.ahpChat,
        clientSeq: 1,
        action: {
          type: "chat/turnStarted",
          turnId,
          startedAt: new Date().toISOString(),
          message: { text, origin: { kind: "user" } },
        },
      },
    }),
  );
  return () => ws.close();
}

/** Inside the page: the deepest focused element's description, through shadow roots. */
const focusedInfo = () => {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el ? `${el.tagName.toLowerCase()}${el.dataset?.option ? `[${el.dataset.option}]` : ""}` : "none";
};
/** Inside the page: the card for this tool call (through shadow roots), and the thread's note. */
const cardState = (id) => {
  const all = (node, sel, out = []) => {
    out.push(...(node.querySelectorAll?.(sel) ?? []));
    for (const child of node.querySelectorAll?.("*") ?? [])
      if (child.shadowRoot) all(child.shadowRoot, sel, out);
    return out;
  };
  const tool = all(document, "inc-conv-tool").find((t) => t.call?.toolCallId === id);
  const note = all(document, ".card-note")[0];
  return {
    tool: !!tool,
    outline: tool?.style.outlineStyle ?? "",
    firstButton: tool?.shadowRoot?.querySelector("button[data-option]")?.dataset.option ?? "",
    toolFocused: !!tool?.shadowRoot?.activeElement,
    note: note?.textContent?.replace(/\s+/g, " ").trim() ?? "",
  };
};
/** Inside the page: presses the card's "Allow once". */
const allowOnce = (id) => {
  const all = (node, sel, out = []) => {
    out.push(...(node.querySelectorAll?.(sel) ?? []));
    for (const child of node.querySelectorAll?.("*") ?? [])
      if (child.shadowRoot) all(child.shadowRoot, sel, out);
    return out;
  };
  // the id repeats from turn to turn (the fake agent): the one still waiting has the button
  all(document, "inc-conv-tool")
    .filter((t) => t.call?.toolCallId === id)
    .map((t) => t.shadowRoot?.querySelector("button[data-option=allow-once]"))
    .find(Boolean)
    ?.click();
};
const CARD = "tc-edit";

let browser;
try {
  await until(() => log.includes("e2e daemon on"), 20_000, "the daemon to start");
  const made = await api("POST", "/api/conversations", { employeeId: "ada", mode: "default" });
  const conv = made.conversation;
  ok(!!conv?.id, `made a conversation (${conv?.id}) in "Always ask" mode`);

  // 1. A request while nobody is watching: one push.
  const close1 = await startTurn(conv, "please edit the constant", "turn-1");
  const first = await until(async () => (await pushes()).find((p) => !p.resolve), 15_000, "the push");
  ok(first.title === "Ada needs you", `title is "${first.title}"`);
  ok(first.body === "Edit: src/app.ts", `body is "${first.body}"`);
  ok(first.tag === `conv-${conv.id}`, "one tag per conversation");
  ok(first.url === `#/conversations/${conv.id}?card=tc-edit`, `link carries only ids: ${first.url}`);
  ok(!JSON.stringify(first).includes("answer = 4"), "no file contents in the push");
  await sleep(GRACE * 2);
  ok((await pushes()).filter((p) => !p.resolve).length === 1, "exactly one push for the request");

  // 2. Opening the link lands on the focused card (a cold start, as from a tap with the app closed).
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
    isMobile: true,
  });
  const page = await phone.newPage();
  await page.goto(`${base}/${first.url}`);
  await until(async () => (await page.evaluate(cardState, CARD)).tool, 15_000, "the card");
  await until(
    async () => (await page.evaluate(cardState, CARD)).outline === "solid",
    5_000,
    "the card's outline",
  );
  const st = await page.evaluate(cardState, CARD);
  ok(st.firstButton === "allow-once", `the card's first button is "${st.firstButton}"`);
  ok(st.toolFocused, `focus is on the card: ${await page.evaluate(focusedInfo)}`);
  ok(st.note === "", "no 'already answered' note while it is waiting");
  await page.screenshot({ path: join(outDir, "card-390.png") });

  // 3. Answering closes the notification (a resolve push with the same tag).
  await page.evaluate(allowOnce, CARD);
  const resolved = await until(
    async () => (await pushes()).find((p) => p.resolve),
    10_000,
    "the resolve push",
  );
  ok(resolved.tag === first.tag, "the resolve push has the same tag");
  close1();

  // 4. The app is open on the conversation (visible, focused): a new request is not pushed.
  await page.goto(`${base}/#/conversations/${conv.id}`);
  await page.bringToFront();
  await until(
    async () => (await page.evaluate(() => document.hasFocus())) === true,
    5_000,
    "the page to be focused",
  );
  await sleep(1500); // the first presence report
  const before = (await pushes()).filter((p) => !p.resolve).length;
  const close2 = await startTurn(conv, "please edit the constant again", "turn-2");
  await until(async () => (await page.evaluate(cardState, CARD)).tool, 15_000, "the second card");
  await sleep(GRACE * 3);
  ok(
    (await pushes()).filter((p) => !p.resolve).length === before,
    "no push while the app is open on the conversation",
  );
  await page.screenshot({ path: join(outDir, "watching-390.png") });

  // 5. The old link, after the card was answered (and a fresh page, so nothing remembers who answered).
  await page.evaluate(allowOnce, CARD);
  await until(
    async () => (await api("GET", `/api/conversations/${conv.id}`)).conversation.needsYou === false,
    10_000,
    "the second card to be answered",
  );
  close2();
  const other = await phone.newPage();
  await other.goto(`${base}/${first.url}`);
  const note = await until(
    async () => (await other.evaluate(cardState, CARD)).note,
    15_000,
    "the already-answered note",
  );
  ok(note.startsWith("Already answered on another device"), `the old link says: "${note}"`);
  await other.screenshot({ path: join(outDir, "answered-390.png") });
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
