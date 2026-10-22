// Open the session (T69): every ticket stage's agent session as a read-only AHP chat, so it can be watched live
// or replayed in the same thread view as a conversation.
//
//   a ticket           ->  one read-only AHP session   ahp-session:/ticket:<ticket id>
//   a stage session    ->  one chat in it              ahp-chat:/stage:<ticket_sessions.id>
//
// The agent's ACP updates go through the SAME mapper (acp-mapper.ts) as a conversation's, into the host's
// store, so the snapshots, replay, pruning, caps and redaction are the host's. The stage's brief (cut) is the one
// user turn; what the agent does is its reply. Clients cannot act on these channels (host.ts refuses it): the
// stage keeps its own permission handling, and `ticket_session_items` stays the historical record the ticket page
// reads. Nothing here may fail a stage: every call is guarded, and a view that breaks just stops updating.
import type { Id, SessionOutcome, SessionTranscriptItem } from "@i-inc/core";
import type { Db } from "../db.ts";
import { capText, safeReason } from "../sessions.ts";
import { TurnMapper } from "./acp-mapper.ts";
import type { AhpHost } from "./host.ts";
import { redactText, redactTokens } from "./sanitize.ts";
import { ActionType, type ChatAction, type Json, ResponsePartKind, USER_ORIGIN } from "./wire.ts";

/** The AHP session for a ticket. */
export const ticketSessionUri = (ticketId: Id): string =>
  `ahp-session:/ticket:${encodeURIComponent(ticketId)}`;
/** The AHP chat for one stage session (a `ticket_sessions` row). */
export const stageChatUri = (sessionId: number): string => `ahp-chat:/stage:${sessionId}`;
/** Is this the URI of a ticket's session? */
export const isTicketSession = (uri: string): boolean => uri.startsWith("ahp-session:/ticket:");

/** The brief is shown cut to this many characters: it is the prompt, not the work. */
export const BRIEF_CHARS = 4000;
/**
 * A stage's chat takes at most this many text parts and tool calls. The last TAIL_PARTS of them are kept for the end
 * (a note of how many steps were left out, and the final answer), so a long stage still shows how it came out.
 */
export const MAX_STAGE_PARTS = 600;
export const TAIL_PARTS = 8;
/**
 * A tool's result or output, and a call's input, is kept to this many characters in the view: tighter than the host's
 * general 64 KB for a string, because a stage runs hundreds of tools and nobody reads their output here.
 */
export const MAX_TOOL_TEXT = 8 * 1024;
/** One side of a diff is kept to this many characters in the view. */
const MAX_DIFF_CHARS = 32_000;
/** An image or other binary a tool returned is not kept past this. */
const MAX_BINARY_BYTES = 512 * 1024;
/** A reply the agent never streamed (it gave only its final answer) is shown up to this long. */
const MAX_ANSWER_CHARS = 20_000;

export interface StageInfo {
  ticketId: Id;
  ticketTitle: string;
  stage: string;
  /** The `ticket_sessions` row. */
  sessionId: number;
  employeeId: Id;
  engineId: Id;
  /** The engine's model, shown in usage. */
  model: string;
  /** The stage's brief, as the runner built it (before the brain's pages are added). */
  brief: string;
  startedAt: number;
}

/** How a stage's session ended, as the feed hears it. */
export type StageEnd =
  | SessionOutcome
  /** The daemon is stopping: the stage carries on when it is back. */
  | { kind: "stopping" }
  /** The session threw. */
  | { kind: "crashed"; reason: string };

export interface TicketChannelsOptions {
  host: AhpHost;
  db: Db;
  now?: () => number;
  log?: (message: string) => void;
}

const oneLine = (s: string, max: number): string => {
  const t = redactText(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const TOOL_TEXT_KEYS = new Set(["text", "toolInput", "partialInput"]);

/**
 * A tool call's action with its texts cut to MAX_TOOL_TEXT. Only the fields a tool fills (`toolInput`, the `text` of
 * result content); everything structural is left alone. The host redacts and caps again.
 */
export function capToolTexts<T>(action: T): T {
  const walk = (v: unknown, key: string | undefined, inTool: boolean): unknown => {
    if (typeof v === "string")
      return inTool && key && TOOL_TEXT_KEYS.has(key) && v.length > MAX_TOOL_TEXT
        ? `${v.slice(0, MAX_TOOL_TEXT)}\n[…truncated: the stage view keeps the first ${MAX_TOOL_TEXT / 1024} KB]`
        : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key, inTool));
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k, inTool)]));
    return v;
  };
  const type = (action as { type?: string }).type;
  const tool = typeof type === "string" && type.startsWith("chat/toolCall");
  return tool ? (walk(action, undefined, true) as T) : action;
}

/** "#12 Fix the refunds · build". */
export function stageTitle(ticketId: Id, ticketTitle: string, stage: string): string {
  return `#${ticketId} ${oneLine(ticketTitle, 120)} · ${stage}`.slice(0, 200);
}

/** The brief as the view shows it: redacted and cut at a paragraph or line, with a note of what was left out. */
export function shownBrief(brief: string): string {
  const text = redactText(brief).trim();
  if (text.length <= BRIEF_CHARS) return text;
  const head = text.slice(0, BRIEF_CHARS);
  const at = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n"));
  const cut = at > BRIEF_CHARS / 2 ? head.slice(0, at) : head;
  return `${cut}\n\n[…the brief goes on for ${text.length - cut.length} more characters, not shown here]`;
}

export class TicketChannels {
  private readonly host: AhpHost;
  private readonly db: Db;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly feeds = new Set<StageFeed>();

  constructor(o: TicketChannelsOptions) {
    this.host = o.host;
    this.db = o.db;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  /** A stage session is about to run. Nothing is made until it says or does something. */
  begin(info: StageInfo): StageFeed {
    const feed = new StageFeed(this, this.host, info, this.now, this.log);
    this.feeds.add(feed);
    return feed;
  }

  /** @internal Called by a feed when it has ended. */
  done(feed: StageFeed): void {
    this.feeds.delete(feed);
  }

  /** Feeds in progress (tests, and the storage report): back to 0 when no stage runs. */
  footprint(): { feeds: number } {
    return { feeds: this.feeds.size };
  }

  /** Where a stage session's channels are, when it has any. */
  channelFor(ticketId: Id, sessionId: number): { session: string; chat: string } | undefined {
    const chat = stageChatUri(sessionId);
    const session = ticketSessionUri(ticketId);
    return this.host.hasChannel(chat) && this.host.sessionOfChat(chat) === session
      ? { session, chat }
      : undefined;
  }

  /**
   * Lets go of the channels of stage sessions that are gone from the transcript store, and of those that ended
   * before `endedBefore` (the transcript compaction setting: the transcript stays, only the live view goes). A ticket's
   * session with no chat left goes too. A stage that is running now is never touched.
   */
  async sweep(o: { endedBefore?: number } = {}): Promise<{ chats: number; sessions: number }> {
    const out = { chats: 0, sessions: 0 };
    const running = new Set([...this.feeds].map((f) => f.chat));
    for (const session of this.host.sessions().filter(isTicketSession)) {
      for (const chat of this.host.chatsOf(session)) {
        if (running.has(chat)) continue;
        const id = Number(/^ahp-chat:\/stage:(\d+)$/.exec(chat)?.[1]);
        if (!Number.isInteger(id)) continue;
        const [row] = this.db.all<{ started_at: number; ended_at: number | null }>(
          "SELECT started_at, ended_at FROM ticket_sessions WHERE id = ?",
          id,
        );
        const old =
          row !== undefined &&
          o.endedBefore !== undefined &&
          (row.ended_at ?? row.started_at) <= o.endedBefore;
        if (row !== undefined && !old) continue;
        if (this.host.dropReadOnlyChat(chat)) out.chats++;
      }
      if (this.host.chatsOf(session).length === 0 && !this.host.hasActiveTurn(session)) {
        await this.host.disposeSession(session);
        out.sessions++;
      }
    }
    if (out.chats) this.log(`ticket sessions: let go of ${out.chats} live views`);
    return out;
  }
}

/** One stage session's chat, filled as the agent works. */
export class StageFeed {
  /** The chat's URI, once the session has said or done something. */
  chat: string | undefined;
  private mapper: TurnMapper | undefined;
  private readonly turnId: string;
  private ended = false;
  /** The agent speaks ACP: its updates are the feed, and transcript items are not used. */
  private acp = false;
  private broken = false;
  private parts = 0;
  private capped = false;
  /** Steps (text parts and tool calls) the cap kept out of the view. */
  private hidden = 0;
  /** The newest text part the agent opened was one the cap kept out. */
  private lastTextHidden = false;
  private spoke = false;
  private readonly started = new Set<string>();
  private readonly texts = new Map<string, string>();
  private fallbackTools = 0;
  private contextUsage: { used: unknown; size: unknown } | undefined;
  private promptUsage: Json | undefined;

  constructor(
    private readonly owner: TicketChannels,
    private readonly host: AhpHost,
    private readonly info: StageInfo,
    private readonly now: () => number,
    private readonly log: (m: string) => void,
  ) {
    this.turnId = `stage-${info.sessionId}`;
  }

  /** Runs `fn`, and turns whatever it throws into a note in the log: the stage goes on. */
  private guard(what: string, fn: () => void): void {
    if (this.broken) return;
    try {
      fn();
    } catch (e) {
      this.broken = true;
      this.log(
        `ticket session ${this.info.sessionId}: ${what} failed, so its view stops here: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /** Makes the ticket's session and this stage's chat, and records the brief as the turn that starts it. */
  private open(): boolean {
    if (this.chat) return true;
    const { info, host } = this;
    const session = ticketSessionUri(info.ticketId);
    const chat = stageChatUri(info.sessionId);
    const title = stageTitle(info.ticketId, info.ticketTitle, info.stage);
    const meta: Json = {
      "iinc.ticket": info.ticketId,
      "iinc.stage": info.stage,
      "iinc.employee": info.employeeId,
      "iinc.engine": info.engineId,
    };
    host.openReadOnlySession({
      session,
      provider: info.engineId,
      title,
      meta: { "iinc.ticket": info.ticketId },
    });
    // An id used before (a restored database): what was in it is not this stage's.
    if (host.hasChannel(chat)) host.dropReadOnlyChat(chat);
    host.addReadOnlyChat({
      session,
      chat,
      title,
      meta: { ...meta, "iinc.stageSession": info.sessionId },
    });
    this.mapper = new TurnMapper({
      turnId: this.turnId,
      emit: (a) => this.emit(a),
      put: (data, mime) => host.putContent(this.keepable(data), mime),
      side: (kind, u) => {
        if (kind === "usage") this.contextUsage = { used: u.used, size: u.size };
      },
    });
    this.chat = chat;
    host.emit(chat, {
      type: ActionType.ChatTurnStarted,
      turnId: this.turnId,
      startedAt: new Date(info.startedAt).toISOString(),
      message: { text: shownBrief(info.brief) || "(no brief)", origin: USER_ORIGIN },
    } as never);
    return true;
  }

  /** What a tool left in a file or image, in the size the view keeps. */
  private keepable(data: string | Uint8Array): string | Uint8Array {
    if (typeof data === "string")
      return redactTokens(data.length > MAX_DIFF_CHARS ? `${data.slice(0, MAX_DIFF_CHARS)}\n[…cut]` : data);
    return data.byteLength > MAX_BINARY_BYTES ? `[not kept: ${data.byteLength} bytes]` : data;
  }

  /** The mapper's output: counted, capped, and handed to the host (which redacts and caps it again). */
  private emit(a: ChatAction): boolean {
    if (this.ended || this.broken || !this.chat) return false;
    const action = a as unknown as Json;
    const type = action.type;
    const opens = type === ActionType.ChatResponsePart || type === ActionType.ChatToolCallStart;
    // The last slots are for the end: the note of what was left out, and the answer.
    if (opens && this.parts >= MAX_STAGE_PARTS - TAIL_PARTS) {
      if (!this.capped) {
        this.capped = true;
        this.host.emit(this.chat, {
          type: ActionType.ChatResponsePart,
          turnId: this.turnId,
          part: {
            kind: ResponsePartKind.Markdown,
            id: `${this.turnId}:cap`,
            content: `…this view stops adding new steps after ${MAX_STAGE_PARTS - TAIL_PARTS}. The ticket's transcript lists the rest.`,
          },
        } as never);
      }
      this.hidden++;
      if (type === ActionType.ChatResponsePart) this.lastTextHidden = true;
      return false;
    }
    if (type === ActionType.ChatToolCallStart) this.started.add(String(action.toolCallId));
    if (this.capped && typeof action.toolCallId === "string" && !this.started.has(action.toolCallId))
      return false;
    if (opens) this.parts++;
    if (type === ActionType.ChatResponsePart) {
      this.spoke = true;
      this.lastTextHidden = false;
    }
    if (type === ActionType.ChatDelta) this.spoke = true;
    this.host.emit(this.chat, capToolTexts(a) as never);
    return true;
  }

  /** One ACP `session/update` of an agent that speaks ACP. */
  update(u: Json): void {
    this.acp = true;
    if (this.ended) return;
    this.guard("an update", () => {
      this.open();
      if (this.capped) {
        // Past the cap only what is already open is followed: no new calls are remembered.
        const kind = u.sessionUpdate;
        const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
        if (kind === "tool_call") this.hidden++;
        if (kind === "tool_call" || kind === "plan" || (kind === "tool_call_update" && !this.started.has(id)))
          return;
      }
      this.mapper?.update(u);
    });
  }

  /** The finished prompt's token counts. */
  usage(u: Json): void {
    if (!this.ended) this.promptUsage = u;
  }

  /**
   * A transcript item from an agent that does not speak ACP (a scripted one, the local model): it is mapped to
   * the same updates, so those stages can be watched too. Ignored once the agent has sent ACP updates.
   */
  item(it: SessionTranscriptItem): void {
    if (this.acp || this.ended) return;
    this.guard("an item", () => {
      this.open();
      if (it.kind === "text") {
        const key = it.id ?? `text-${this.texts.size + 1}`;
        const text = it.text ?? "";
        const before = this.texts.get(key);
        if (before === undefined) {
          if (text)
            this.mapper?.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
        } else if (text.startsWith(before) && text.length > before.length) {
          this.mapper?.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: text.slice(before.length) },
          });
        }
        this.texts.set(key, text);
        return;
      }
      const id = it.id ?? `tool-${++this.fallbackTools}`;
      const status =
        it.status && /fail|error|denied|cancel/i.test(it.status)
          ? "failed"
          : it.status
            ? "completed"
            : "pending";
      if (!this.started.has(id)) {
        this.mapper?.update({
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: it.title ?? "Tool call",
          kind: "other",
          status: it.status ? status : "pending",
          ...(it.text ? { content: [{ type: "content", content: { type: "text", text: it.text } }] } : {}),
          ...(it.locations?.length ? { locations: it.locations.map((path) => ({ path })) } : {}),
        });
      } else {
        this.mapper?.update({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status,
          ...(it.title ? { title: it.title } : {}),
          ...(it.text ? { content: [{ type: "content", content: { type: "text", text: it.text } }] } : {}),
        });
      }
    });
  }

  /** A text part at the end of the turn, in the slots the cap keeps for it. */
  private emitTail(id: string, content: string): void {
    this.host.emit(
      this.chat as string,
      {
        type: ActionType.ChatResponsePart,
        turnId: this.turnId,
        part: { kind: ResponsePartKind.Markdown, id: `${this.turnId}:${id}`, content },
      } as never,
    );
  }

  /** The session is over. Safe to call twice. */
  end(how: StageEnd): void {
    if (this.ended) return;
    // A view that broke part-way still must not be left "running".
    if (this.broken && this.chat) {
      try {
        this.host.emit(this.chat, {
          type: ActionType.ChatTurnCancelled,
          turnId: this.turnId,
          duration: Math.max(0, this.now() - this.info.startedAt),
        } as never);
      } catch {}
    }
    this.guard("the end", () => {
      // A launch that never got going made no session worth showing.
      if (!this.chat && ((how.kind === "stuck" && how.startup === true) || how.kind === "stopping")) return;
      this.open();
      const chat = this.chat as string;
      // What the cap kept out is counted, so the view never looks complete when it is not, and the answer is shown
      // even when the cap hid the text part it was said in.
      const out = how.kind === "done" ? how.output.trim() : "";
      const showAnswer = out !== "" && (!this.spoke || (this.capped && this.lastTextHidden));
      if (this.hidden > 0) {
        this.emitTail(
          "hidden",
          `${this.hidden} step${this.hidden === 1 ? "" : "s"} not shown here. The ticket's transcript lists them.`,
        );
      }
      if (showAnswer) this.emitTail("answer", capText(out, MAX_ANSWER_CHARS));
      this.mapper?.finish();
      const usage = this.promptUsage;
      if (usage || this.contextUsage) {
        this.host.emit(chat, {
          type: ActionType.ChatUsage,
          turnId: this.turnId,
          usage: {
            ...(typeof usage?.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
            ...(typeof usage?.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
            ...(typeof usage?.cachedReadTokens === "number"
              ? { cacheReadTokens: usage.cachedReadTokens }
              : {}),
            model: this.info.model,
            ...(this.contextUsage
              ? { _meta: { contextUsed: this.contextUsage.used, contextSize: this.contextUsage.size } }
              : {}),
          },
        } as never);
      }
      const duration = Math.max(0, this.now() - this.info.startedAt);
      const base = { turnId: this.turnId, duration };
      const error = (errorType: string, message: string) =>
        this.host.emit(chat, {
          type: ActionType.ChatError,
          ...base,
          part: { kind: ResponsePartKind.Error, resumable: false, error: { errorType, message } },
        } as never);
      switch (how.kind) {
        case "done":
          this.host.emit(chat, { type: ActionType.ChatTurnComplete, ...base } as never);
          break;
        case "interrupted":
          this.host.emit(chat, { type: ActionType.ChatTurnCancelled, ...base } as never);
          break;
        case "stopping":
          this.host.emit(chat, { type: ActionType.ChatTurnCancelled, ...base } as never);
          break;
        case "out-of-tokens":
          error(
            "out_of_tokens",
            `The engine is out of tokens. The stage starts again after ${new Date(how.resetsAt).toISOString().slice(0, 16).replace("T", " ")} UTC.`,
          );
          break;
        case "stuck":
          error("stuck", safeReason(how.reason));
          break;
        case "crashed":
          error("crashed", safeReason(how.reason));
          break;
      }
    });
    this.ended = true;
    this.owner.done(this);
  }
}
