// Conversations: the REST routes (behind the same login and guards as the rest of the API), the table,
// and that the row and the AHP session stay in step whichever side changes them.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsFromRegistry, conversationDir } from "../../src/ahp/conversations.ts";
import { ActionType, ROOT, SessionStatus } from "../../src/ahp/wire.ts";
import { createApi } from "../../src/api.ts";
import { createApp } from "../../src/app.ts";
import { seedDemo } from "../../src/demo.ts";
import { testApp } from "../setup.ts";
import { type Any, ScriptedBackend, TestClient, turnStarted } from "./support.ts";

/** The default test app: conversations wired, no agent behind them yet. */
async function conv() {
  return { app: await testApp() };
}

describe("REST /api/conversations", () => {
  it("creates a conversation for an employee on a project, with a session and a chat to subscribe to", async () => {
    const { app } = await conv();
    const made = await app.call("POST", "/api/conversations", { employeeId: "ada", project: "Duet" });
    expect(made.status).toBe(201);
    const c = made.body.conversation;
    expect(c).toMatchObject({
      employeeId: "ada",
      project: "Duet",
      title: "New conversation",
      mode: null,
      engineId: "opus",
      archivedAt: null,
      needsYou: false,
      running: false,
    });
    expect(c.id).toMatch(/^[0-9a-f]{8}$/);
    expect(c.branch).toBe(`conv/${c.id}`);
    expect(c.ahpSession).toMatch(/^ahp-session:\//);
    expect(c.ahpChat).toMatch(/^ahp-chat:\//);
    expect(c.status & SessionStatus.Idle).toBeTruthy();
    // the session exists in the host, in the conversation's working copy, with the i.inc metadata
    const session = app.ahp.host.sessionState(c.ahpSession);
    expect(session).toMatchObject({
      provider: "opus",
      title: "New conversation",
      workingDirectories: [`file://${conversationDir(c.id)}`],
      _meta: {
        "iinc.conversation": c.id,
        "iinc.employee": "ada",
        "iinc.project": "Duet",
        "iinc.branch": c.branch,
      },
    });
    expect(session?.defaultChat).toBe(c.ahpChat);
    expect(app.ahp.host.sessionOfChat(c.ahpChat)).toBe(c.ahpSession);
    // and it is in the table
    expect(app.db.all("SELECT id, ahp_session, ahp_chat FROM conversations")).toEqual([
      { id: c.id, ahp_session: c.ahpSession, ahp_chat: c.ahpChat },
    ]);
  });

  it("creates one with no project (no branch), a title, and a chosen engine", async () => {
    const { app } = await conv();
    const made = await app.call("POST", "/api/conversations", {
      employeeId: "kit",
      title: "  Lunch ideas ",
      engineId: "gemini",
    });
    expect(made.status).toBe(201);
    expect(made.body.conversation).toMatchObject({
      project: null,
      branch: null,
      title: "Lunch ideas",
      engineId: "gemini",
    });
    // no project: an empty scratch folder at the same place
    expect(app.ahp.host.sessionState(made.body.conversation.ahpSession)?.workingDirectories).toEqual([
      `file://${conversationDir(made.body.conversation.id)}`,
    ]);
  });

  it("lists newest activity first, hides archived by default, and filters by employee", async () => {
    const { app } = await conv();
    const one = (await app.call("POST", "/api/conversations", { employeeId: "ada", title: "one" })).body
      .conversation;
    app.clock.advance(1);
    const two = (await app.call("POST", "/api/conversations", { employeeId: "kit", title: "two" })).body
      .conversation;
    const list = async (q = "") =>
      (await app.call("GET", `/api/conversations${q}`)).body.conversations.map((c: Any) => c.title);
    expect(new Set(await list())).toEqual(new Set(["one", "two"]));
    expect(await list("?employee=kit")).toEqual(["two"]);
    await app.call("PATCH", `/api/conversations/${one.id}`, { archived: true });
    expect(await list()).toEqual(["two"]);
    expect(await list("?archived=true")).toEqual(["one"]);
    expect(new Set(await list("?archived=all"))).toEqual(new Set(["one", "two"]));
    const got = await app.call("GET", `/api/conversations/${two.id}`);
    expect(got.body.conversation.title).toBe("two");
    expect((await app.call("GET", "/api/conversations/nope")).status).toBe(404);
  });

  it("renames and archives, in the row and in the session, and un-archives", async () => {
    const { app } = await conv();
    const c = (await app.call("POST", "/api/conversations", { employeeId: "ada" })).body.conversation;
    const r = await app.call("PATCH", `/api/conversations/${c.id}`, { title: "Refund bug" });
    expect(r.status).toBe(200);
    expect(r.body.conversation.title).toBe("Refund bug");
    expect(app.ahp.host.sessionState(c.ahpSession)?.title).toBe("Refund bug");

    const a = await app.call("PATCH", `/api/conversations/${c.id}`, { archived: true });
    expect(a.body.conversation.archivedAt).toEqual(expect.any(Number));
    const flags = (s: number) => (s & SessionStatus.IsArchived) !== 0;
    expect(flags(app.ahp.host.sessionState(c.ahpSession)?.status ?? 0)).toBe(true);
    expect(flags(app.ahp.host.chatState(c.ahpChat)?.status ?? 0)).toBe(true);

    const u = await app.call("PATCH", `/api/conversations/${c.id}`, { archived: false });
    expect(u.body.conversation.archivedAt).toBeNull();
    expect(flags(app.ahp.host.sessionState(c.ahpSession)?.status ?? 0)).toBe(false);
    // archiving twice does nothing, and the title is untouched
    await app.call("PATCH", `/api/conversations/${c.id}`, { archived: true });
    const seq = app.ahp.host.serverSeq;
    await app.call("PATCH", `/api/conversations/${c.id}`, { archived: true, title: "Refund bug" });
    expect(app.ahp.host.serverSeq).toBe(seq);
  });

  it("refuses what makes no sense, with a reason", async () => {
    const { app } = await conv();
    const post = (b: unknown) => app.call("POST", "/api/conversations", b);
    expect((await post({})).body.error).toMatch(/employeeId is required/);
    expect((await post({ employeeId: "nobody" })).body.error).toMatch(/no employee/);
    expect((await post({ employeeId: "ada", project: "Nope" })).body.error).toMatch(/no project/);
    expect((await post({ employeeId: "ada", title: " " })).status).toBe(400);
    expect((await post({ employeeId: "ada", title: "x".repeat(201) })).status).toBe(400);
    expect((await post({ employeeId: "ada", engineId: "ghost" })).body.error).toMatch(/no engine/);
    expect((await post({ employeeId: "ada", mode: "plan" })).body.error).toMatch(/no config/); // no agent yet, no modes
    app.deps.registry.hire({
      ...app.deps.registry.employee("kit"),
      id: "narrow",
      name: "Narrow",
      projects: ["listy"],
    });
    expect((await post({ employeeId: "narrow", project: "Duet" })).status).toBe(409);
    expect((await post({ employeeId: "narrow", project: "listy" })).status).toBe(201);
    const raw = await app.handle(
      new Request("http://i.inc/api/conversations", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(raw.status).toBe(400);
    const c = (await post({ employeeId: "ada" })).body.conversation;
    const patch = (b: unknown) => app.call("PATCH", `/api/conversations/${c.id}`, b);
    expect((await patch({ title: "" })).status).toBe(400);
    expect((await patch({ title: 5 })).status).toBe(400);
    expect((await patch({ archived: "yes" })).status).toBe(400);
    expect((await app.call("PATCH", "/api/conversations/ghost", { title: "x" })).status).toBe(404);
    // nothing was left behind by the refusals
    expect(app.ahp.host.sessions()).toHaveLength(2);
  });

  it("answers 400 to a field of the wrong type instead of leaving it out", async () => {
    const { app } = await conv();
    const post = (b: unknown) => app.call("POST", "/api/conversations", b);
    for (const [field, value] of [
      ["project", 5],
      ["project", true],
      ["project", {}],
      ["title", 5],
      ["title", null],
      ["mode", 1],
      ["mode", null],
      ["engineId", 7],
      ["employeeId", 1],
    ] as const) {
      const r = await post({ employeeId: "ada", [field]: value });
      expect(r.status, `${field}: ${JSON.stringify(value)}`).toBe(400);
    }
    expect((await post({ employeeId: "ada", project: null })).status).toBe(201); // null project is a project-less conversation
    expect(app.ahp.host.sessions()).toHaveLength(1); // none of the refused ones made a session
  });

  it("changes nothing when any field of a PATCH is bad", async () => {
    const { app } = await conv();
    const c = (await app.call("POST", "/api/conversations", { employeeId: "ada", title: "Before" })).body
      .conversation;
    const seq = app.ahp.host.serverSeq;
    for (const bad of [
      { title: "After", archived: "yes" },
      { title: "After", archived: 1 },
      { archived: true, title: "" },
      { archived: true, title: 5 },
      { title: "x".repeat(201), archived: true },
    ]) {
      const r = await app.call("PATCH", `/api/conversations/${c.id}`, bad);
      expect(r.status, JSON.stringify(bad).slice(0, 50)).toBe(400);
    }
    const now = (await app.call("GET", `/api/conversations/${c.id}`)).body.conversation;
    expect(now).toMatchObject({ title: "Before", archivedAt: null });
    expect(app.ahp.host.sessionState(c.ahpSession)?.title).toBe("Before");
    expect(app.ahp.host.serverSeq).toBe(seq);
  });

  it("answers 502 when the agent side cannot open", async () => {
    const backend = new ScriptedBackend();
    const app = await appWith(backend);
    backend.failOpen = new Error("the sandbox did not start");
    const r = await app.call("POST", "/api/conversations", { employeeId: "ada" });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/sandbox did not start/);
    expect(app.db.all("SELECT * FROM conversations")).toEqual([]);
  });
});

/** The test app, but with the scripted agent behind the host and a login token. */
async function appWith(backend: ScriptedBackend, opts: { token?: string; hosts?: string[] } = {}) {
  const base = await testApp();
  let registry: { engines(): { id: string }[] } | undefined;
  backend.providers = () => registry?.engines().map((e) => e.id) ?? [];
  const app = await createApp({
    dbPath: ":memory:",
    knowledgeDir: mkdtempSync(join(tmpdir(), "ahp-knowledge-")),
    clock: base.clock,
    agent: base.agent,
    harness: base.harness,
    helper: base.helper,
    chat: base.chat,
    machines: base.deps.machines,
    ahpBackend: backend,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.hosts ? { hosts: opts.hosts } : {}),
  });
  seedDemo(app.deps.registry);
  registry = app.deps.registry;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.handle(
      new Request(`http://${opts.hosts?.[0] ?? "i.inc"}${path}`, {
        method,
        headers: {
          host: opts.hosts?.[0] ?? "i.inc",
          ...(method === "GET" ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Any };
  };
  return { ...app, call, clock: base.clock };
}

describe("the login and the guards", () => {
  it("keeps every conversations route behind the token, and the Host and Origin guards", async () => {
    const app = await appWith(new ScriptedBackend(), { token: "s3cret", hosts: ["127.0.0.1:7420"] });
    const auth = { authorization: "Bearer s3cret" };
    for (const [m, p] of [
      ["GET", "/api/conversations"],
      ["POST", "/api/conversations"],
      ["GET", "/api/conversations/x"],
      ["PATCH", "/api/conversations/x"],
    ] as const) {
      expect((await app.call(m, p, {})).status, `${m} ${p}`).toBe(401);
    }
    expect(
      (await app.call("GET", "/api/conversations", undefined, { ...auth, host: "evil.example" })).status,
    ).toBe(421);
    expect(
      (
        await app.call(
          "POST",
          "/api/conversations",
          { employeeId: "ada" },
          { ...auth, origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    const ok = await app.call("POST", "/api/conversations", { employeeId: "ada" }, auth);
    expect(ok.status).toBe(201);
    expect(
      (await app.call("GET", "/api/conversations", undefined, { cookie: "i_inc=s3cret" })).body.conversations,
    ).toHaveLength(1);
    // writes must be JSON, like every write
    const form = await app.handle(
      new Request("http://127.0.0.1:7420/api/conversations", {
        method: "POST",
        body: "employeeId=ada",
        headers: { ...auth, host: "127.0.0.1:7420", "content-type": "text/plain" },
      }),
    );
    expect(form.status).toBe(415);
  });
});

describe("the row and the session stay in step", () => {
  async function live() {
    const backend = new ScriptedBackend();
    const app = await appWith(backend);
    const c = (
      await app.call("POST", "/api/conversations", { employeeId: "ada", project: "Duet", mode: "plan" })
    ).body.conversation;
    const client = new TestClient(app.ahp.host);
    await client.init([ROOT, c.ahpSession, c.ahpChat]);
    return { app, backend, c, client };
  }

  it("takes the agent's mode as the conversation's mode, and follows a change made over AHP", async () => {
    const { app, c, client, backend } = await live();
    expect(c.mode).toBe("plan");
    expect(backend.opened[0]?.config).toEqual({ mode: "plan" });
    client.dispatch(c.ahpSession, { type: ActionType.SessionConfigChanged, config: { mode: "ask" } });
    expect((await app.call("GET", `/api/conversations/${c.id}`)).body.conversation.mode).toBe("ask");
  });

  it("titles itself from the first message and the row follows", async () => {
    const { app, c, client } = await live();
    client.dispatch(c.ahpChat, turnStarted("Why do refunds double count in August?", "t1"));
    await app.ahp.host.idle();
    expect((await app.call("GET", `/api/conversations/${c.id}`)).body.conversation.title).toBe(
      "Why do refunds double count in August?",
    );
  });

  it("follows a rename and an archive made over AHP, and reports running and needs-you from the host", async () => {
    const { app, c, client, backend } = await live();
    client.dispatch(c.ahpSession, { type: ActionType.SessionTitleChanged, title: "Renamed on the phone" });
    client.dispatch(c.ahpSession, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
    let got = (await app.call("GET", `/api/conversations/${c.id}`)).body.conversation;
    expect(got.title).toBe("Renamed on the phone");
    expect(got.archivedAt).toEqual(expect.any(Number));
    client.dispatch(c.ahpSession, { type: ActionType.SessionIsArchivedChanged, isArchived: false });

    backend.script = async (run, be) => {
      await be.ask(run, "tc1");
      return { kind: "complete" };
    };
    client.dispatch(c.ahpChat, turnStarted("go", "t1"));
    await new Promise((r) => setTimeout(r, 0));
    got = (await app.call("GET", `/api/conversations/${c.id}`)).body.conversation;
    expect(got).toMatchObject({ running: true, needsYou: true });
    expect((await app.call("GET", "/api/conversations")).body.conversations[0].needsYou).toBe(true);
  });

  it("creates a conversation over AHP createSession with _meta.iinc, and refuses one without", async () => {
    const { app, client } = await live();
    const session = "ahp-session:/from-the-phone";
    const bad = await client.rpc("createSession", { channel: session, provider: "opus" });
    expect(bad.error).toMatchObject({ code: -32602 });
    expect(
      (await client.rpc("createSession", { channel: session, _meta: { iinc: { employeeId: "nobody" } } }))
        .error,
    ).toMatchObject({ code: -32602 });
    expect(
      (
        await client.rpc("createSession", {
          channel: session,
          _meta: { iinc: { employeeId: "ada", project: "Duet", title: "From the phone" } },
          config: { mode: "plan" },
        })
      ).result,
    ).toBeNull();
    const row = app.deps.conversations?.bySession(session);
    expect(row).toMatchObject({ employeeId: "ada", project: "Duet", ahpSession: session });
    expect(app.ahp.host.sessionState(session)?.title).toBe("From the phone");
    expect(
      (await client.rpc("createSession", { channel: session, _meta: { iinc: { employeeId: "ada" } } })).error,
    ).toMatchObject({ code: -32003 });
    // the host says so on the root channel
    client.absorb();
    expect(
      client.notes.some(
        (n) => n.method === "root/sessionAdded" && (n.params as Any).summary.resource === session,
      ),
    ).toBe(true);
  });

  it("disposes a session only once it is archived, and the row goes with it", async () => {
    const { app, c, client } = await live();
    expect((await client.rpc("disposeSession", { channel: c.ahpSession })).error).toMatchObject({
      code: -32011,
    });
    await app.call("PATCH", `/api/conversations/${c.id}`, { archived: true });
    expect((await client.rpc("disposeSession", { channel: c.ahpSession })).result).toBeNull();
    expect((await app.call("GET", `/api/conversations/${c.id}`)).status).toBe(404);
    expect(app.ahp.host.sessions()).toEqual([]);
  });

  it("offers one provider per engine on the root channel, and follows hiring a new engine", async () => {
    const app = await testApp();
    const client = new TestClient(app.ahp.host);
    const root = await client.init();
    expect(root.snapshots[0].state.agents.map((a: Any) => a.provider).sort()).toEqual(
      app.deps.registry
        .engines()
        .map((e) => e.id)
        .sort(),
    );
    expect(agentsFromRegistry(app.deps.registry)[0]).toMatchObject({ models: [], capabilities: {} });
    app.deps.registry.addEngine({
      id: "newbie",
      harness: "claude-code",
      model: "Claude Haiku",
      accountId: "claude-pro",
      local: false,
    });
    expect(
      (await app.call("POST", "/api/conversations", { employeeId: "ada", engineId: "newbie" })).status,
    ).toBe(201);
    expect(client.state<Any>(ROOT).agents.map((a: Any) => a.provider)).toContain("newbie");
  });

  it("answers a turn in a conversation with no agent connected with a clear error, not a hang", async () => {
    const app = await testApp();
    const c = (await app.call("POST", "/api/conversations", { employeeId: "ada" })).body.conversation;
    const client = new TestClient(app.ahp.host);
    await client.init([ROOT, c.ahpChat]);
    client.dispatch(c.ahpChat, turnStarted("hello", "t1"));
    await app.ahp.host.idle();
    const turn = app.ahp.host.chatState(c.ahpChat)?.turns[0];
    expect(turn?.state).toBe("error");
    expect(JSON.stringify(turn?.responseParts)).toContain("No agent is connected");
  });
});

describe("the REST API without conversations wired", () => {
  it("says so rather than failing", async () => {
    const app = await testApp();
    const handle = createApi(app.daemon, { ...app.deps, conversations: undefined } as never, {});
    const res = await handle(new Request("http://i.inc/api/conversations"));
    expect(res.status).toBe(404);
  });
});
