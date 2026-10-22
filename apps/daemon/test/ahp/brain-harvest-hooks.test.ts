// When a conversation's brain copy is collected (T58): when it goes idle, when it ends, and after a turn where
// the owner said `/remember`. The host only calls out; collecting is brain-harvest.ts, tested on its own.
import { describe, expect, it } from "vitest";
import { ActionType } from "../../src/ahp/wire.ts";
import { sessionRig, until } from "./session-rig.ts";

type Call = { id: string; employee: string; project: string | null; why: string };

async function world(fail = false) {
  const calls: Call[] = [];
  const t = await sessionRig({
    host: {
      harvest: (c, why) => {
        calls.push({ id: c.id, employee: c.employeeId, project: c.project, why });
        return fail ? Promise.reject(new Error("the sandbox is gone")) : Promise.resolve();
      },
    },
  });
  return { t, calls };
}

describe("collecting a conversation's brain copy", () => {
  it("does so once the conversation has been idle long enough, not before, and not for a turn that just ended", async () => {
    const { t, calls } = await world();
    const c = await t.create("c1", { project: "Duet" });
    const a = await t.client(c);
    await t.say(a, c.chat, "plain one");
    expect(calls).toEqual([]);
    t.time.now += 14 * 60_000;
    t.sessions.sweep();
    expect(calls).toEqual([]);
    t.time.now += 2 * 60_000;
    t.sessions.sweep();
    expect(calls).toEqual([{ id: "c1", employee: "ada", project: "Duet", why: "idle" }]);
  });

  it("does so when the conversation ends", async () => {
    const { t, calls } = await world();
    const c = await t.create("c1");
    await t.host.disposeSession(c.session);
    await until(() => calls.length > 0);
    expect(calls).toEqual([{ id: "c1", employee: "ada", project: null, why: "end" }]);
  });

  it("does so when a conversation is archived and swept", async () => {
    const { t, calls } = await world();
    const c = await t.create("c1");
    const a = await t.client(c);
    await t.say(a, c.chat, "plain one");
    a.dispatch(c.session, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
    await until(() => t.host.sessionState(c.session)?.status !== undefined);
    t.sessions.sweep();
    await until(() => calls.length > 0);
    expect(calls[0]).toMatchObject({ id: "c1", why: "idle" });
  });

  it("turns `/remember` into a request to write the copy, and collects it as soon as the turn is over", async () => {
    const { t, calls } = await world();
    const c = await t.create("c1");
    const a = await t.client(c);
    await t.say(a, c.chat, "plain what we decided about the release train");
    expect(calls).toEqual([]);
    await t.say(a, c.chat, "/remember plain the signing key stays on the mini");
    const prompt =
      t.sandbox.last.prompts
        .at(-1)
        ?.blocks.map((b: { text?: string }) => b.text ?? "")
        .join("\n") ?? "";
    expect(prompt).toContain("The owner asked you to remember this conversation");
    expect(prompt).toContain("the signing key stays on the mini");
    expect(prompt).not.toContain("/remember");
    expect(calls).toEqual([{ id: "c1", employee: "ada", project: null, why: "remember" }]);
    // The chat keeps what the owner typed.
    const turns = t.host.chatState(c.chat)?.turns ?? [];
    expect(JSON.stringify(turns.at(-1))).toContain("/remember plain the signing key");
  });

  it("goes on when collecting fails", async () => {
    const { t, calls } = await world(true);
    const c = await t.create("c1");
    const a = await t.client(c);
    await t.say(a, c.chat, "/remember plain keep this");
    await until(() => calls.length > 0);
    await until(() => t.logs.some((l) => l.includes("couldn't collect the brain copy")));
    await t.say(a, c.chat, "plain still works");
  });
});
