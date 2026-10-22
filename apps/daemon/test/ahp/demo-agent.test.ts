// Demo mode's conversation backend (src/demo-agent.ts): the scripted agent streams a reply with a tool call
// and a permission card, then finishes once the owner answers, so the Conversations screen has something to show
// without a sandbox, a network or any tokens.
import { describe, expect, it } from "vitest";
import { ActionType, ResponsePartKind, ToolCallStatus } from "../../src/ahp/wire.ts";
import { demoLaunch } from "../../src/demo-agent.ts";
import { pendingCall, sessionRig, tools, until } from "./session-rig.ts";
import { type Any, turnStarted } from "./support.ts";

const demoRig = () => sessionRig({ host: { launch: demoLaunch } });

describe("the demo agent", () => {
  it("offers its own modes, starts in Ask before edits, and streams a reply with a read, a plan and a permission card", async () => {
    const t = await demoRig();
    const c = await t.create("d1");
    const a = await t.client(c, "a");
    const session = t.host.sessionState(c.session) as Any;
    expect(session.config.schema.properties.mode.enumLabels).toEqual([
      "Ask before edits",
      "Accept edits",
      "Plan only",
    ]);
    expect(session.config.values.mode).toBe("default");
    a.dispatch(c.chat, turnStarted("Fix the money formatting", "t1"));
    const call = await (async () => {
      await until(() => pendingCall(t.host.chatState(c.chat)));
      return pendingCall(t.host.chatState(c.chat)) as Any;
    })();
    expect(call).toMatchObject({ toolCallId: "demo-edit", confirmationTitle: "Edit src/format.ts" });
    expect(call.options.map((o: Any) => o.label)).toEqual(["Allow once", "Always allow", "Deny"]);
    // the reply so far: it quotes the request, and has read a file first
    const active = t.host.chatState(c.chat)?.activeTurn as Any;
    const parts = active.responseParts as Any[];
    const text = parts
      .filter((p) => p.kind === ResponsePartKind.Markdown)
      .map((p) => p.content)
      .join("");
    expect(text).toContain("Fix the money formatting");
    expect(tools({ responseParts: parts })["demo-read"]).toMatchObject({ status: ToolCallStatus.Completed });
    // the session needs the owner until the card is answered
    expect(t.host.sessionState(c.session)?.inputNeeded?.length).toBe(1);
  });

  it("finishes the turn once the owner allows the edit, and leaves the file alone when denied", async () => {
    for (const approved of [true, false]) {
      const t = await demoRig();
      const c = await t.create("d2");
      const a = await t.client(c, "a");
      a.dispatch(c.chat, turnStarted("Fix it", "t1"));
      await until(() => pendingCall(t.host.chatState(c.chat)));
      a.dispatch(
        c.chat,
        approved
          ? {
              type: ActionType.ChatToolCallConfirmed,
              turnId: "t1",
              toolCallId: "demo-edit",
              approved: true,
              confirmed: "user-action",
              selectedOptionId: "allow-once",
            }
          : {
              type: ActionType.ChatToolCallConfirmed,
              turnId: "t1",
              toolCallId: "demo-edit",
              approved: false,
              reason: "denied",
              selectedOptionId: "reject-once",
            },
      );
      await until(() => t.host.chatState(c.chat)?.turns.length === 1, 6000, "the turn to end");
      const turn = t.host.chatState(c.chat)?.turns[0] as Any;
      expect(tools(turn)["demo-edit"].status).toBe(
        approved ? ToolCallStatus.Completed : ToolCallStatus.Cancelled,
      );
    }
  });

  it("does not ask in Accept edits mode", async () => {
    const t = await demoRig();
    const c = await t.create("d3", { mode: "acceptEdits" });
    const a = await t.client(c, "a");
    await t.say(a, c.chat, "Fix it");
    const turn = t.host.chatState(c.chat)?.turns[0] as Any;
    expect(tools(turn)["demo-edit"].status).toBe(ToolCallStatus.Completed);
  });
});
