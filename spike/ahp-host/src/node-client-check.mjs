// Runtime-fit check: the official client + ws transport under plain Node (>=22), against the Bun host.
// Usage: PORT=4999 node src/node-client-check.mjs   (host started with no TOKEN: Node's global WebSocket cannot set headers)
import { SUPPORTED_PROTOCOL_VERSIONS, chatReducer } from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";

const url = `ws://127.0.0.1:${process.env.PORT ?? 4999}/ahp`;
const t = await WebSocketTransport.connect(url);
const c = new AhpClient(t);
c.connect();
const init = await c.initialize({ clientId: "node-client", protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], initialSubscriptions: ["ahp-root://"] });
console.log(`node ${process.versions.node}: initialize ok, protocol ${init.protocolVersion}, root agents: ${init.snapshots[0].state.agents.map((a) => a.provider)}`);
const S = `ahp-session:/${crypto.randomUUID()}`;
await c.request("createSession", { channel: S, provider: "fake-acp" });
const { result } = await c.subscribe(S);
const chat = result.snapshot.state.defaultChat;
const sub = await c.subscribe(chat);
let state = sub.result.snapshot.state;
const turnId = crypto.randomUUID();
c.dispatch(chat, { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message: { text: "slow", origin: { kind: "user" } } });
let n = 0;
for await (const ev of sub.subscription) {
  if (ev.type !== "action") continue;
  state = chatReducer(state, ev.params.action);
  if (++n === 5) c.dispatch(chat, { type: "chat/turnCancelled", turnId, duration: 0 });
  if (state.turns.length) break;
}
console.log(`node client: streamed ${n} actions, turn ended as "${state.turns[0].state}"`);
await c.shutdown();
process.exit(0);
