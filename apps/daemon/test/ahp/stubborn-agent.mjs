// A stand-in ACP agent that is a real process, for the tests of agents that outlive the daemon.
// It answers just enough ACP to hold a conversation, and does NOT treat the end of its stdin as the
// end of its work. With STUBBORN=term it also ignores SIGTERM, so only SIGKILL stops it.
import { createInterface } from "node:readline";

if (process.env.STUBBORN === "term") process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "s-1" } });
  else if (m.method === "session/prompt") {
    send({
      method: "session/update",
      params: {
        sessionId: "s-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
      },
    });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.id !== undefined) send({ id: m.id, result: {} });
});
process.stdin.on("end", () => {}); // the daemon is gone: carry on regardless
