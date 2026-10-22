// Demo mode's conversation backend (src/demo-agent.ts): the scripted agent streams a reply with a tool call
// and a permission card, then finishes once the owner answers, so the Conversations screen has something to show
// without a sandbox, a network or any tokens.
import { describe, expect, it } from "vitest";
import { ActionType, ResponsePartKind, ToolCallStatus } from "../../src/ahp/wire.ts";
import { demoLaunch } from "../../src/demo-agent.ts";
import { pendingCall, sessionRig, tools, until } from "./session-rig.ts";
import { type Any, turnStarted } from "./support.ts";

const demoRig = () => sessionRig({ host: { launch: demoLaunch } });

const answer = (approved: boolean, toolCallId: string) =>
  approved
    ? {
        type: ActionType.ChatToolCallConfirmed,
        turnId: "t1",
        toolCallId,
        approved: true,
        confirmed: "user-action",
        selectedOptionId: "allow-once",
      }
    : {
        type: ActionType.ChatToolCallConfirmed,
        turnId: "t1",
        toolCallId,
        approved: false,
        reason: "denied",
        selectedOptionId: "reject-once",
      };

describe("the demo agent", () => {
  it("offers its own modes and starts in bypass permissions, which is what the New conversation screen says", async () => {
    const t = await demoRig();
    const c = await t.create("d1");
    const session = t.host.sessionState(c.session) as Any;
    expect(session.config.schema.properties.mode.enumLabels).toEqual([
      "Ask before edits",
      "Accept edits",
      "Plan only",
      "Bypass permissions",
    ]);
    expect(session.config.values.mode).toBe("bypassPermissions");
  });

  it("streams a reply with a read and a plan, then asks before running the tests, even in bypass", async () => {
    const t = await demoRig();
    const c = await t.create("d1");
    const a = await t.client(c, "a");
    a.dispatch(c.chat, turnStarted("Fix the money formatting", "t1"));
    await until(() => pendingCall(t.host.chatState(c.chat)));
    const call = pendingCall(t.host.chatState(c.chat)) as Any;
    expect(call).toMatchObject({ toolCallId: "demo-run", confirmationTitle: "Run pnpm test" });
    expect(call.options.map((o: Any) => o.label)).toEqual(["Allow once", "Always allow", "Deny"]);
    const active = t.host.chatState(c.chat)?.activeTurn as Any;
    const parts = active.responseParts as Any[];
    const text = parts
      .filter((p) => p.kind === ResponsePartKind.Markdown)
      .map((p) => p.content)
      .join("");
    expect(text).toContain("Fix the money formatting");
    const calls = tools({ responseParts: parts });
    expect(calls["demo-read"]).toMatchObject({ status: ToolCallStatus.Completed });
    expect(calls["demo-edit"]).toMatchObject({ status: ToolCallStatus.Completed });
    expect(t.host.sessionState(c.session)?.inputNeeded?.length).toBe(1);
  });

  it("finishes the turn once the owner allows the command, and says so when it is denied", async () => {
    for (const approved of [true, false]) {
      const t = await demoRig();
      const c = await t.create("d2");
      const a = await t.client(c, "a");
      a.dispatch(c.chat, turnStarted("Fix it", "t1"));
      await until(() => pendingCall(t.host.chatState(c.chat)));
      a.dispatch(c.chat, answer(approved, "demo-run"));
      await until(() => t.host.chatState(c.chat)?.turns.length === 1, 6000, "the turn to end");
      const turn = t.host.chatState(c.chat)?.turns[0] as Any;
      expect(tools(turn)["demo-run"].status).toBe(
        approved ? ToolCallStatus.Completed : ToolCallStatus.Cancelled,
      );
    }
  });

  it("asks before the edit in Ask before edits mode, and leaves the file alone when denied", async () => {
    const t = await demoRig();
    const c = await t.create("d3", { mode: "default" });
    const a = await t.client(c, "a");
    a.dispatch(c.chat, turnStarted("Fix it", "t1"));
    await until(() => pendingCall(t.host.chatState(c.chat)));
    expect(pendingCall(t.host.chatState(c.chat))).toMatchObject({ toolCallId: "demo-edit" });
    a.dispatch(c.chat, answer(false, "demo-edit"));
    await until(() => t.host.chatState(c.chat)?.turns.length === 1, 6000, "the turn to end");
    const turn = t.host.chatState(c.chat)?.turns[0] as Any;
    expect(tools(turn)["demo-edit"].status).toBe(ToolCallStatus.Cancelled);
    expect(tools(turn)["demo-run"]).toBeUndefined();
  });
});
