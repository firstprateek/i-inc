// Push for conversations (T65): a permission or a question nobody is looking at becomes a push that
// opens the card. The clock and the grace timers are driven by hand, the push sender is a fake, and the
// agent is either scripted (fine control) or the fake ACP agent (the real mapper and session host).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgent, FakeChat, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import {
  BODY_MAX,
  ConversationPush,
  commandLabel,
  describeRequest,
  oneLine,
  tagOf,
} from "../../src/ahp/conversation-push.ts";
import { agentsFromRegistry } from "../../src/ahp/conversations.ts";
import { PRESENCE_STALE_MS } from "../../src/ahp/host.ts";
import { SessionHost } from "../../src/ahp/session-host.ts";
import { ActionType, ConfirmationOptionKind, ToolCallConfirmationReason } from "../../src/ahp/wire.ts";
import { createApp } from "../../src/app.ts";
import { seedDemo } from "../../src/demo.ts";
import { FakePushService } from "../../src/push.ts";
import { FakeSandbox } from "./fake-acp.ts";
import { until } from "./session-rig.ts";
import { type Any, gate, ScriptedBackend, TestClient, turnStarted } from "./support.ts";

/** Timers on a clock the test moves. */
class Timers {
  now = 1_800_000_000_000;
  private tasks: { at: number; fn: () => void; live: boolean }[] = [];
  schedule = (fn: () => void, ms: number): (() => void) => {
    const task = { at: this.now + ms, fn, live: true };
    this.tasks.push(task);
    return () => {
      task.live = false;
    };
  };
  get pending(): number {
    return this.tasks.filter((t) => t.live).length;
  }
  /** Moves time forward, running timers as they come due (in order, including ones they add). */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.tasks.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = Math.max(this.now, due.at);
      due.live = false;
      due.fn();
    }
    this.now = end;
    this.tasks = this.tasks.filter((t) => t.live);
  }
}

/** How many requests the session lists as waiting for the owner. */
const waiting = (r: {
  host: { sessionState(u: string): { inputNeeded?: unknown[] } | undefined };
  conv: { ahpSession: string };
}) => r.host.sessionState(r.conv.ahpSession)?.inputNeeded?.length ?? 0;

const confirm = (turnId: string, toolCallId: string, approved: boolean) =>
  approved
    ? {
        type: ActionType.ChatToolCallConfirmed,
        turnId,
        toolCallId,
        approved: true,
        confirmed: ToolCallConfirmationReason.UserAction,
        selectedOptionId: "allow-once",
      }
    : {
        type: ActionType.ChatToolCallConfirmed,
        turnId,
        toolCallId,
        approved: false,
        reason: "denied",
        selectedOptionId: "reject-once",
      };

async function rig(
  o: {
    backend?: "scripted" | "fake-acp";
    dbPath?: string;
    timers?: Timers;
    chats?: boolean;
    fresh?: boolean;
  } = {},
) {
  const timers = o.timers ?? new Timers();
  const scripted = new ScriptedBackend();
  const sandbox = new FakeSandbox();
  const app = await createApp({
    dbPath: o.dbPath ?? ":memory:",
    knowledgeDir: mkdtempSync(join(tmpdir(), "i-inc-push-")),
    configDir: join(mkdtempSync(join(tmpdir(), "i-inc-push-cfg-")), "config"),
    clock: { now: () => timers.now },
    agent: new FakeAgent(),
    harness: new FakeHarness(),
    helper: new FakeHelper(),
    chat: new FakeChat(),
    machines: new FakeMachines(),
    push: (registry) => new FakePushService(registry),
    ahpPush: { schedule: timers.schedule },
    ahpBackend:
      o.backend === "fake-acp"
        ? (registry) =>
            new SessionHost({
              launch: sandbox.launch,
              agents: () => agentsFromRegistry(registry),
              engine: (id) => registry.engines().find((e) => e.id === id),
              teamOf: (employeeId) => registry.teamOf(employeeId).id,
              workingCopy: async () => {},
              credentials: () => ({}),
              effort: () => "medium",
              onUsage: () => {},
              onRateLimit: () => {},
              now: () => timers.now,
              cancelGraceMs: 80,
              startTimeoutMs: 3000,
            })
        : scripted,
  });
  if (app.deps.registry.employees().length === 0) {
    seedDemo(app.deps.registry);
    app.daemon.ensureKnowledge();
  }
  scripted.providers = () => app.deps.registry.engines().map((e) => e.id);
  scripted.multipleChats = o.chats === true;
  const fake = app.deps.push as FakePushService;
  // a restarted daemon finds the conversation it had
  const conv =
    o.fresh === false
      ? (app.ahp.conversations.list()[0] as NonNullable<ReturnType<typeof app.ahp.conversations.get>>)
      : await app.ahp.conversations.create({
          employeeId: "ada",
          ...(o.backend === "fake-acp" ? { mode: "default" } : {}),
        });
  const host = app.ahp.host;
  const client = async (id?: string, subscribe = true): Promise<TestClient> => {
    const c = new TestClient(host, id);
    await c.init(subscribe ? ["ahp-root://", conv.ahpSession, conv.ahpChat] : ["ahp-root://"]);
    return c;
  };
  const advance = async (ms: number) => {
    timers.advance(ms);
    await app.ahp.push.idle();
  };
  const look = (c: TestClient, over: Record<string, unknown> = {}) =>
    c.notify("iinc/presence", { visible: true, focused: true, channel: conv.ahpSession, ...over });
  const settings = (patch: Record<string, boolean>) =>
    app.handle(
      new Request("http://i.inc/api/push/settings", {
        method: "PUT",
        body: JSON.stringify(patch),
        headers: { "content-type": "application/json" },
      }),
    );
  return { app, timers, scripted, sandbox, fake, conv, host, client, advance, look, settings };
}

/** The scripted agent asks for permission to run a command (two, with `two`), and ends once they are answered. */
function asks(r: Awaited<ReturnType<typeof rig>>, ids: string[]) {
  r.scripted.script = async (run, b) => {
    await Promise.all(ids.map((id) => b.ask(run, id)));
    b.text(run, "done");
    return { kind: "complete" };
  };
}

describe("a request that appears", () => {
  it("is pushed after the grace, with who, what, and a link that carries only ids", async () => {
    const r = await rig();
    asks(r, ["tc1"]);
    const c = await r.client();
    c.dispatch(r.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(r) === 1);
    await r.advance(19_000);
    expect(r.fake.sent).toHaveLength(0);
    await r.advance(2_000);
    expect(r.fake.sent).toEqual([
      {
        title: "Ada needs you",
        body: "Run: rm …",
        url: `#/conversations/${r.conv.id}?card=tc1`,
        tag: tagOf(r.conv),
      },
    ]);
    // once, however long it waits
    await r.advance(3_600_000);
    expect(r.fake.sent).toHaveLength(1);
  });

  it("is not pushed when it is answered within the grace (answering at the laptop never buzzes the phone)", async () => {
    const r = await rig();
    asks(r, ["tc1"]);
    const c = await r.client();
    c.dispatch(r.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(r) === 1);
    await r.advance(12_000);
    c.dispatch(r.conv.ahpChat, confirm("t1", "tc1", true));
    await until(() => waiting(r) === 0);
    await r.advance(60_000);
    expect(r.fake.sent).toHaveLength(0);
    expect(r.app.ahp.push.waiting).toBe(0);
    expect(r.timers.pending).toBe(0);
  });

  it("is not pushed while a client that is looking at the conversation reports it (page visible and focused)", async () => {
    const r = await rig();
    asks(r, ["tc1"]);
    const laptop = await r.client("laptop");
    r.look(laptop);
    laptop.dispatch(r.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(r) === 1);
    // the laptop keeps saying it is there (every 15 s)
    for (let i = 0; i < 4; i++) {
      await r.advance(15_000);
      r.look(laptop);
    }
    expect(r.fake.sent).toHaveLength(0);
    // the tab is hidden: the next look finds nobody, and the push goes out
    laptop.notify("iinc/presence", { visible: false, focused: true, channel: r.conv.ahpSession });
    await r.advance(11_000);
    expect(r.fake.sent).toHaveLength(1);
  });

  it("is pushed when the report goes stale (a phone in a pocket), and a pushed request is not pushed again", async () => {
    const r = await rig();
    asks(r, ["tc1"]);
    const phone = await r.client("phone");
    r.look(phone);
    phone.dispatch(r.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(r) === 1);
    await r.advance(30_000);
    expect(r.fake.sent).toHaveLength(0);
    // no more reports: after PRESENCE_STALE_MS since the last one it no longer counts
    await r.advance(PRESENCE_STALE_MS + 11_000);
    expect(r.fake.sent).toHaveLength(1);
    r.look(phone);
    await r.advance(3_600_000);
    expect(r.fake.sent).toHaveLength(1);
  });

  it("is pushed once even if the daemon pushed it already (the key outlives a restart)", async () => {
    const r = await rig();
    asks(r, ["tc1"]);
    const c = await r.client();
    c.dispatch(r.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(r) === 1);
    const id = r.host.sessionState(r.conv.ahpSession)?.inputNeeded?.[0]?.id;
    r.app.db.run("INSERT INTO push_sent (key, at) VALUES (?, ?)", `convpush:${id}:t1`, r.timers.now);
    await r.advance(25_000);
    expect(r.fake.sent).toHaveLength(0);
  });
});

describe("what a push says", () => {
  it("has one tag per conversation, so a newer request replaces the older notification", async () => {
    const r = await rig();
    asks(r, ["tc1", "tc2"]);
    const c = await r.client();
    c.dispatch(r.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(r) === 2);
    await r.advance(21_000);
    expect(r.fake.sent.map((n) => n.url)).toEqual([
      `#/conversations/${r.conv.id}?card=tc1`,
      `#/conversations/${r.conv.id}?card=tc2`,
    ]);
    expect(new Set(r.fake.sent.map((n) => n.tag))).toEqual(new Set([`conv-${r.conv.id}`]));
    // answering sends nothing (the app closes the notification itself)
    c.dispatch(r.conv.ahpChat, confirm("t1", "tc1", true));
    await until(() => waiting(r) === 1);
    c.dispatch(r.conv.ahpChat, confirm("t1", "tc2", false));
    await until(() => waiting(r) === 0);
    await r.advance(1000);
    expect(r.fake.sent).toHaveLength(2);
  });

  it("sends nothing when the request is answered on any device, or the turn is stopped (a push that shows nothing spends Chrome's silent-push allowance)", async () => {
    const r = await rig();
    asks(r, ["tc1"]);
    const phone = await r.client("phone");
    phone.dispatch(r.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(r) === 1);
    await r.advance(25_000);
    expect(r.fake.sent).toHaveLength(1);
    const laptop = await r.client("laptop");
    laptop.dispatch(r.conv.ahpChat, confirm("t1", "tc1", true));
    await until(() => waiting(r) === 0);
    await r.advance(60_000);
    expect(r.fake.sent).toHaveLength(1);
    // a stopped turn too
    asks(r, ["tc2"]);
    phone.dispatch(r.conv.ahpChat, turnStarted("again", "t2"));
    await until(() => waiting(r) === 1);
    await r.advance(25_000);
    expect(r.fake.sent).toHaveLength(2);
    phone.dispatch(r.conv.ahpChat, { type: ActionType.ChatTurnCancelled, turnId: "t2" });
    await until(() => !r.host.chatState(r.conv.ahpChat)?.activeTurn);
    await r.advance(60_000);
    expect(r.fake.sent).toHaveLength(2);
    expect(r.fake.sent.every((n) => "resolve" in n === false)).toBe(true);
  });

  it("says a command as 'Run: <command>', a question as 'Asks: <question>', and never what is inside the call", async () => {
    const r = await rig();
    r.scripted.script = async (run) => {
      run.emit({
        type: ActionType.ChatToolCallStart,
        turnId: run.turnId,
        toolCallId: "tc1",
        toolName: "execute",
        displayName: "x",
      });
      run.emit({
        type: ActionType.ChatToolCallReady,
        turnId: run.turnId,
        toolCallId: "tc1",
        invocationMessage: "unused",
        toolInput: JSON.stringify({ command: "cat .env", contents: "TOP-SECRET-FILE-CONTENTS" }),
        confirmationTitle: `curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwx0123456789' https://example.com/${"a/".repeat(100)}`,
        options: [
          { id: "allow-once", label: "Allow once", kind: ConfirmationOptionKind.Approve, group: 0 },
          { id: "reject-once", label: "Deny", kind: ConfirmationOptionKind.Deny, group: 0 },
        ],
        edits: { items: [{ resource: "file:///a.ts", diff: "SECRET DIFF BODY" }] },
      } as never);
      return await new Promise<never>(() => {});
    };
    const c = await r.client();
    c.dispatch(r.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(r) === 1);
    await r.advance(21_000);
    const body = r.fake.sent[0]?.body ?? "";
    expect(body).toBe("Run: curl …");
    expect(body.length).toBeLessThanOrEqual(BODY_MAX);
    expect(body).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(JSON.stringify(r.fake.sent)).not.toMatch(/TOP-SECRET|SECRET DIFF|cat \.env/);
  });
});

describe("describeRequest, commandLabel and oneLine", () => {
  const tool = (call: Record<string, unknown>) => ({
    kind: "toolConfirmation",
    id: "x",
    chat: "c",
    toolCall: call,
  });
  const label = (call: Record<string, unknown>) => describeRequest(tool(call));

  it("shows a command as its program and at most two well-known subcommands, never its arguments", () => {
    expect(label({ toolName: "execute", confirmationTitle: "pnpm test" })).toBe("Run: pnpm test");
    expect(label({ toolName: "execute", confirmationTitle: "Run `pnpm test`" })).toBe("Run: pnpm test");
    expect(label({ toolName: "execute", confirmationTitle: "git commit -m 'fix it'" })).toBe(
      "Run: git commit …",
    );
    expect(label({ toolName: "execute", confirmationTitle: "pnpm test --filter web" })).toBe(
      "Run: pnpm test …",
    );
    // a secret in an argument never reaches the lock screen
    expect(label({ toolName: "execute", confirmationTitle: "mysql -pTr0ub4dor3xyz -u root" })).toBe(
      "Run: mysql …",
    );
    expect(label({ toolName: "execute", confirmationTitle: "mysql Tr0ub4dor3xyz" })).toBe("Run: mysql …");
    expect(label({ toolName: "execute", confirmationTitle: "mysql hunter2" })).toBe("Run: mysql …");
    expect(label({ toolName: "execute", confirmationTitle: "API_KEY=abc123 deploy.sh prod" })).toBe(
      "Run: deploy.sh …",
    );
    expect(label({ toolName: "execute", confirmationTitle: "/usr/local/bin/node script.js" })).toBe(
      "Run: node …",
    );
    // and a command is shown as it is, not with its characters stripped
    expect(label({ toolName: "execute", confirmationTitle: "rm -rf /tmp/*" })).toBe("Run: rm …");
    expect(commandLabel("")).toBe("Run a command");
    expect(commandLabel("$(whoami)")).toBe("Run a command");
    expect(commandLabel("   ")).toBe("Run a command");
    expect(commandLabel("a".repeat(80))).toBe("Run a command");
  });

  it("shows a file as its path inside the project, unchanged, and a fetch as its host", () => {
    expect(label({ toolName: "edit", confirmationTitle: "Edit src/my_file.ts" })).toBe(
      "Edit: src/my_file.ts",
    );
    expect(label({ toolName: "edit", confirmationTitle: "Edit `src/my_file.ts`" })).toBe(
      "Edit: src/my_file.ts",
    );
    expect(
      label({ toolName: "edit", confirmationTitle: "Edit /home/employee/work/conv-0123abcd/src/app.ts" }),
    ).toBe("Edit: src/app.ts");
    expect(label({ toolName: "edit", confirmationTitle: { markdown: "Write **src/a.ts**" } })).toBe(
      "Write: src/a.ts",
    );
    expect(label({ toolName: "edit", confirmationTitle: "src/*.ts and more" })).toBe("Edit a file");
    expect(label({ toolName: "delete", confirmationTitle: "Delete old/file.txt" })).toBe(
      "Delete: old/file.txt",
    );
    expect(label({ toolName: "fetch", confirmationTitle: "Fetch https://github.com/a/b?token=abc" })).toBe(
      "Fetch: github.com",
    );
    expect(label({ toolName: "fetch", confirmationTitle: "Fetch the docs" })).toBe("Fetch a page");
    expect(label({ toolName: "search", confirmationTitle: "Search for password" })).toBe(
      "Search the project",
    );
    expect(label({ toolName: "other", confirmationTitle: "Do something odd" })).toBe("Wants to use a tool");
    expect(label({})).toBe("Wants to use a tool");
    expect(
      label({ toolName: "edit", confirmationTitle: `Edit ${"d/".repeat(100)}f.ts` }).length,
    ).toBeLessThanOrEqual(BODY_MAX);
  });

  it("shows a question as model text: markup out, redacted, cut short", () => {
    const ask = (request: Record<string, unknown>) =>
      describeRequest({ kind: "chatInput", id: "i", chat: "c", request });
    expect(ask({ id: "q1", message: "Which **branch** should I use?" })).toBe(
      "Asks: Which branch should I use?",
    );
    expect(ask({ id: "q1", questions: [{ id: "a", message: "Tabs or spaces?" }] })).toBe(
      "Asks: Tabs or spaces?",
    );
    expect(ask({ id: "q1" })).toBe("Has a question for you");
    const long = ask({
      id: "q1",
      message: `Use the key ghp_abcdefghijklmnopqrstuvwxyz0123456789? ${"blah ".repeat(60)}`,
    });
    expect(long).not.toContain("ghp_abcdefgh");
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith("…")).toBe(true);
  });

  it("oneLine is one line of at most 120 characters, without secrets", () => {
    const t = oneLine(`line one\nline two ${"x".repeat(300)}`);
    expect(t).not.toContain("\n");
    expect(t.length).toBe(BODY_MAX);
    expect(t.endsWith("…")).toBe(true);
    expect(oneLine("export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789")).not.toContain("ghp_abcdefgh");
  });
});

describe("a restart (every deploy)", () => {
  const dbFile = () => join(mkdtempSync(join(tmpdir(), "i-inc-push-db-")), "i.db");
  type R = Awaited<ReturnType<typeof rig>>;
  /** A second listener over the same host and database: what a new run of the daemon builds. */
  const again = (r: R, timers: Timers) =>
    new ConversationPush({
      host: r.host,
      conversations: r.app.ahp.conversations,
      registry: r.app.deps.registry,
      db: r.app.db,
      push: r.fake,
      now: () => timers.now,
      schedule: timers.schedule,
    });

  it("sends nothing at startup for a request the restart ended (the app closes the notification when opened)", async () => {
    const dbPath = dbFile();
    const timers = new Timers();
    const a = await rig({ dbPath, timers });
    asks(a, ["tc1"]);
    const c = await a.client();
    c.dispatch(a.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(a) === 1);
    await a.advance(25_000);
    expect(a.fake.sent).toHaveLength(1);
    a.app.ahp.push.close();
    const b = await rig({ dbPath, timers, fresh: false });
    await b.advance(3_600_000);
    expect(waiting(b)).toBe(0);
    expect(b.fake.sent).toEqual([]);
  });

  it("does not push a still-waiting request twice after a restart", async () => {
    const timers = new Timers();
    const a = await rig({ timers });
    asks(a, ["tc1"]);
    const c = await a.client();
    c.dispatch(a.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(a) === 1);
    await a.advance(25_000);
    expect(a.fake.sent).toHaveLength(1);
    a.app.ahp.push.close();
    const next = again(a, timers);
    expect(next.waiting).toBe(1);
    await a.advance(60_000);
    expect(a.fake.sent).toHaveLength(1);
    next.close();
  });

  it("pushes once a request that was still in its grace and is still waiting", async () => {
    const timers = new Timers();
    const a = await rig({ timers });
    asks(a, ["tc1"]);
    const c = await a.client();
    c.dispatch(a.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(a) === 1);
    await a.advance(5_000);
    expect(a.fake.sent).toHaveLength(0);
    a.app.ahp.push.close();
    const next = again(a, timers);
    expect(next.waiting).toBe(1);
    await a.advance(21_000);
    expect(a.fake.sent).toHaveLength(1);
    expect(a.fake.sent[0]).toMatchObject({
      title: "Ada needs you",
      url: `#/conversations/${a.conv.id}?card=tc1`,
    });
    await a.advance(3_600_000);
    expect(a.fake.sent).toHaveLength(1);
    next.close();
  });

  it("says nothing while the daemon stops (the turns it ends are not answers)", async () => {
    const r = await rig();
    asks(r, ["tc1"]);
    const c = await r.client();
    c.dispatch(r.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(r) === 1);
    await r.advance(25_000);
    expect(r.fake.sent).toHaveLength(1);
    r.app.ahp.push.close();
    r.host.close();
    await r.advance(1_000);
    expect(r.fake.sent).toHaveLength(1);
  });
});

describe("the owner's settings", () => {
  it("default to conversations on and long replies off, and can be changed", async () => {
    const r = await rig();
    const get = async () =>
      (await (await r.app.handle(new Request("http://i.inc/api/push/settings"))).json()) as Any;
    expect(await get()).toEqual({ settings: { conversationsNeedMe: true, longReplyFinished: false } });
    const put = await r.settings({ longReplyFinished: true });
    expect(put.status).toBe(200);
    expect(await get()).toEqual({ settings: { conversationsNeedMe: true, longReplyFinished: true } });
    expect((await r.settings({ conversationsNeedMe: "yes" } as never)).status).toBe(400);
    expect((await r.settings({ sneaky: true })).status).toBe(400);
    expect(await get()).toEqual({ settings: { conversationsNeedMe: true, longReplyFinished: true } });
  });

  it("'Conversations need me' off means no push for a request", async () => {
    const r = await rig();
    await r.settings({ conversationsNeedMe: false });
    asks(r, ["tc1"]);
    const c = await r.client();
    c.dispatch(r.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(r) === 1);
    await r.advance(60_000);
    expect(r.fake.sent).toHaveLength(0);
  });

  it("turning 'Conversations need me' off during the grace drops the request, and on again does not revive it", async () => {
    const r = await rig();
    asks(r, ["tc1"]);
    const c = await r.client();
    c.dispatch(r.conv.ahpChat, turnStarted("go", "t1"));
    await until(() => waiting(r) === 1);
    await r.advance(5_000);
    expect(r.app.ahp.push.waiting).toBe(1);
    await r.settings({ conversationsNeedMe: false });
    expect(r.app.ahp.push.waiting).toBe(0);
    expect(r.timers.pending).toBe(0);
    await r.settings({ conversationsNeedMe: true });
    await r.advance(60_000);
    expect(r.fake.sent).toHaveLength(0);
  });

  it("'A long reply finished' (off by default) pushes a turn that ran over a minute while nobody is looking", async () => {
    const r = await rig();
    /** A turn that the agent finishes when the test lets it; returns how many turns the chat has then. */
    const turn = async (id: string, ms: number, looking?: TestClient) => {
      const g = gate();
      r.scripted.script = async (run, b) => {
        await g.promise;
        b.text(run, "x");
        return { kind: "complete" };
      };
      const c = looking ?? (await r.client());
      const before = r.host.chatState(r.conv.ahpChat)?.turns.length ?? 0;
      c.dispatch(r.conv.ahpChat, turnStarted(id, id));
      await until(() => r.host.chatState(r.conv.ahpChat)?.activeTurn);
      for (let spent = 0; spent < ms; spent += 15_000) {
        await r.advance(Math.min(15_000, ms - spent));
        if (looking) r.look(looking);
      }
      g.resolve();
      await until(() => (r.host.chatState(r.conv.ahpChat)?.turns.length ?? 0) > before);
      await r.advance(1);
    };
    // off: nothing, however long
    await turn("off", 90_000);
    expect(r.fake.sent).toHaveLength(0);
    await r.settings({ longReplyFinished: true });
    // on, but short
    await turn("short", 20_000);
    expect(r.fake.sent).toHaveLength(0);
    // on, and long
    await turn("long", 75_000);
    expect(r.fake.sent).toHaveLength(1);
    expect(r.fake.sent[0]).toMatchObject({
      title: "Ada finished",
      url: `#/conversations/${r.conv.id}`,
      tag: `conv-${r.conv.id}`,
    });
    // on, long, but somebody is looking
    const watcher = await r.client("watcher");
    r.look(watcher);
    await turn("watched", 75_000, watcher);
    expect(r.fake.sent).toHaveLength(1);
  });
});

describe("the visibility signal", () => {
  it("counts only from a client that holds the conversation, and only while it is fresh", async () => {
    const r = await rig();
    const bystander = await r.client("bystander", false);
    r.look(bystander);
    expect(r.host.isWatched(r.conv.ahpSession)).toBe(false);
    const c = await r.client("c");
    r.look(c);
    expect(r.host.isWatched(r.conv.ahpSession)).toBe(true);
    // the chat's address works too, and so does nothing else
    r.look(c, { channel: r.conv.ahpChat });
    expect(r.host.isWatched(r.conv.ahpSession)).toBe(true);
    r.look(c, { channel: "ahp-root://" });
    expect(r.host.isWatched(r.conv.ahpSession)).toBe(false);
    r.look(c);
    r.timers.advance(PRESENCE_STALE_MS + 1);
    expect(r.host.isWatched(r.conv.ahpSession)).toBe(false);
  });

  it("needs both a visible page and a focused one, and an unsubscribed client's report does not count", async () => {
    const r = await rig();
    const c = await r.client("c");
    r.look(c, { focused: false });
    expect(r.host.isWatched(r.conv.ahpSession)).toBe(false);
    r.look(c, { visible: "yes" });
    expect(r.host.isWatched(r.conv.ahpSession)).toBe(false);
    r.look(c);
    expect(r.host.isWatched(r.conv.ahpSession)).toBe(true);
    c.notify("unsubscribe", { channel: r.conv.ahpSession });
    c.notify("unsubscribe", { channel: r.conv.ahpChat });
    expect(r.host.isWatched(r.conv.ahpSession)).toBe(false);
  });

  it("is bounded: a repeat within a second changes nothing, one session per connection, gone with the connection", async () => {
    const r = await rig();
    const c = await r.client("c");
    r.look(c);
    const first = c.conn.presence?.at;
    r.timers.now += 500;
    for (let i = 0; i < 50; i++) r.look(c);
    expect(c.conn.presence?.at).toBe(first);
    r.timers.now += 600;
    r.look(c);
    expect(c.conn.presence?.at).toBe(first === undefined ? undefined : first + 1100);
    expect(JSON.stringify(c.conn.presence)).not.toContain("extra");
    c.disconnect();
    expect(r.host.isWatched(r.conv.ahpSession)).toBe(false);
  });

  it("ignores a client that has not authenticated", async () => {
    const r = await rig();
    const stranger = new TestClient(r.host, "stranger", false);
    const res = await stranger.rpc("iinc/presence", {
      visible: true,
      focused: true,
      channel: r.conv.ahpSession,
    });
    expect(res.error).toBeDefined();
    expect(r.host.isWatched(r.conv.ahpSession)).toBe(false);
  });
});

describe("with the fake ACP agent", () => {
  it("a permission request in an 'always ask' conversation is pushed once, and nothing is sent when it is allowed", async () => {
    const r = await rig({ backend: "fake-acp" });
    const c = await r.client();
    c.dispatch(r.conv.ahpChat, turnStarted("please edit the constant", "t1"));
    await until(() => waiting(r) === 1, 8000);
    await r.advance(21_000);
    expect(r.fake.sent).toHaveLength(1);
    const n = r.fake.sent[0];
    expect(n?.title).toBe("Ada needs you");
    expect(n?.body).toBe("Edit: src/app.ts");
    expect(n?.body).not.toContain("answer = 4");
    expect(n?.url).toBe(`#/conversations/${r.conv.id}?card=tc-edit`);
    const turn = r.host.chatState(r.conv.ahpChat)?.activeTurn?.id ?? "";
    c.dispatch(r.conv.ahpChat, confirm(turn, "tc-edit", true));
    await until(() => waiting(r) === 0, 8000);
    await r.advance(1);
    await r.advance(60_000);
    expect(r.fake.sent).toHaveLength(1);
    await until(() => r.host.chatState(r.conv.ahpChat)?.turns.length === 1, 8000);
  });
});

describe("a turn ending in one chat", () => {
  it("does not end the request waiting in another chat of the same session", async () => {
    const r = await rig({ chats: true });
    r.host.refreshAgents();
    const conv = await r.app.ahp.conversations.create({ employeeId: "ada" });
    const first = conv.ahpChat;
    const second = "ahp-chat:/second";
    r.scripted.script = async (run, b) => {
      if (run.chat === first) {
        await b.ask(run, "tc1");
        return { kind: "complete" };
      }
      b.text(run, "quick");
      return { kind: "complete" };
    };
    const c = new TestClient(r.host, "c");
    await c.init(["ahp-root://", conv.ahpSession, first]);
    await c.call("createChat", { channel: conv.ahpSession, chat: second });
    await c.subscribe(second);
    c.dispatch(first, turnStarted("go", "t1"));
    await until(() => (r.host.sessionState(conv.ahpSession)?.inputNeeded?.length ?? 0) === 1);
    await r.advance(25_000);
    expect(r.fake.sent).toHaveLength(1);
    // the other chat finishes a turn: the card in the first chat is still waiting, and its notification stays
    c.dispatch(second, turnStarted("other", "t2"));
    await until(() => r.host.chatState(second)?.turns.length === 1);
    await r.advance(1_000);
    expect(r.app.ahp.push.waiting).toBe(1);
  });
});
