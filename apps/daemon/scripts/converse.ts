// An owner-side smoke tool: talk to one employee through the running daemon, the way the web app does, and print
// what comes back. It runs ON THE HOST (the daemon's port is local, and so is the token):
//
//   bun apps/daemon/scripts/converse.ts --employee pip [--project <id>] [--allow] [--keep] [--timeout 300] "message"
//
// It reads the bearer token from ~/.config/i-inc/web-token (never printed), creates a conversation over REST
// (contract C22), opens `ws://127.0.0.1:7420/ahp` with the token as an Authorization header, sends the message
// as a turn, and streams the reply text, the tool calls and any permission requests to stdout. Permission
// requests are denied unless `--allow`. When the turn ends it prints a one-line summary and archives the
// conversation (unless `--keep`). Exit code: 0 when the turn completed, 1 when it was cancelled or failed, 2 on a
// timeout or any error reaching the daemon, 64 on a bad command line.
//
// The protocol client is the minimal one of apps/daemon/test/ahp/support.ts: JSON-RPC over the socket, with the
// official reducers (via src/ahp/wire.ts) keeping the chat's state, so the summary reads what the web would show.

import { join } from "node:path";
import type { StateAction } from "../src/ahp/wire.ts";
import {
  ActionType,
  type ChannelState,
  ConfirmationOptionKind,
  type Json,
  ROOT,
  reduce,
  USER_ORIGIN,
} from "../src/ahp/wire.ts";
import { configDir, readOwnerOnly } from "../src/config.ts";

// biome-ignore lint/suspicious/noExplicitAny: protocol JSON is read loosely, the way a client would.
type Any = any;

/** The part of a WebSocket this uses, so a test can stand in the host without a network. */
export interface SocketLike {
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: ((e: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ConverseOptions {
  /** The daemon, such as http://127.0.0.1:7420. */
  baseUrl: string;
  /** The daemon's bearer token. Never written to `out`. */
  token: string;
  employee: string;
  project?: string | undefined;
  message: string;
  /** Approve permission requests instead of denying them. */
  allow?: boolean;
  /** Leave the conversation unarchived. */
  keep?: boolean;
  /** How long to wait for the turn to end. */
  timeoutMs?: number;
  /** Where the transcript goes. Default: standard output. */
  out?: (text: string) => void;
  fetch?: typeof fetch;
  openSocket?: (url: string, headers: Record<string, string>) => SocketLike;
}

export interface ConverseResult {
  /** 0 completed, 1 cancelled or failed, 2 timeout or the daemon was unreachable. */
  code: 0 | 1 | 2;
  status: "complete" | "cancelled" | "error" | "timeout" | "unreachable";
  conversation: string | null;
  parts: number;
  inputTokens: number;
  outputTokens: number;
  /** Why it did not complete, in words. */
  detail?: string;
}

const defaultSocket = (url: string, headers: Record<string, string>): SocketLike =>
  new WebSocket(url, { headers } as never) as unknown as SocketLike;

/**
 * Why this daemon address may not be used, or null. The bearer token goes in every request, so it only goes over
 * https, or over http to this machine.
 */
export function urlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `${url} is not a web address`;
  }
  if (u.protocol === "https:") return null;
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol === "http:" && loopback) return null;
  return `the token would be sent in the clear to ${u.host}: use https, or http to 127.0.0.1`;
}

/** Runs one message through one employee and resolves when the turn ends. Never rejects. */
export async function converse(o: ConverseOptions): Promise<ConverseResult> {
  const sink = o.out ?? ((t: string) => void process.stdout.write(t));
  // What an agent says goes to the owner's terminal: control characters and bidi overrides are left out.
  const out = (t: string) =>
    sink(t.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, (c) => (c === "\n" || c === "\t" ? c : "")));
  const fetchFn = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${o.token}` };
  const result: ConverseResult = {
    code: 2,
    status: "unreachable",
    conversation: null,
    parts: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const bad = urlProblem(o.baseUrl);
  if (bad) {
    out(`${bad}\n`);
    return { ...result, code: 2, status: "unreachable", detail: bad };
  }
  let socket: SocketLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 1. The conversation, over REST.
    const made = await fetchFn(`${base}/api/conversations`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ employeeId: o.employee, ...(o.project ? { project: o.project } : {}) }),
    });
    const body = (await made.json().catch(() => ({}))) as Any;
    if (made.status !== 201 || !body.conversation) {
      result.detail = `the daemon refused to start a conversation (${made.status}): ${body.error ?? "no reason given"}`;
      out(`${result.detail}\n`);
      return {
        ...result,
        code: made.status === 401 ? 2 : 1,
        status: made.status === 401 ? "unreachable" : "error",
      };
    }
    const conv = body.conversation as { id: string; ahpSession: string; ahpChat: string };
    result.conversation = conv.id;

    // 2. The socket, and the handshake.
    const wsUrl = `${base.replace(/^http/, "ws")}/ahp`;
    const ws = (o.openSocket ?? defaultSocket)(wsUrl, auth);
    socket = ws;
    const states = new Map<string, ChannelState>();
    const pending = new Map<number, (r: Any) => void>();
    const turnId = crypto.randomUUID();
    const clientId = `converse-${turnId.slice(0, 8)}`;
    let nextId = 1;
    let clientSeq = 1;
    let ended: ((s: ConverseResult["status"], detail?: string) => void) | undefined;
    const endedP = new Promise<{ status: ConverseResult["status"]; detail?: string }>((resolve) => {
      ended = (status, detail) => resolve({ status, ...(detail ? { detail } : {}) });
    });
    const send = (m: Json) => ws.send(JSON.stringify({ jsonrpc: "2.0", ...m }));
    const rpc = (method: string, params: Json) =>
      new Promise<Any>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        send({ id, method, params });
      });
    const dispatch = (channel: string, action: Json) =>
      send({ method: "dispatchAction", params: { channel, clientSeq: clientSeq++, action } });
    const seenParts = new Set<string>();

    const onAction = (env: Any) => {
      if (env.rejectionReason) {
        out(`\n[refused] ${env.rejectionReason}\n`);
        ended?.("error", String(env.rejectionReason));
        return;
      }
      const prev = states.get(env.channel);
      if (prev) states.set(env.channel, reduce(prev, env.action as StateAction));
      if (env.channel !== conv.ahpChat) return;
      const a = env.action as Any;
      if (a.turnId !== undefined && a.turnId !== turnId) return;
      switch (a.type) {
        case ActionType.ChatResponsePart: {
          // The text arrives as parts and deltas; only the reply's own text is printed.
          if (a.part?.kind === "markdown") {
            seenParts.add(a.part.id);
            if (a.part.content) out(String(a.part.content));
          }
          break;
        }
        case ActionType.ChatDelta:
          if (seenParts.has(a.partId) && a.content) out(String(a.content));
          break;
        case ActionType.ChatToolCallStart:
          out(`\n[tool] ${a.displayName ?? a.toolName}\n`);
          break;
        case ActionType.ChatToolCallReady: {
          // A request with options and no recorded confirmation waits for an answer.
          const options = (a.options ?? []) as { id: string; kind: string; group?: number }[];
          if (options.length && !a.confirmed) {
            out(
              `[permission] ${a.confirmationTitle ?? a.invocationMessage ?? a.toolCallId} -> ${o.allow ? "allowed" : "denied"}\n`,
            );
            const pick = options
              .filter(
                (x) => x.kind === (o.allow ? ConfirmationOptionKind.Approve : ConfirmationOptionKind.Deny),
              )
              .sort((x, y) => (x.group ?? 0) - (y.group ?? 0))[0];
            dispatch(conv.ahpChat, {
              type: ActionType.ChatToolCallConfirmed,
              turnId,
              toolCallId: a.toolCallId,
              ...(o.allow
                ? { approved: true, confirmed: "user-action" }
                : { approved: false, reason: "denied" }),
              ...(pick ? { selectedOptionId: pick.id } : {}),
            });
          }
          break;
        }
        case ActionType.ChatUsage:
          result.inputTokens += Number(a.usage?.inputTokens ?? 0);
          result.outputTokens += Number(a.usage?.outputTokens ?? 0);
          break;
        case ActionType.ChatTurnComplete:
          ended?.("complete");
          break;
        case ActionType.ChatTurnCancelled:
          ended?.("cancelled", "the turn was cancelled");
          break;
        case ActionType.ChatError:
          ended?.("error", String(a.error?.message ?? a.message ?? "the agent failed"));
          break;
      }
    };

    ws.onmessage = (e) => {
      let f: Any;
      try {
        f = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (f.id !== undefined && pending.has(f.id)) {
        pending.get(f.id)?.(f);
        pending.delete(f.id);
      } else if (f.method === "action") onAction(f.params);
    };
    ws.onclose = () => ended?.("unreachable", "the connection closed");
    ws.onerror = () => ended?.("unreachable", "the connection failed");
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      const fail = () =>
        reject(new Error("the daemon refused the connection (is the token right, and the daemon up?)"));
      ws.onerror = fail;
      ws.onclose = fail;
    });
    ws.onerror = () => ended?.("unreachable", "the connection failed");
    ws.onclose = () => ended?.("unreachable", "the connection closed");

    const init = await rpc("initialize", {
      channel: ROOT,
      protocolVersions: ["1.0.0"],
      clientId,
      initialSubscriptions: [ROOT, conv.ahpSession, conv.ahpChat],
    });
    if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
    for (const s of init.result?.snapshots ?? []) {
      const kind =
        s.resource === ROOT ? "root" : String(s.resource).startsWith("ahp-session:") ? "session" : "chat";
      states.set(s.resource, { kind, state: s.state } as ChannelState);
    }

    // 3. The turn, and the wait.
    timer = setTimeout(
      () => ended?.("timeout", `no end to the turn after ${Math.round((o.timeoutMs ?? 300_000) / 1000)} s`),
      o.timeoutMs ?? 300_000,
    );
    dispatch(conv.ahpChat, {
      type: ActionType.ChatTurnStarted,
      turnId,
      startedAt: new Date().toISOString(),
      message: { text: o.message, origin: USER_ORIGIN },
    });
    const end = await endedP;
    if (end.status === "timeout") {
      dispatch(conv.ahpChat, { type: ActionType.ChatTurnCancelled, turnId });
    }
    const chat = states.get(conv.ahpChat)?.state as Any;
    const turn = [...(chat?.turns ?? [])].reverse().find((t: Any) => t.id === turnId) ?? chat?.activeTurn;
    result.parts = (turn?.responseParts ?? []).length;
    result.status = end.status;
    result.code =
      end.status === "complete" ? 0 : end.status === "cancelled" || end.status === "error" ? 1 : 2;
    if (end.detail) result.detail = end.detail;
    out(
      `\n\nturn: ${end.status}${end.detail ? ` (${end.detail})` : ""} · parts: ${result.parts} · tokens: ${result.inputTokens} in, ${result.outputTokens} out · conversation ${conv.id}${o.keep ? " (kept)" : ""}\n`,
    );

    // 4. Put it away (in the `finally` below, so a failure on the way puts it away too).
    return result;
  } catch (e) {
    result.detail = e instanceof Error ? e.message : String(e);
    out(`${result.detail}\n`);
    return { ...result, code: 2, status: "unreachable" };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      socket?.close();
    } catch {}
    // Whatever happened after the conversation was made, it is put away unless the owner asked to keep it.
    if (result.conversation && !o.keep) {
      const arch = await fetchFn(`${base}/api/conversations/${result.conversation}`, {
        method: "PATCH",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      }).catch(() => undefined);
      if (!arch?.ok) out("(the conversation could not be archived; it stays in the list)\n");
    }
  }
}

// ---- The command line -------------------------------------------------------------------------------

const usage =
  'usage: bun apps/daemon/scripts/converse.ts --employee <id> [--project <id>] [--allow] [--keep] [--timeout <seconds>] [--url <daemon>] [--token-file <path>] "message"';

export interface Parsed {
  employee: string;
  project?: string;
  message: string;
  allow: boolean;
  keep: boolean;
  timeoutMs: number;
  url: string;
  tokenFile: string;
}

/** The command line, or the reason it is wrong. */
export function parseArgs(argv: string[]): Parsed | string {
  const p: Parsed = {
    employee: "",
    message: "",
    allow: false,
    keep: false,
    timeoutMs: 300_000,
    url: "http://127.0.0.1:7420",
    tokenFile: join(configDir(), "web-token"),
  };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = () => argv[++i] ?? "";
    if (a === "--employee") p.employee = value();
    else if (a === "--project") p.project = value();
    else if (a === "--allow") p.allow = true;
    else if (a === "--keep") p.keep = true;
    else if (a === "--timeout") p.timeoutMs = Number(value()) * 1000;
    else if (a === "--url") p.url = value();
    else if (a === "--token-file") p.tokenFile = value();
    else if (a.startsWith("--")) return `unknown option ${a}`;
    else words.push(a);
  }
  p.message = words.join(" ").trim();
  if (!p.employee) return "--employee is required";
  if (!p.message) return "a message is required";
  if (!Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0) return "--timeout is a number of seconds";
  const bad = urlProblem(p.url);
  if (bad) return bad;
  return p;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(`${args}\n${usage}`);
    process.exit(64);
  }
  let token: string;
  try {
    token = readOwnerOnly(args.tokenFile).trim();
  } catch (e) {
    console.error(`couldn't read the token file ${args.tokenFile}: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  const r = await converse({
    baseUrl: args.url,
    token,
    employee: args.employee,
    ...(args.project ? { project: args.project } : {}),
    message: args.message,
    allow: args.allow,
    keep: args.keep,
    timeoutMs: args.timeoutMs,
  });
  process.exit(r.code);
}
