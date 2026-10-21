// Comparison probe: the third-party @ahpd/sdk host + @ahpd/agent-acp backend, wrapping the SAME fake ACP agent,
// driven by the SAME official client. Shows how much of the AHP host a ready-made package gives us and where it
// differs from our own ~600 lines. Run: `bun src/probe-ahpd.ts` (needs the optional @ahpd/* packages installed).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPPORTED_PROTOCOL_VERSIONS, chatReducer } from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";

const { createHost, listen } = (await import("@ahpd/sdk")) as any;
const { acpAgent } = (await import("@ahpd/agent-acp")) as any;

const cwd = mkdtempSync(join(tmpdir(), "ahpd-probe-"));
const host = createHost({
  path: cwd,
  agents: [
    acpAgent({
      provider: "fake", displayName: "Fake ACP", command: "bun", honoursTrust: true,
      args: [join(import.meta.dir, "fake-acp-agent.ts")],
    }),
  ],
  onEvent: (l: string) => console.log(`[ahpd] ${l}`),
});
const listener = await listen({ port: 0 }, (peer: any) => host.accept(peer));
console.log(`ahpd host on ws://${listener.host}:${listener.port} (${listener.runtime})`);

const t = await WebSocketTransport.connect(`ws://127.0.0.1:${listener.port}`);
const c = new AhpClient(t);
c.connect();
const init = await c.initialize({ clientId: "probe", protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], initialSubscriptions: ["ahp-root://"] });
console.log("initialize ->", init.protocolVersion, JSON.stringify(init.serverInfo));
console.log("root agents:", (init.snapshots[0]!.state as any).agents.map((a: any) => a.provider));
const S = `ahp-session:/${crypto.randomUUID()}`;
await c.request("createSession", { channel: S, provider: "fake", workingDirectories: [`file://${cwd}`] } as any);
const sess = await c.subscribe(S);
const sstate: any = sess.result.snapshot!.state;
console.log("session:", sstate.lifecycle, "chats:", sstate.chats.length, "config keys:", Object.keys(sstate.config?.schema?.properties ?? {}));
console.log("mode schema:", JSON.stringify(sstate.config?.schema?.properties?.mode ?? null).slice(0, 200));
const chat = sstate.defaultChat ?? sstate.chats[0]?.resource;
const cs = await c.subscribe(chat);
let state: any = cs.result.snapshot!.state;
const turnId = crypto.randomUUID();
c.dispatch(chat, { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message: { text: "make the answer 42", origin: { kind: "user" } } } as any);
const seen: string[] = [];
const deadline = Date.now() + 8000;
for await (const ev of cs.subscription) {
  if (ev.type !== "action") continue;
  const a: any = ev.params.action;
  seen.push(a.type);
  state = chatReducer(state, a);
  const pend = state.activeTurn?.responseParts.find((p: any) => p.toolCall?.status === "pending-confirmation")?.toolCall;
  if (pend && !seen.includes("CONFIRMED")) {
    seen.push("CONFIRMED");
    console.log("pending confirmation:", pend.displayName, "options:", JSON.stringify(pend.options?.map((o: any) => `${o.id}:${o.kind}`)));
    c.dispatch(chat, { type: "chat/toolCallConfirmed", turnId, toolCallId: pend.toolCallId, approved: true, confirmed: "user-action", selectedOptionId: pend.options?.find((o: any) => o.kind === "approve")?.id } as any);
  }
  if (state.turns.length || Date.now() > deadline) break;
}
console.log("action sequence:", seen.join(" "));
const turn = state.turns[0];
console.log("error part:", JSON.stringify(turn?.responseParts.find((p: any) => p.kind === "error")?.error));
console.log("turn:", turn?.state, "parts:", turn?.responseParts.map((p: any) => (p.kind === "toolCall" ? `toolCall:${p.toolCall.toolName}:${p.toolCall.status}` : p.kind)));
await c.shutdown();
await listener.close?.();
process.exit(0);
