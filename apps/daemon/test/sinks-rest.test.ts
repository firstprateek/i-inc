// The REST, GitHub and push sinks (r131), and the two entry changes (G4 retro edits, G6 stale-delete diffs).
// The route sweep calls every GET route in api.ts over stores seeded with canaries, so a new route that serves
// agent text without the sink fails here.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TicketEvent } from "@i-inc/core";
import { json } from "@i-inc/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { redactProse } from "../src/ahp/sanitize.ts";
import { forDiff, lineDiff } from "../src/brain-check.ts";
import { PullRequests } from "../src/github.ts";
import { generateVapidKeys, WebPushSender } from "../src/push.ts";
import { sinkMemos, sinkRedactors, sinkStats } from "../src/sinks.ts";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";
import { ALL, CANARIES, SHAPES, visible } from "./canaries.ts";
import { fakeTokens } from "./fake-tokens.ts";
import { refunds, testApp } from "./setup.ts";

const real = { ...sinkRedactors };
afterEach(() => {
  Object.assign(sinkRedactors, real);
  for (const m of Object.values(sinkMemos)) m.clear();
});
const asMain = () => {
  sinkRedactors.last = (s) => s;
  sinkRedactors.prose = (s) => s;
  sinkRedactors.text = (s) => s;
  for (const m of Object.values(sinkMemos)) m.clear();
};

/** What the owner typed: it stays as typed in the owner's own views (decision 1). Not a canary the sweep counts. */
const OWNER_TITLE = "Owner's own postgres://app:ab/OwnerTyped1@db.example/app";
const OWNER_NOTE = "owner note build9sk-OwnerTyped2aBcDeFgHiJkLm";

type App = Awaited<ReturnType<typeof testApp>>;

/** Every store a GET route reads, seeded with every canary as an agent (or the daemon) would write it. */
async function seeded() {
  const app = await testApp();
  const d = app.deps;
  const now = app.clock.now();
  const at = now;
  const ownerTicket = d.tickets.create(
    {
      title: OWNER_TITLE,
      project: "Duet",
      type: "fix",
      effort: "low",
      doneWhen: [OWNER_TITLE],
      assignee: "ada",
      hold: true,
    },
    now,
  );
  const agentTicket = d.tickets.create(
    {
      title: `Follow up ${SHAPES[0]?.text}`,
      project: "Duet",
      type: "fix",
      effort: "low",
      doneWhen: [ALL],
      reason: ALL,
      createdBy: "ada",
      assignee: "ada",
      hold: true,
    },
    now,
  );
  const stuck = d.tickets.create(
    {
      title: `Stuck ${SHAPES[1]?.text}`,
      project: "Duet",
      type: "fix",
      effort: "low",
      doneWhen: [],
      createdBy: "ada",
      assignee: "ada",
      hold: true,
    },
    now,
  );
  const agentEvents = (id: string) =>
    [
      { type: "ticket-created", at, ticketId: id },
      { type: "stage-started", at, stage: "plan" },
      {
        type: "session-started",
        at,
        stage: "plan",
        employeeId: "ada",
        engineId: "claude-opus",
        resume: false,
      },
      { type: "checkpoint", at, stage: "plan", note: ALL },
      { type: "stage-finished", at, stage: "plan", output: ALL },
      { type: "checks-ran", at, green: false, failures: [ALL] },
      { type: "proof", at, items: [{ doneWhen: ALL, pass: true, evidence: ALL }] },
      {
        type: "knowledge-proposed",
        at,
        employeeId: "ada",
        apply: [],
        awaitOwner: [{ layer: "policy", page: "policies/deploys.md", text: ALL }],
      },
      { type: "owner-message", at, text: OWNER_NOTE },
      { type: "report-ready", at, summary: ALL },
    ] as TicketEvent[];
  await d.store.append(ownerTicket.id, agentEvents(ownerTicket.id));
  await d.store.append(agentTicket.id, agentEvents(agentTicket.id));
  await d.store.append(stuck.id, [
    { type: "ticket-created", at, ticketId: stuck.id },
    { type: "stage-started", at, stage: "build" },
    { type: "needs-you", at, stage: "build", ask: { kind: "stuck", reason: ALL } },
  ] as TicketEvent[]);
  d.proposals.add(
    {
      project: "Duet",
      title: `Proposal ${SHAPES[2]?.text.slice(0, 120)}`,
      body: ALL,
      proposedBy: "ada",
      sourceTicket: agentTicket.id,
      type: "fix",
      effort: "low",
      doneWhen: [ALL],
    },
    now,
  );
  const sid = d.sessions.start(agentTicket.id, "plan", "ada", "claude-opus");
  for (const c of CANARIES) d.sessions.recordItem(sid, { kind: "text", text: c.text, at: now });
  d.sessions.recordItem(sid, {
    kind: "tool",
    title: SHAPES[0]?.text ?? "",
    status: SHAPES[3]?.text ?? "",
    at: now,
  });
  // A rejected brain change as main's stale-delete path stored it: the agent's raw base in the diff (G6).
  d.db.run(
    `INSERT INTO brain_changes (harvest, at, status, employee_id, ref_kind, ref_id, scope, slug, path, op, code, reason, sha, diff)
     VALUES ('h1', ?, 'rejected', 'ada', 'ticket', ?, 'brain:ada', 'notes', 'brain/notes.md', 'delete', 'stale', ?, 'abc', ?)`,
    now,
    agentTicket.id,
    `stale: ${SHAPES[3]?.text}`,
    lineDiff(
      forDiff(`---\ntitle: Notes\ndescription: Notes kept by Ada.\n---\n${ALL}\n`, "notes"),
      null,
    ).slice(0, 4000),
  );
  // A conversation the agent named, with a shape in the title.
  d.db.run(
    `INSERT INTO conversations (id, employee_id, project, branch, title, mode, engine_id, created_at, archived_at, ahp_session, ahp_chat)
     VALUES ('c1', 'ada', 'Duet', 'conv/c1', ?, NULL, 'claude-opus', ?, NULL, 'ahp-session:/c1', 'ahp-chat:/c1')`,
    `About ${SHAPES[0]?.text}`,
    now,
  );
  // The helper chat is the owner's own (G10): left out of the sinks on purpose.
  d.chatLog.add("ada", { from: "employee", text: ALL, at: now } as never);
  return { app, ownerTicket, agentTicket, stuck };
}

/** The GET routes api.ts declares, read from its source. */
function getRoutes(): string[] {
  const src = readFileSync(join(import.meta.dirname, "../src/api.ts"), "utf8");
  return [...src.matchAll(/\[\s*"GET",\s*"(\/api\/[^"]*)"/g)].map((m) => m[1] as string);
}

/**
 * Routes that may show a canary, and why. Anything else that shows one fails: a new route that serves agent text
 * has to go through a sink (sinks.ts) or be added here on purpose.
 */
const ALLOWED: Record<string, string> = {
  "/api/chat": "the helper chat is the owner's own (G10), out of scope",
  "/api/chat/:id": "the helper chat is the owner's own (G10), out of scope",
};
/** Routes the sweep can't call as a plain GET: they stream, or serve bytes. */
const SKIPPED: Record<string, string> = {
  "/api/events": "a stream of ids that never ends",
  "/api/tickets/:id/attachments/:n": "the owner's image bytes",
};

function fill(route: string, ids: { agent: string; stuck: string }): string[] {
  const q: Record<string, string> = {
    "/api/board/column": "?column=review",
    "/api/board/cards": `?ids=1,${ids.agent},${ids.stuck}`,
    "/api/brain/search": "?q=notes",
  };
  const base = route
    .replace(":owner", "o")
    .replace(":name", "r")
    .replace(/^\/api\/projects\/:id/, "/api/projects/Duet")
    .replace(/^\/api\/(chat|knowledge\/brains)\/:id/, "/api/$1/ada")
    .replace(/^\/api\/conversations\/:id/, "/api/conversations/c1");
  if (base.includes("/api/tickets/:id"))
    return [base.replace(":id", ids.agent), base.replace(":id", ids.stuck), base.replace(":id", "1")];
  if (base.includes("/api/board/column"))
    return ["todo", "in-progress", "review", "done"].map((c) => `${base}?column=${c}`);
  return [base.replace(/:[a-z]+/g, "x") + (q[route] ?? "")];
}

async function sweep(app: App, ids: { agent: string; stuck: string }) {
  const out: Record<string, { status: number; body: string }[]> = {};
  for (const route of getRoutes()) {
    if (SKIPPED[route]) continue;
    out[route] = [];
    for (const path of fill(route, ids)) {
      const res = await app.handle(new Request(`http://i.inc${path}`));
      out[route].push({ status: res.status, body: await res.text() });
    }
  }
  return out;
}

describe("the route sweep", () => {
  it("knows every GET route, and none shows a canary but the ones allowed", async () => {
    const { app, agentTicket, stuck } = await seeded();
    await app.daemon.tick();
    const ids = { agent: agentTicket.id, stuck: stuck.id };
    const routes = getRoutes();
    expect(routes.length).toBeGreaterThan(40);
    const bodies = await sweep(app, ids);
    const leaks: string[] = [];
    for (const [route, list] of Object.entries(bodies)) {
      if (ALLOWED[route]) continue;
      for (const { body } of list) for (const name of visible(body)) leaks.push(`${route}: ${name}`);
    }
    expect(leaks).toEqual([]);
    // the seeds were served: the sweep is not passing on empty answers
    const served = (r: string) => (bodies[r] ?? []).map((b) => b.body).join("");
    expect(served("/api/tickets/:id")).toContain("[redacted]");
    expect(served("/api/tickets/:id/sessions")).toContain("[redacted]");
    expect(served("/api/brain/changes")).toContain("[redacted]");
    expect(served("/api/proposals")).toContain("[redacted]");
    expect(served("/api/needs-you")).toContain("[redacted]");
    expect(served("/api/conversations")).toContain("About db postgres://[redacted]@db.example/app ok");
    expect(served("/api/conversations/:id")).toContain("[redacted]");
    expect(visible(served("/api/chat/:id"))).not.toEqual([]); // the allowed route really holds them
  });

  it("differential: with the sinks off (main's wire) the same routes show the canaries, and storage is the same", async () => {
    const dump = (app: App) =>
      ["events", "tickets", "proposals", "ticket_session_items", "brain_changes", "chat"]
        .map((t) => JSON.stringify(app.deps.db.all(`SELECT * FROM ${t} ORDER BY rowid`)))
        .join("\n");
    const ours = await seeded();
    const before = dump(ours.app);
    const shownOurs = await sweep(ours.app, { agent: ours.agentTicket.id, stuck: ours.stuck.id });
    expect(dump(ours.app)).toBe(before); // reading through the sinks writes nothing
    asMain();
    const main = await seeded();
    const shownMain = await sweep(main.app, { agent: main.agentTicket.id, stuck: main.stuck.id });
    let mainShows = 0;
    let oursShows = 0;
    for (const [route, list] of Object.entries(shownOurs)) {
      list.forEach((b, i) => {
        const m = visible(shownMain[route]?.[i]?.body ?? "");
        if (!ALLOWED[route]) {
          mainShows += m.length;
          oursShows += visible(b.body).length;
        }
        for (const name of visible(b.body)) expect(m, `${route}: ${name}`).toContain(name);
      });
    }
    // main's wire shows them on routes where ours shows none
    expect(mainShows).toBeGreaterThan(0);
    expect(oursShows).toBe(0);
    expect(dump(main.app).replace(/"at":\d+/g, "")).toBe(before.replace(/"at":\d+/g, ""));
  });

  it("leaves the owner's own words as typed in the owner's views", async () => {
    const { app, ownerTicket } = await seeded();
    const t = await app.call("GET", `/api/tickets/${ownerTicket.id}`);
    expect(t.body.ticket.title).toBe(OWNER_TITLE);
    expect(t.body.ticket.doneWhen).toEqual([OWNER_TITLE]);
    expect(t.body.events.find((e: { type: string }) => e.type === "owner-message").text).toBe(OWNER_NOTE);
    // and the agent's words in the same ticket are hidden
    expect(
      visible(JSON.stringify(t.body.events.filter((e: { type: string }) => e.type !== "owner-message"))),
    ).toEqual([]);
  });

  it("serves no REST body but through json()", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/api.ts"), "utf8");
    const raw = [...src.matchAll(/new Response\(JSON\.stringify\(/g)];
    expect(raw.length).toBe(1);
    expect(src).toMatch(
      /function json\(body: unknown[^)]*\): Response \{\n {2}return new Response\(JSON\.stringify\(/,
    );
  });

  it("a repeat read of a ticket is served from the memo", async () => {
    const { app, agentTicket } = await seeded();
    await app.call("GET", `/api/tickets/${agentTicket.id}`);
    const misses = sinkMemos.people.misses;
    const hits = sinkMemos.people.hits;
    const prose = sinkStats.prose;
    await app.call("GET", `/api/tickets/${agentTicket.id}`);
    expect(sinkMemos.people.misses).toBe(misses);
    expect(sinkMemos.people.hits).toBeGreaterThan(hits);
    // only strings too short to memoise were redacted again
    expect(sinkStats.prose - prose).toBeLessThan(40);
  });
});

describe("what leaves the machine", () => {
  const capture = () => {
    const calls: { url: string; body: string }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({ number: 7, html_url: "https://github.com/o/r/pull/7", node_id: "N" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  };

  it("a pull request's title and body, opened and set, hold no canary", async () => {
    const { calls, fetch } = capture();
    const prs = new PullRequests(fakeTokens(), { fetch });
    await prs.openDraft("o/r", { head: "h", base: "main", title: `fix: ${SHAPES[3]?.text}`, body: ALL });
    await prs.setBody("o/r", 7, `## Report\n${ALL}`);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(visible(c.body)).toEqual([]);
    const sent = JSON.parse(calls[0]?.body ?? "{}");
    expect(sent.head).toBe("h");
    expect(sent.draft).toBe(true);
    // with nothing to hide, it is what was given
    const quiet = capture();
    await new PullRequests(fakeTokens(), { fetch: quiet.fetch }).openDraft("o/r", {
      head: "h",
      base: "main",
      title: "fix: refunds",
      body: "- August drops by the refund",
    });
    expect(JSON.parse(quiet.calls[0]?.body ?? "{}")).toMatchObject({
      title: "fix: refunds",
      body: "- August drops by the refund",
    });
  });

  it("a push's title and body hold no canary", async () => {
    const app = await testApp();
    app.deps.registry.addPushSubscription({ endpoint: "https://push.example/sub" });
    const sent: string[] = [];
    const sender = new WebPushSender(app.deps.registry, {
      vapid: generateVapidKeys(),
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        sent.push(String(init?.body ?? ""));
        return new Response("", { status: 201 });
      }) as unknown as typeof fetch,
    });
    await sender.send({ title: `Needs you · ${SHAPES[0]?.text}`, body: ALL, url: "#/ticket/1" });
    expect(sent.length).toBe(1);
    const payload = JSON.parse(sent[0] ?? "{}");
    expect(payload.url).toBe("#/ticket/1");
    expect(payload.body).toContain("[redacted]");
    expect(visible(sent.join(""))).toEqual([]);
  });
});

/** The canaries `redactProse` hides on its own: what an entry change with it must leave out of what is stored. */
const PROSE_HIDES = CANARIES.filter((c) => !redactProse(c.text).includes(c.secret));

describe("entry changes", () => {
  afterEach(cleanRigs);

  it("G4: a retro edit is written to the brain with redactProse, in the page, its description and git", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-inc-g4-"));
    const app = await testApp(":memory:", dir);
    app.agent.on(
      { employee: "ada", stage: "retro" },
      {
        kind: "done",
        output: json({
          edits: [{ layer: "fact", page: "deploys", text: `Deploy with ${CANARIES[0]?.text}.\n${ALL}` }],
        }),
      },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    await app.call("POST", "/api/tickets/1/decide", { decision: "approve" });
    await app.daemon.idle();
    const file = readFileSync(join(dir, "handbook", "facts", "deploys.md"), "utf8");
    expect(file).toContain("[redacted]");
    expect(visible(file, PROSE_HIDES)).toEqual([]);
    const log = execFileSync("git", ["-C", join(dir, "handbook"), "log", "-p"], { encoding: "utf8" });
    expect(log).toContain("facts/deploys.md");
    expect(visible(log, PROSE_HIDES)).toEqual([]);
  });

  it("G6: a stale delete stores the redacted base in its diff, not the agent's raw one", async () => {
    const w = await brainRig();
    const body = `Deploys matter because the owner reads these pages first.\nThe second line explains it.\n${ALL}\n`;
    // a page whose text was never redacted (an old one, or one the agent's raw base still holds)
    w.commit("handbook", { "facts/deploy.md": page("Deploy", "How deploys go", body) });
    await w.feed.sync("ada");
    w.commit("handbook", {
      "facts/deploy.md": page("Deploy", "How deploys go", `${body}Edited meanwhile.\n`),
    });
    rmSync(w.copy("ada", "company/facts/deploy.md"), { force: true });
    const report = await w.app.deps.brainHarvest.run({
      employeeId: "ada",
      source: { kind: "ticket", id: "14" },
      trigger: "ticket-end",
    });
    expect(report).toMatchObject({ committed: 0, rejected: 1 });
    const [row] = w.app.deps.db.all<{ code: string; diff: string }>(
      "SELECT code, diff FROM brain_changes WHERE status = 'rejected'",
    );
    expect(row?.code).toBe("stale");
    expect(row?.diff).toContain("[redacted]");
    expect(visible(row?.diff ?? "", PROSE_HIDES)).toEqual([]);
    // and the feed shows none of them
    const shown = JSON.stringify((await w.call("GET", "/api/brain/changes")).body);
    expect(visible(shown)).toEqual([]);
  });
});
