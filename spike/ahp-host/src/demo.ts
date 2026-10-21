// End-to-end evidence for T55. Run: `bun src/demo.ts` (or `bun run demo`) from spike/ahp-host.
// Spawns the host as a real process (Bun.serve + bun:sqlite + a scripted fake ACP agent), drives it with the
// official TS client, and asserts each step. Exits non-zero on the first failure.
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, Mirror, ROOT, until, type Connected } from "./client.ts";

const dir = import.meta.dir;
const work = mkdtempSync(join(tmpdir(), "ahp-spike-"));
const DB = join(work, "ahp.db");
const PORT = 4100 + Math.floor(Math.random() * 800);
const TOKEN = "spike-token";
const URL = `ws://127.0.0.1:${PORT}/ahp`;
const hostLog: string[] = [];
let n = 0;
const step = (s: string) => console.log(`\n${++n}. ${s}`);
const ok = (s: string) => console.log(`   ok  ${s}`);
function assert(c: unknown, msg: string): asserts c {
  if (!c) {
    console.error(`\nFAIL: ${msg}`);
    cleanup();
    process.exit(1);
  }
}

let hostProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
async function startHost(env: Record<string, string> = {}) {
  hostProc = Bun.spawn(["bun", join(dir, "main.ts")], {
    env: { ...process.env, PORT: String(PORT), DB, TOKEN, SNAPSHOT_EVERY: "12", ...env },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const tee = async (s: ReadableStream<Uint8Array>) => {
    for await (const chunk of s as unknown as AsyncIterable<Uint8Array>) for (const l of new TextDecoder().decode(chunk).split("\n")) if (l) hostLog.push(l);
  };
  void tee(hostProc.stdout);
  void tee(hostProc.stderr);
  await until(() => hostLog.some((l) => l.includes("listening")), "host listening");
}
const killHost = async (signal: "SIGKILL" | "SIGTERM" = "SIGKILL") => {
  hostProc?.kill(signal);
  await hostProc?.exited;
  hostLog.length = 0;
};
function cleanup() {
  try {
    hostProc?.kill("SIGKILL");
  } catch {}
}
const logged = (re: RegExp) => hostLog.some((l) => re.test(l));
const send = (c: Connected, chat: string, text: string, turnId = crypto.randomUUID()) => {
  c.dispatch(chat, { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message: { text, origin: { kind: "user" } } } as any);
  return turnId;
};
const pendingTool = (m: Mirror, chat: string) =>
  m.chat(chat)?.activeTurn?.responseParts.find((p: any) => p.kind === "toolCall" && p.toolCall.status === "pending-confirmation")?.toolCall;

try {
  // ───────────────────────────────────────────────────────────────
  step("Start the host (Bun.serve WebSocket at /ahp, bun:sqlite log, ACP agent over stdio)");
  await startHost();
  // an unauthenticated upgrade is refused before AHP begins
  const bad = await fetch(`http://127.0.0.1:${PORT}/ahp`, { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "x3JJHMbDL1EzLkh9GBhXDw==", "sec-websocket-version": "13" } });
  assert(bad.status === 401, `unauthenticated upgrade should be 401, got ${bad.status}`);
  ok("upgrade without the token -> 401 (same bearer/cookie check as the REST API)");
  for (const [how, mk] of [
    ["Cookie: i_inc=<token> (what the browser web app sends)", () => new (WebSocket as any)(URL, { headers: { cookie: `i_inc=${TOKEN}` } })],
    ["?tkn=<token> (what VS Code's chat.remoteAgentHosts sends)", () => new WebSocket(`${URL}?tkn=${TOKEN}`)],
  ] as const) {
    const ws = mk() as WebSocket;
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res());
      ws.addEventListener("error", () => rej(new Error(`websocket refused for ${how}`)));
    });
    ws.close();
    ok(`upgrade accepted with ${how}`);
  }

  step("Client A: initialize (protocolVersions) -> create session -> subscribe -> snapshot");
  const A = await connect(URL, "client-A", { token: TOKEN });
  assert(A.init?.protocolVersion === "1.0.0", "negotiated 1.0.0");
  ok(`initialize -> protocolVersion ${A.init!.protocolVersion}, serverSeq ${A.init!.serverSeq}, serverInfo ${JSON.stringify(A.init!.serverInfo)}`);
  const S = "ahp-session:/" + crypto.randomUUID();
  await A.request("createSession", { channel: S, provider: "fake-acp", workingDirectories: ["file:///work/demo"] } as any);
  await A.subscribe(S);
  const sess = A.mirror.states.get(S);
  assert(sess.lifecycle === "ready", "session ready");
  const CHAT: string = sess.defaultChat;
  assert(CHAT?.startsWith("ahp-chat:/"), "default chat");
  ok(`session ready, defaultChat ${CHAT.slice(0, 22)}…, config.mode=${sess.config.values.mode} (modes: ${sess.config.schema.properties.mode.enumLabels.join(" | ")})`);
  await A.subscribe(CHAT);
  assert(A.mirror.chat(CHAT).turns.length === 0, "chat snapshot empty");
  ok(`chat snapshot: ${A.mirror.chat(CHAT).turns.length} turns, fromSeq ${A.mirror.lastSeq}`);

  step("Client B joins the same session and chat");
  const B = await connect(URL, "client-B", { token: TOKEN, subscribe: [S, CHAT] });
  ok(`B subscribed; B.lastSeq ${B.mirror.lastSeq} == A.lastSeq ${A.mirror.lastSeq}`);

  // ───────────────────────────────────────────────────────────────
  step("A sends a message -> ACP session/prompt; stream arrives on both clients; edit asks for permission");
  const t1 = send(A, CHAT, "make the answer 42");
  await until(() => pendingTool(A.mirror, CHAT), "pending confirmation");
  await until(() => pendingTool(B.mirror, CHAT), "pending confirmation on B");
  const tc = pendingTool(A.mirror, CHAT);
  ok(`A and B both see pending-confirmation for "${tc.displayName}" with options: ${tc.options.map((o: any) => `${o.id}(${o.kind},g${o.group})`).join(" ")}`);
  ok(`session roll-up: inputNeeded=${A.mirror.states.get(S).inputNeeded?.length}, session status bits=${A.mirror.states.get(S).chats[0].status} (24=InputNeeded)`);
  ok(`edit preview carried as ContentRef: ${JSON.stringify(tc.edits?.items?.[0]?.after?.content)}`);

  step("First confirmation wins: A approves, then B (already looking at the same card) tries to deny");
  A.dispatch(CHAT, { type: "chat/toolCallConfirmed", turnId: t1, toolCallId: tc.toolCallId, approved: true, confirmed: "user-action", selectedOptionId: "allow-once" } as any);
  await until(() => A.mirror.log.some((e) => (e.action as any).type === "chat/toolCallConfirmed" && !e.rejectionReason), "A's confirmation echoed");
  B.dispatch(CHAT, { type: "chat/toolCallConfirmed", turnId: t1, toolCallId: tc.toolCallId, approved: false, reason: "denied", selectedOptionId: "reject-once" } as any);
  await until(() => B.mirror.rejected.length > 0, "B's rejection");
  assert(!A.mirror.rejected.length, "A not rejected");
  ok(`B's deny echoed with rejectionReason: "${B.mirror.rejected[0]!.rejectionReason}"`);
  await until(() => A.mirror.chat(CHAT).turns.length === 1, "turn complete");
  await until(() => B.mirror.chat(CHAT).turns.length === 1, "turn complete on B");
  assert(logged(/permission answered: .*allow-once/), "ACP got allow-once");
  ok(`ACP side saw: ${hostLog.find((l) => l.includes("permission answered"))}`);
  const turn = A.mirror.chat(CHAT).turns[0];
  const kinds = turn.responseParts.map((p: any) => (p.kind === "toolCall" ? `toolCall:${p.toolCall.toolName}:${p.toolCall.status}` : p.kind));
  ok(`turn.state=${turn.state}; parts: ${kinds.join(", ")}`);
  assert(turn.state === "complete", "turn complete");
  assert(JSON.stringify(A.mirror.chat(CHAT)) === JSON.stringify(B.mirror.chat(CHAT)), "A and B mirrors identical");
  ok("A's and B's reduced chat state are identical");
  const edit = turn.responseParts.find((p: any) => p.toolCall?.toolName === "edit").toolCall;
  const fe = edit.content.find((c: any) => c.type === "fileEdit");
  const after = await A.request("resourceRead", { channel: ROOT, uri: fe.after.content.uri } as any);
  ok(`diff content fetched via resourceRead(${fe.after.content.uri.slice(0, 26)}…): ${JSON.stringify((after as any).data)}; stats ${JSON.stringify(fe.diff)}`);

  // ───────────────────────────────────────────────────────────────
  step("Disconnect B; more actions happen; reconnect B and replay from its last serverSeq");
  const bSeq = B.mirror.lastSeq;
  const bMirror = B.mirror;
  await B.close();
  ok(`B disconnected at serverSeq ${bSeq}`);
  await A.dispatch(S, { type: "session/configChanged", config: { mode: "acceptEdits" } } as any);
  await until(() => logged(/set_mode acceptEdits/), "ACP set_mode");
  ok(`A changed mode -> ACP session/set_mode acceptEdits (${hostLog.find((l) => l.includes("set_mode"))})`);
  const t2 = send(A, CHAT, "now again, quietly");
  await until(() => A.mirror.chat(CHAT).turns.length === 2, "second turn");
  assert(A.mirror.chat(CHAT).turns[1].state === "complete", "turn 2 complete without a prompt (acceptEdits)");
  ok(`turn 2 complete with no permission prompt; A.lastSeq ${A.mirror.lastSeq}`);
  const B2 = await connect(URL, "client-B", { token: TOKEN, mirror: bMirror, reconnect: [ROOT, S, CHAT] });
  assert(B2.reconnected?.type === "replay", "replay result");
  const replayed = (B2.reconnected as any).actions.length;
  assert(JSON.stringify(B2.mirror.chat(CHAT)) === JSON.stringify(A.mirror.chat(CHAT)), "B caught up exactly");
  ok(`reconnect(lastSeenServerSeq=${bSeq}) -> replay of ${replayed} actions (seq ${(B2.reconnected as any).actions[0].serverSeq}..${(B2.reconnected as any).actions.at(-1).serverSeq}); B state == A state, B.lastSeq ${B2.mirror.lastSeq}`);
  void t2;

  // ───────────────────────────────────────────────────────────────
  step("Cancel: slow turn -> chat/turnCancelled -> ACP session/cancel");
  const t3 = send(A, CHAT, "slow please");
  await until(() => (A.mirror.chat(CHAT).activeTurn?.responseParts[0]?.content ?? "").length > 20, "streaming text");
  A.dispatch(CHAT, { type: "chat/turnCancelled", turnId: t3, duration: 0 } as any);
  await until(() => A.mirror.chat(CHAT).turns.length === 3, "turn cancelled");
  await until(() => logged(/received session\/cancel/), "ACP saw cancel");
  const t = A.mirror.chat(CHAT).turns[2];
  assert(t.state === "cancelled", "cancelled state");
  ok(`turn state=${t.state}, kept ${t.responseParts[0].content.length} chars of partial text; ACP: ${hostLog.find((l) => l.includes("session/cancel"))}`);
  await until(() => B2.mirror.chat(CHAT).turns.length === 3, "B sees cancel");
  const stray = A.mirror.log.filter((e) => e.channel === CHAT && (e.action as any).turnId === t3).length;
  await new Promise((r) => setTimeout(r, 300));
  assert(A.mirror.log.filter((e) => e.channel === CHAT && (e.action as any).turnId === t3).length === stray, "no actions after cancel");
  ok("no stray actions for the cancelled turn after the cancel (late ACP chunks are dropped)");

  // ───────────────────────────────────────────────────────────────
  step("Persistence: SIGKILL the host, restart on the same SQLite file, rebuild state, resume the conversation");
  const before = JSON.stringify(A.mirror.chat(CHAT));
  const seqBefore = A.mirror.lastSeq;
  const db = new Database(DB, { readonly: true });
  const nAct = (db.query("SELECT COUNT(*) c FROM ahp_actions").get() as any).c;
  const nSnap = (db.query("SELECT COUNT(*) c FROM ahp_snapshots").get() as any).c;
  db.close();
  ok(`on disk: ${nAct} actions, ${nSnap} snapshots (snapshot every 12 actions per channel)`);
  await A.close();
  await B2.close();
  await killHost("SIGKILL");
  await startHost();
  ok(`host log: ${hostLog.find((l) => l.includes("rebuilt"))}`);
  const A2 = await connect(URL, "client-A", { token: TOKEN, subscribe: [S, CHAT] });
  assert(JSON.stringify(A2.mirror.chat(CHAT)) === before, "rebuilt chat state equals pre-crash state");
  ok(`rebuilt chat state is byte-identical to the pre-crash state (${before.length} bytes, ${A2.mirror.chat(CHAT).turns.length} turns); serverSeq resumes at ${A2.mirror.lastSeq} (was ${seqBefore} before the crash)`);
  const sessions: any = await A2.request("listSessions", { channel: ROOT } as any);
  ok(`listSessions after restart: ${sessions.items.map((s: any) => `"${s.title}"`).join(", ")}`);
  send(A2, CHAT, "hello again after restart");
  await until(() => A2.mirror.chat(CHAT).turns.length === 4 || pendingTool(A2.mirror, CHAT), "turn after restart");
  assert(logged(/session\/load/) && logged(/resumed .* with session\/load/), "ACP session/load on resume");
  ok(`conversation resumed: ${hostLog.find((l) => l.includes("resumed"))}`);
  assert(A2.mirror.log.every((e) => e.serverSeq > seqBefore), "new serverSeqs are all above the pre-crash maximum (no reuse)");
  ok(`new actions continue at serverSeq ${A2.mirror.log[0]!.serverSeq}.. (no reuse after the crash)`);
  const pt = pendingTool(A2.mirror, CHAT);
  if (pt) {
    A2.dispatch(CHAT, { type: "chat/toolCallConfirmed", turnId: A2.mirror.chat(CHAT).activeTurn.id, toolCallId: pt.toolCallId, approved: true, confirmed: "user-action" } as any);
  }
  await until(() => A2.mirror.chat(CHAT).turns.length === 4, "turn 4");

  step("Crash mid-turn: SIGKILL during a streaming turn -> restart marks it failed (not stuck 'running')");
  send(A2, CHAT, "slow and then crash");
  await until(() => (A2.mirror.chat(CHAT).activeTurn?.responseParts[0]?.content ?? "").length > 10, "streaming");
  const sBefore = A2.mirror.lastSeq;
  await A2.close();
  await killHost("SIGKILL");
  await startHost({ PRUNE: "1" });
  ok(`host log: ${hostLog.filter((l) => /recovered|pruned/.test(l)).join(" | ")}`);
  const A3 = await connect(URL, "client-A", { token: TOKEN, mirror: A2.mirror, reconnect: [ROOT, S, CHAT] });
  assert(A3.reconnected?.type === "snapshot", `stale reconnect after a pruned log should return snapshots, got ${A3.reconnected?.type}`);
  ok(`reconnect(lastSeenServerSeq=${sBefore}) after the log was pruned -> type "snapshot" (fresh snapshots, as the spec requires when the gap exceeds the buffer)`);
  const last = A3.mirror.chat(CHAT).turns.at(-1);
  assert(last.state === "error" && last.responseParts.at(-1).kind === "error", "interrupted turn is an error turn");
  ok(`interrupted turn -> state=${last.state}, final part: ${last.responseParts.at(-1).error.errorType} (partial text kept: ${last.responseParts[0].content.length} chars)`);
  await A3.close();

  console.log("\nALL STEPS PASSED");
} finally {
  cleanup();
}
process.exit(0);
