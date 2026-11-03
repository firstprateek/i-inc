// Whose words a conversation's title is (r131 review): the owner's own (typed at create, a rename, or the first line
// of their first message) stays as typed in the owner's views, over REST and on the WebSocket; the agent's own title
// gets the sink's pass everywhere the owner sees it, the ship dialog and a ticket made without a title included.
import { afterEach, describe, expect, it } from "vitest";
import { redactText } from "../src/ahp/sanitize.ts";
import { ActionType } from "../src/ahp/wire.ts";
import { sinkMemos } from "../src/sinks.ts";
import { TestClient } from "./ahp/support.ts";
import { SHAPES, visible } from "./canaries.ts";
import { testApp } from "./setup.ts";
import { shipRig } from "./ship-rig.ts";

afterEach(() => {
  for (const m of Object.values(sinkMemos)) m.clear();
});

const SHAPE = SHAPES[0]?.text ?? ""; // a URL password with a slash: only redactLast takes it
type Rig = Awaited<ReturnType<typeof shipRig>>;

/** The title as REST and a WebSocket client that has just subscribed show it. */
async function shown(rig: Rig, conv: { id: string; ahpSession: string }) {
  const one = await rig.call("GET", `/api/conversations/${conv.id}`);
  const list = await rig.call("GET", "/api/conversations");
  const c = new TestClient(rig.app.ahp.host);
  const init = await c.init(["ahp-root://", conv.ahpSession]);
  const list2 = await c.call("listSessions", { channel: "ahp-root://" });
  const session = init.snapshots.find((s: { resource: string }) => s.resource === conv.ahpSession);
  return {
    one: one.body.conversation.title as string,
    list: list.body.conversations.find((x: { id: string }) => x.id === conv.id)?.title as string,
    ws: session.state.title as string,
    summary: JSON.stringify(list2.items),
  };
}

describe("a conversation's title, by whose words it is", () => {
  it("the owner's own shows as typed: at create, from the first message, and after a rename", async () => {
    const rig = await shipRig({ mode: "owner-merges" });
    // typed at create
    const typed = "Why does --token x fail? https://example.com/?code=abc123";
    const made = await rig.call("POST", "/api/conversations", { employeeId: "ada", title: typed });
    expect(made.body.conversation.title).toBe(typed);
    let s = await shown(rig, made.body.conversation);
    expect([s.one, s.list, s.ws]).toEqual([typed, typed, typed]);
    expect(s.summary).toContain(JSON.stringify(typed));

    // the first line of the owner's first message
    const first = `Clone ${SHAPE}`;
    const c = await rig.conversation("Duet", `${first}\nand fix it`);
    s = await shown(rig, c.conv);
    expect([s.one, s.list, s.ws]).toEqual([first, first, first]);
    expect(s.summary).toContain(first);

    // an agent's title, then the owner's rename: the live frame of the rename shows it as typed too
    rig.app.ahp.host.emit(c.conv.ahpSession, {
      type: ActionType.SessionTitleChanged,
      title: `About ${SHAPE}`,
    });
    s = await shown(rig, c.conv);
    expect(visible(JSON.stringify(s), SHAPES)).toEqual([]);
    const watching = new TestClient(rig.app.ahp.host);
    await watching.init(["ahp-root://", c.conv.ahpSession]);
    const renamed = `Renamed ${SHAPE}`;
    const patched = await rig.call("PATCH", `/api/conversations/${c.conv.id}`, { title: renamed });
    expect(patched.body.conversation.title).toBe(renamed);
    const live = watching.socket.frames.filter(
      (f) =>
        (f as { params?: { action?: { type?: string } } }).params?.action?.type ===
        ActionType.SessionTitleChanged,
    );
    expect(JSON.stringify(live)).toContain(renamed);
    s = await shown(rig, c.conv);
    expect([s.one, s.list, s.ws]).toEqual([renamed, renamed, renamed]);

    // the ticket made from it says where it came from in the owner's words (the commit message holds the title, so
    // one ship's scan lets through: a keyed word redactProse would take)
    const asked = "Why does --token x fail?";
    await rig.call("PATCH", `/api/conversations/${c.conv.id}`, { title: asked });
    c.write("hello.txt", "hello\n");
    const t = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, { title: "Greeting" });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const view = await rig.call("GET", `/api/tickets/${t.body.ticket.id}`);
    expect(view.body.ticket.fromConversation.title).toBe(asked);
  });

  it("the agent's own is hidden in the row, on the WebSocket, in the ship dialog and in a ticket made from it", async () => {
    const rig = await shipRig({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("hello.txt", "hello\n");
    c.git("add", "-A");
    c.git("-c", "user.name=Ada", "-c", "user.email=ada@i.inc", "commit", "-q", "-m", "feat: greeting");
    const watching = new TestClient(rig.app.ahp.host);
    await watching.init(["ahp-root://", c.conv.ahpSession]);
    rig.app.ahp.host.emit(c.conv.ahpSession, {
      type: ActionType.SessionTitleChanged,
      title: `About ${SHAPE}`,
    });
    await rig.app.ahp.host.idle();
    expect(rig.app.ahp.host.sessionState(c.conv.ahpSession)?.title).toBe(`About ${SHAPE}`); // stored as main stores it
    expect(visible(JSON.stringify(watching.socket.frames), SHAPES)).toEqual([]);
    const s = await shown(rig, c.conv);
    expect(s.one).toContain("[redacted]");
    expect(visible(JSON.stringify(s), SHAPES)).toEqual([]);

    const ship = await rig.call("GET", `/api/conversations/${c.conv.id}/ship?preview=1`);
    expect(ship.body.ship.suggestion.title).toContain("About");
    expect(visible(JSON.stringify(ship.body), SHAPES)).toEqual([]);

    const t = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(t.status).toBe(201);
    const view = await rig.call("GET", `/api/tickets/${t.body.ticket.id}`);
    const board = await rig.call("GET", "/api/board");
    expect(view.body.ticket.title).toContain("About");
    // stored as main stores it: the sink hides it where it is shown
    expect(visible(rig.app.deps.tickets.get(t.body.ticket.id)?.ticket.title ?? "", SHAPES)).not.toEqual([]);
    for (const body of [t.body, view.body, board.body])
      expect(visible(JSON.stringify(body), SHAPES)).toEqual([]);
  });
});

describe("a conversation's ticket from before, titled by the agent", () => {
  it("is hidden in the ticket, the board and the lists, while the conversation keeps that title", async () => {
    const app = await testApp();
    const d = app.deps;
    const agentTitle = redactText(`About ${SHAPE}`); // the agent's SessionTitleChanged, as sanitizeAction kept it
    // a row from before whose title it is was kept (title_by is null)
    d.db.run(
      `INSERT INTO conversations (id, employee_id, project, branch, title, mode, engine_id, created_at, archived_at, ahp_session, ahp_chat)
       VALUES ('c1', 'ada', 'Duet', 'conv/c1', ?, NULL, 'claude-opus', ?, NULL, 'ahp-session:/c1', 'ahp-chat:/c1')`,
      agentTitle,
      app.clock.now(),
    );
    // as main's ship.makeTicket filed it with no title given: the title taken from the conversation, no createdBy
    const tk = d.tickets.create(
      {
        title: redactText(agentTitle).slice(0, 120),
        project: "Duet",
        type: "fix",
        effort: "medium",
        doneWhen: ["The project's checks pass"],
        assignee: "ada",
        conversation: "c1",
        hold: true,
      },
      app.clock.now(),
    );
    const t = await app.call("GET", `/api/tickets/${tk.id}`);
    expect(t.body.ticket.title).toContain("About");
    for (const path of [`/api/tickets/${tk.id}`, "/api/board", "/api/projects/Duet", "/api/desk"]) {
      const r = await app.call("GET", path);
      expect(visible(JSON.stringify(r.body), SHAPES), path).toEqual([]);
    }
    // an owner-filed ticket from the same conversation, titled in the owner's words, stays as typed
    const own = d.tickets.create(
      {
        title: `Owner's ${SHAPE}`,
        project: "Duet",
        type: "fix",
        effort: "low",
        doneWhen: ["x"],
        conversation: "c1",
        hold: true,
      },
      app.clock.now(),
    );
    expect((await app.call("GET", `/api/tickets/${own.id}`)).body.ticket.title).toBe(`Owner's ${SHAPE}`);
  });
});
