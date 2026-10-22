// The daemon's side of automatic deploys (contract C21): GET /api/health, GET /api/deploys, the push
// for a failed deploy, and the version a release reports.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgent, FakeChat, FakeClock, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";
import { DeployNotifier, readDeploys, resolveVersion } from "../src/deploys.ts";
import type { NotificationPayload, PushService } from "../src/push.ts";
import { refunds } from "./setup.ts";

const SHA = `${"a".repeat(39)}1`;
const OTHER = `${"b".repeat(39)}2`;
const HOST = "127.0.0.1:7420";

class RecordingPush implements PushService {
  sent: NotificationPayload[] = [];
  fail = false;
  publicKey() {
    return "k";
  }
  async send(n: NotificationPayload) {
    if (this.fail) throw new Error("push service down");
    this.sent.push(n);
  }
  async subscribe() {}
  async unsubscribe() {}
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i-inc-deploys-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const entry = (over: Record<string, unknown> = {}) => ({
  at: 1_700_000_000_000,
  sha: SHA,
  from: OTHER,
  outcome: "deployed",
  reason: "",
  durationMs: 1234,
  ...over,
});
const jsonl = (...lines: unknown[]) =>
  `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`;

async function guarded(extra: { deploysPath?: string; push?: RecordingPush; version?: string } = {}) {
  const clock = new FakeClock();
  const agent = new FakeAgent();
  const push = extra.push ?? new RecordingPush();
  const app = await createApp({
    dbPath: ":memory:",
    knowledgeDir: join(dir, "knowledge"),
    configDir: join(dir, "config"),
    clock,
    agent,
    harness: new FakeHarness(),
    helper: new FakeHelper(),
    chat: new FakeChat(),
    machines: new FakeMachines(),
    push,
    token: "s3cret-token",
    hosts: [HOST],
    ...(extra.deploysPath ? { deploysPath: extra.deploysPath } : {}),
    ...(extra.version ? { version: extra.version } : {}),
  });
  seedDemo(app.deps.registry);
  app.daemon.ensureKnowledge();
  const send = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const res = await app.handle(
      new Request(`http://${HOST}${path}`, {
        method,
        headers: {
          host: HOST,
          ...(method === "GET" ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const authed = { authorization: "Bearer s3cret-token" };
  return { app, push, send, authed, agent, clock };
}

describe("GET /api/health", () => {
  it("answers without a login with the version, busy and startedAt, and nothing else", async () => {
    const { send, clock } = await guarded({ version: SHA });
    expect((await send("GET", "/api/board")).status).toBe(401);
    const res = await send("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: SHA, busy: false, startedAt: clock.now() });
  });

  it("says unknown when the release does not know its sha", async () => {
    const { send } = await guarded();
    expect((await send("GET", "/api/health")).body.version).toBe("unknown");
  });

  it("keeps the Host guard", async () => {
    const { send } = await guarded();
    const res = await send("GET", "/api/health", { host: "evil.example:7420" });
    expect(res.status).toBe(421);
  });

  it("leaks no secret: not the token, the dir, or any path", async () => {
    const { send } = await guarded({ version: SHA, deploysPath: join(dir, "deploys.jsonl") });
    const text = JSON.stringify((await send("GET", "/api/health")).body);
    expect(text).not.toContain("s3cret-token");
    expect(text).not.toContain(dir);
  });

  it("is busy while a ticket session runs, and idle again after", async () => {
    const { app, send, agent, authed } = await guarded();
    agent.on({ stage: "build" }, { kind: "hang" });
    expect((await send("POST", "/api/tickets", authed, refunds)).status).toBeLessThan(300);
    while (!agent.callsFor("ada", "build").length) await new Promise((r) => setTimeout(r, 0));
    expect((await send("GET", "/api/health")).body.busy).toBe(true);
    expect(app.daemon.interrupt("1", "ada")).toBe(true);
    await app.daemon.idle();
    expect((await send("GET", "/api/health")).body.busy).toBe(false);
  });

  it("is busy during a counted turn and when a registered hook says so", async () => {
    const { app, send } = await guarded();
    let release: () => void = () => {};
    const turn = app.daemon.track(new Promise<void>((r) => (release = r)));
    expect((await send("GET", "/api/health")).body.busy).toBe(true);
    release();
    await turn;
    expect((await send("GET", "/api/health")).body.busy).toBe(false);
    let conversationRunning = true;
    app.daemon.onBusy(() => conversationRunning);
    expect((await send("GET", "/api/health")).body.busy).toBe(true);
    conversationRunning = false;
    expect((await send("GET", "/api/health")).body.busy).toBe(false);
  });

  it("is busy while an owner chat turn is being answered (removing daemon.track around it fails this)", async () => {
    const { app, send, authed } = await guarded();
    let finish: () => void = () => {};
    const gate = new Promise<void>((r) => (finish = r));
    const chat = app.deps.chat as FakeChat;
    const original = chat.answer.bind(chat);
    chat.answer = async (request) => {
      await gate;
      return original(request);
    };
    const reply = send("POST", "/api/chat/kit", authed, { text: "Why US dates?" });
    let sawBusy = false;
    for (let i = 0; i < 200 && !sawBusy; i++) {
      sawBusy = (await send("GET", "/api/health")).body.busy === true;
      if (!sawBusy) await new Promise((r) => setTimeout(r, 0));
    }
    expect(sawBusy).toBe(true);
    finish();
    expect((await reply).status).toBe(200);
    expect((await send("GET", "/api/health")).body.busy).toBe(false);
  });

  it("is busy while a long-running write such as a project bootstrap runs", async () => {
    const { app, send, authed } = await guarded();
    // The handler answers 400 at once for a bad name, so hold the route open with a slow body read.
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    const req = new Request(`http://${HOST}/api/projects/newproj/bootstrap`, {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json", ...authed },
      body: new ReadableStream({
        async start(controller) {
          await hold;
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      }),
      // @ts-expect-error duplex is required for a streamed body
      duplex: "half",
    });
    const pending = app.handle(req);
    let sawBusy = false;
    for (let i = 0; i < 200 && !sawBusy; i++) {
      sawBusy = (await send("GET", "/api/health")).body.busy === true;
      if (!sawBusy) await new Promise((r) => setTimeout(r, 0));
    }
    expect(sawBusy).toBe(true);
    release();
    await pending;
    expect((await send("GET", "/api/health")).body.busy).toBe(false);
  });

  it("counts a turn that throws as finished", async () => {
    const { app } = await guarded();
    await expect(app.daemon.track(Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(app.daemon.busy()).toBe(false);
  });
});

describe("GET /api/deploys", () => {
  it("needs the login", async () => {
    const { send } = await guarded({ deploysPath: join(dir, "deploys.jsonl") });
    expect((await send("GET", "/api/deploys")).status).toBe(401);
  });

  it("is empty with no record, and lists the last 20 newest first, skipping damaged lines", async () => {
    const path = join(dir, "deploys.jsonl");
    const { send, authed } = await guarded({ deploysPath: path });
    expect((await send("GET", "/api/deploys", authed)).body).toEqual({ deploys: [] });
    const lines: unknown[] = [];
    for (let i = 1; i <= 25; i++) lines.push(entry({ at: i, reason: `n${i}` }));
    lines.splice(3, 0, "{not json", { at: "x" }, entry({ outcome: "exploded" }));
    writeFileSync(path, jsonl(...lines));
    const res = await send("GET", "/api/deploys", authed);
    const deploys = res.body.deploys as Array<{ at: number }>;
    expect(deploys).toHaveLength(20);
    expect(deploys[0]?.at).toBe(25);
    expect(deploys[19]?.at).toBe(6);
  });

  it("returns exactly the documented fields", () => {
    const path = join(dir, "deploys.jsonl");
    writeFileSync(path, jsonl({ ...entry(), extra: "ignored" }, entry({ from: null })));
    const [newest, older] = readDeploys(path);
    expect(Object.keys(newest ?? {}).sort()).toEqual([
      "at",
      "durationMs",
      "from",
      "outcome",
      "reason",
      "sha",
    ]);
    expect(newest?.from).toBeNull();
    expect(older?.from).toBe(OTHER);
  });
});

describe("push for a failed deploy", () => {
  const now = 1_700_000_100_000;
  const make = (
    path: string,
    push: RecordingPush | undefined,
    app: Awaited<ReturnType<typeof guarded>>["app"],
  ) => new DeployNotifier({ path, db: app.db, push, now: () => now });

  it("sends one push for a rolled-back deploy, with the sha and reason, and never repeats it", async () => {
    const path = join(dir, "deploys.jsonl");
    const { app, push } = await guarded({ deploysPath: path });
    writeFileSync(
      path,
      jsonl(entry({ outcome: "rolled-back", reason: "the new daemon did not report version aaaaaaa" })),
    );
    const notifier = make(path, push, app);
    expect(await notifier.check()).toBe(1);
    expect(await notifier.check()).toBe(0);
    expect(await make(path, push, app).check()).toBe(0); // a restarted daemon
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.title).toBe("Deploy of aaaaaaa failed");
    expect(push.sent[0]?.body).toBe(
      "Deploy of aaaaaaa failed: the new daemon did not report version aaaaaaa — rolled back",
    );
    expect(push.sent[0]?.url).toBe("#/desk");
  });

  it("sends for later failures, and says the old release keeps running when nothing was switched", async () => {
    const path = join(dir, "deploys.jsonl");
    const { app, push } = await guarded({ deploysPath: path });
    const notifier = make(path, push, app);
    writeFileSync(path, jsonl(entry({ outcome: "rolled-back", reason: "x" })));
    await notifier.check();
    writeFileSync(
      path,
      jsonl(
        entry({ outcome: "rolled-back", reason: "x" }),
        entry({ at: now - 500, outcome: "failed-build", reason: "pnpm install failed" }),
      ),
    );
    expect(await notifier.check()).toBe(1);
    expect(push.sent[1]?.body).toBe("Deploy of aaaaaaa failed: pnpm install failed — bbbbbbb keeps running");
  });

  it("words a rollback by hand as one, not as a failed deploy", async () => {
    const path = join(dir, "deploys.jsonl");
    const { app, push } = await guarded({ deploysPath: path });
    writeFileSync(
      path,
      jsonl(
        entry({ sha: OTHER, from: SHA, outcome: "rolled-back", reason: "rolled back by hand to bbbbbbb" }),
      ),
    );
    await make(path, push, app).check();
    expect(push.sent[0]?.title).toBe("Rolled back by hand");
    expect(push.sent[0]?.body).toBe("Rolled back by hand to bbbbbbb (left aaaaaaa)");
  });

  it("pushes when main was rewritten and the commit was not deployed", async () => {
    const path = join(dir, "deploys.jsonl");
    const { app, push } = await guarded({ deploysPath: path });
    writeFileSync(
      path,
      jsonl(
        entry({
          outcome: "skipped-ancestry",
          reason: "main moved to a commit that does not include the running release bbbbbbb (force-push?)",
        }),
      ),
    );
    expect(await make(path, push, app).check()).toBe(1);
    expect(push.sent[0]?.title).toBe("Deploy of aaaaaaa skipped");
    expect(push.sent[0]?.body).toContain("force-push");
  });

  it("strips absolute home paths from what the API and the push show", async () => {
    const path = join(dir, "deploys.jsonl");
    const { app, push, send, authed } = await guarded({ deploysPath: path });
    writeFileSync(
      path,
      jsonl(entry({ outcome: "failed-build", reason: "ENOENT /Users/padi/i-inc-releases/x/package.json" })),
    );
    const shown = JSON.stringify((await send("GET", "/api/deploys", authed)).body);
    expect(shown).not.toContain("/Users/padi");
    expect(shown).toContain("~/i-inc-releases/x/package.json");
    await make(path, push, app).check();
    expect(push.sent[0]?.body).not.toContain("/Users/padi");
  });

  it("tells the owner when a deploy went ahead to recover a daemon that was down", async () => {
    const path = join(dir, "deploys.jsonl");
    const { app, push } = await guarded({ deploysPath: path });
    writeFileSync(
      path,
      jsonl(
        entry({
          outcome: "deployed",
          reason:
            "recovery: the daemon was down (launchd reports it not running), so this was deployed without waiting for it to drain",
        }),
      ),
    );
    expect(await make(path, push, app).check()).toBe(1);
    expect(push.sent[0]?.title).toBe("Deployed aaaaaaa to recover the daemon");
    expect(push.sent[0]?.body).toContain("launchd reports it not running");
  });

  it("does not push for a success or a skipped-ci", async () => {
    const path = join(dir, "deploys.jsonl");
    const { app, push } = await guarded({ deploysPath: path });
    writeFileSync(
      path,
      jsonl(
        entry({ outcome: "deployed" }),
        entry({ at: now - 1, outcome: "skipped-ci", reason: "CI failed" }),
      ),
    );
    expect(await make(path, push, app).check()).toBe(0);
    expect(push.sent).toEqual([]);
  });

  it("treats old failures as history", async () => {
    const path = join(dir, "deploys.jsonl");
    const { app, push } = await guarded({ deploysPath: path });
    writeFileSync(path, jsonl(entry({ at: now - 7 * 3_600_000, outcome: "rolled-back", reason: "old" })));
    expect(await make(path, push, app).check()).toBe(0);
  });

  it("survives a push service that is down, and a missing file or push", async () => {
    const path = join(dir, "deploys.jsonl");
    const { app, push } = await guarded({ deploysPath: path });
    writeFileSync(path, jsonl(entry({ outcome: "rolled-back", reason: "x" })));
    push.fail = true;
    expect(await make(path, push, app).check()).toBe(0);
    expect(await make(join(dir, "nope.jsonl"), push, app).check()).toBe(0);
    expect(await make(path, undefined, app).check()).toBe(0);
  });
});

describe("the version a release reports", () => {
  const sha = "c".repeat(40);
  it("prefers I_INC_VERSION", () => {
    expect(resolveVersion({ I_INC_VERSION: SHA }, "/x", () => sha)).toBe(SHA);
  });
  it("asks git otherwise, and ignores an empty variable", () => {
    expect(
      resolveVersion(
        { I_INC_VERSION: "" },
        "/x",
        (cmd, args, cwd) => `${cmd} ${args.join(" ")} ${cwd}` && `${sha}\n`,
      ),
    ).toBe(sha);
  });
  it("is unknown when git fails or says something odd", () => {
    expect(
      resolveVersion({}, "/x", () => {
        throw new Error("not a git repository");
      }),
    ).toBe("unknown");
    expect(resolveVersion({}, "/x", () => "fatal")).toBe("unknown");
  });
});
