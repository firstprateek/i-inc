// ACP <-> AHP: the only place that knows ACP's shapes (docs/design/ahp-spike.md has the full table).
//
// Forward: one TurnMapper per prompt turn turns the agent's `session/update` notifications into AHP
// chat actions and its permission requests into pending tool confirmations.
// Backward: `promptBlocks` (a user message into ACP content blocks), `permissionOutcome` (the user's
// answer into the ACP option) and `configFromAcp` (the agent's modes and options into the session's
// config schema).
//
// What AHP 1.0 has no field for travels in `_meta` (contract C22): tool-call locations, the plan.
import type { ContentRef, Message, SessionConfigState } from "@microsoft/agent-host-protocol";
import { redactTokens } from "./sanitize.ts";
import {
  ActionType,
  type ChatAction,
  ConfirmationOptionKind,
  type Json,
  ResponsePartKind,
  ToolCallConfirmationReason,
  ToolResultContentType,
} from "./wire.ts";

/** Stores text behind an `ahp-content:` URI (the host serves it with `resourceRead`). */
export type PutContent = (data: string | Uint8Array, mime?: string) => ContentRef;

/** What the mapper remembers about one ACP tool call. */
interface ToolState {
  title: string;
  kind: string;
  phase: "streaming" | "pending-confirmation" | "running" | "done";
  /** What the agent said it was calling the tool with, kept for when the call becomes ready. */
  rawInput?: unknown;
  /** Why the call is running, for when its input is updated after it started. */
  confirmed?: (typeof ToolCallConfirmationReason)[keyof typeof ToolCallConfirmationReason];
  /** ACP option kinds by optionId, kept so a confirmation can be answered with the right option. */
  optionKinds?: Map<string, string>;
}

/**
 * A tool call's ACP `locations` as the view keeps them (`_meta["iinc.locations"]`): at most 20, each path with the
 * credentials in it redacted (a path can carry a token or a URL's userinfo) and cut to 500 characters, as the
 * paths of a diff are. Only `path` and `line` are kept.
 */
export function cleanLocations(locations: unknown): Json[] {
  if (!Array.isArray(locations)) return [];
  const out: Json[] = [];
  for (const l of locations) {
    if (out.length >= 20) break;
    if (!l || typeof l !== "object" || typeof (l as Json).path !== "string") continue;
    const { path, line } = l as Json;
    out.push({
      path: redactTokens(String(path)).slice(0, 500),
      ...(typeof line === "number" && Number.isFinite(line) ? { line } : {}),
    });
  }
  return out;
}

const lines = (s: string | undefined | null) => (s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);
const MAX_DIFF_SIDE = 1024 * 1024;
const cutSide = (s: string) => (s.length > MAX_DIFF_SIDE ? `${s.slice(0, MAX_DIFF_SIDE)}\n[…truncated]` : s);

/** ACP tool-call content into AHP tool result content. Diffs become file edits with content refs. */
export function mapToolContent(content: Json[] | undefined, put: PutContent): Json[] {
  const out: Json[] = [];
  for (const c of content ?? []) {
    if (c.type === "content" && (c.content as Json | undefined)?.type === "text") {
      out.push({ type: ToolResultContentType.Text, text: String((c.content as Json).text) });
    } else if (c.type === "content" && (c.content as Json | undefined)?.type === "image") {
      const img = c.content as Json;
      const ref = put(Buffer.from(String(img.data ?? ""), "base64"), String(img.mimeType ?? "image/png"));
      out.push({ type: ToolResultContentType.Resource, ...ref });
    } else if (c.type === "content" && (c.content as Json | undefined)?.type === "resource_link") {
      const l = c.content as Json;
      out.push({
        type: ToolResultContentType.Text,
        text: `${String(l.name ?? "link")}: ${String(l.uri ?? "")}`,
      });
    } else if (c.type === "diff") {
      const path = redactTokens(String(c.path)).slice(0, 500);
      const uri = path.startsWith("/") ? `file://${path}` : `file:///${path}`;
      const before = c.oldText !== undefined && c.oldText !== null ? cutSide(String(c.oldText)) : undefined;
      const after = cutSide(String(c.newText ?? ""));
      out.push({
        type: ToolResultContentType.FileEdit,
        ...(before !== undefined ? { before: { uri, content: put(before, "text/plain") } } : {}),
        after: { uri, content: put(after, "text/plain") },
        diff: { added: lines(after), removed: lines(before) },
      });
    } else if (c.type === "terminal") {
      // We offer no ACP terminal capability, so this is not expected; keep a trace rather than nothing.
      out.push({ type: ToolResultContentType.Text, text: `[terminal ${String(c.terminalId)}]` });
    }
  }
  return out;
}

export interface MapperEnv {
  turnId: string;
  /** Streams one action into the chat; false once the turn is over. */
  emit: (a: ChatAction) => boolean;
  put: PutContent;
  /** Updates that are not chat actions: modes, config, commands, usage, and anything unknown. */
  side: (kind: string, update: Json) => void;
}

export class TurnMapper {
  private n = 0;
  private mdPart: string | undefined;
  private thoughtPart: string | undefined;
  private planCall: string | undefined;
  private planContent: Json[] = [];
  private planEntries: unknown[] = [];
  readonly tools = new Map<string, ToolState>();

  constructor(private readonly env: MapperEnv) {}

  private emit(a: Json): void {
    this.env.emit({ ...a, turnId: this.env.turnId } as unknown as ChatAction);
  }

  private partId(k: string): string {
    return `${this.env.turnId}:${k}${++this.n}`;
  }

  private closeText(): void {
    this.mdPart = undefined;
    this.thoughtPart = undefined;
  }

  /** One ACP `session/update` into zero or more chat actions. */
  update(u: Json): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const c = u.content as Json | undefined;
        // Images, audio and resources from the agent have no place in a markdown part yet.
        if (c?.type !== "text") {
          this.env.side(`dropped:agent_message_chunk:${String(c?.type)}`, u);
          return;
        }
        this.thoughtPart = undefined;
        if (!this.mdPart) {
          this.mdPart = this.partId("md");
          this.emit({
            type: ActionType.ChatResponsePart,
            part: { kind: ResponsePartKind.Markdown, id: this.mdPart, content: String(c.text) },
          });
        } else {
          this.emit({ type: ActionType.ChatDelta, partId: this.mdPart, content: String(c.text) });
        }
        return;
      }
      case "agent_thought_chunk": {
        const c = u.content as Json | undefined;
        if (c?.type !== "text") return;
        this.mdPart = undefined;
        if (!this.thoughtPart) {
          this.thoughtPart = this.partId("th");
          this.emit({
            type: ActionType.ChatResponsePart,
            part: { kind: ResponsePartKind.Reasoning, id: this.thoughtPart, content: String(c.text) },
          });
        } else {
          this.emit({ type: ActionType.ChatReasoning, partId: this.thoughtPart, content: String(c.text) });
        }
        return;
      }
      case "tool_call":
        this.toolCall(u);
        return;
      case "tool_call_update":
        this.toolUpdate(u);
        return;
      case "plan":
        this.plan(u);
        return;
      case "usage_update":
        this.env.side("usage", u);
        return;
      case "current_mode_update":
      case "config_option_update":
      case "available_commands_update":
      case "session_info_update":
        this.env.side(String(u.sessionUpdate), u);
        return;
      case "user_message_chunk":
        // Only seen while a session/load replays history; the host owns the transcript.
        return;
      default:
        this.env.side(`unknown:${String(u.sessionUpdate)}`, u);
        return;
    }
  }

  private toolCall(u: Json): void {
    this.closeText();
    const id = String(u.toolCallId);
    const title = String(u.title ?? id);
    const kind = String(u.kind ?? "other");
    const locations = cleanLocations(u.locations);
    this.tools.set(id, { title, kind, phase: "streaming", rawInput: u.rawInput });
    this.emit({
      type: ActionType.ChatToolCallStart,
      toolCallId: id,
      toolName: kind,
      displayName: title,
      ...(locations.length ? { _meta: { "iinc.locations": locations } } : {}),
    });
    // `pending` means the agent may still ask for permission. Anything else is already past that:
    // in_progress is running (its content so far shows), and completed or failed is over, with its
    // result (an agent may announce a call that already finished, as one event).
    if (u.status && u.status !== "pending") {
      this.ready(id, u, ToolCallConfirmationReason.NotNeeded);
      if (u.status === "completed" || u.status === "failed") this.complete(id, u);
      else this.running(id, u);
    }
  }

  /** The call is over: its result, with the content that came with the last update. */
  private complete(id: string, u: Json): void {
    const t = this.tools.get(id);
    if (!t || t.phase === "done") return;
    t.phase = "done";
    const ok = u.status === "completed";
    this.emit({
      type: ActionType.ChatToolCallComplete,
      toolCallId: id,
      result: {
        success: ok,
        pastTenseMessage: t.title,
        content: mapToolContent(u.content as Json[] | undefined, this.env.put),
        ...(ok ? {} : { error: { message: `${t.title} failed` } }),
      },
      ...(cleanLocations(u.locations).length
        ? { _meta: { "iinc.locations": cleanLocations(u.locations) } }
        : {}),
    });
  }

  private ready(
    id: string,
    u: Json,
    confirmed?: (typeof ToolCallConfirmationReason)[keyof typeof ToolCallConfirmationReason],
    extra: Json = {},
  ): void {
    const t = this.tools.get(id);
    if (!t) return;
    t.phase = confirmed ? "running" : "pending-confirmation";
    if (confirmed) t.confirmed = confirmed;
    if (u.rawInput !== undefined) t.rawInput = u.rawInput;
    this.emit({
      type: ActionType.ChatToolCallReady,
      toolCallId: id,
      invocationMessage: String(u.title ?? t.title),
      ...(t.rawInput !== undefined ? { toolInput: JSON.stringify(t.rawInput) } : {}),
      ...(confirmed ? { confirmed } : {}),
      ...extra,
    });
  }

  /** Content that arrived with a call that is already running. */
  private running(id: string, u: Json): void {
    const content = mapToolContent(u.content as Json[] | undefined, this.env.put);
    if (content.length) this.emit({ type: ActionType.ChatToolCallContentChanged, toolCallId: id, content });
  }

  private toolUpdate(u: Json): void {
    const id = String(u.toolCallId);
    let t = this.tools.get(id);
    if (!t) {
      // The agent never announced it: announce now.
      this.toolCall({ ...u, title: u.title ?? id, kind: u.kind ?? "other", status: "pending" });
      t = this.tools.get(id);
    }
    if (!t || t.phase === "done") return;
    if (u.title) t.title = String(u.title);
    // The agent fills in the arguments as it learns them: a call already announced gets them again.
    if (u.rawInput !== undefined && JSON.stringify(u.rawInput) !== JSON.stringify(t.rawInput)) {
      t.rawInput = u.rawInput;
      if (t.phase === "running" || t.phase === "pending-confirmation") {
        this.emit({
          type: ActionType.ChatToolCallReady,
          toolCallId: id,
          invocationMessage: t.title,
          toolInput: JSON.stringify(u.rawInput),
          ...(t.phase === "running" && t.confirmed ? { confirmed: t.confirmed } : {}),
        });
      }
    }
    if (t.phase === "streaming" && u.status && u.status !== "pending") {
      this.ready(id, u, ToolCallConfirmationReason.NotNeeded);
    }
    if (u.status === "completed" || u.status === "failed") {
      if (t.phase === "pending-confirmation") return; // still waiting for the owner
      this.complete(id, u);
    } else if (t.phase === "running") {
      this.running(id, u);
    }
  }

  /** AHP 1.0 has no plan part: a pseudo tool call carries a checklist as text and the entries in `_meta`. */
  private plan(u: Json): void {
    const entries = (u.entries ?? []) as { content: string; status: string; priority: string }[];
    const md = entries.map((e) => `- [${e.status === "completed" ? "x" : " "}] ${e.content}`).join("\n");
    this.planContent = [{ type: ToolResultContentType.Text, text: md }];
    this.planEntries = entries;
    if (!this.planCall) {
      this.closeText();
      this.planCall = `${this.env.turnId}:plan`;
      this.tools.set(this.planCall, { title: "Plan", kind: "plan", phase: "running" });
      this.emit({
        type: ActionType.ChatToolCallStart,
        toolCallId: this.planCall,
        toolName: "x-iinc-plan",
        displayName: "Plan",
      });
      this.emit({
        type: ActionType.ChatToolCallReady,
        toolCallId: this.planCall,
        invocationMessage: "Plan",
        confirmed: ToolCallConfirmationReason.NotNeeded,
      });
    }
    this.emit({
      type: ActionType.ChatToolCallContentChanged,
      toolCallId: this.planCall,
      content: this.planContent,
      _meta: { "iinc.plan": entries },
    });
  }

  /** Before the turn completes: ends the pseudo plan tool call so the turn doesn't force-cancel it. */
  finish(): void {
    if (this.planCall && this.tools.get(this.planCall)?.phase !== "done") {
      const t = this.tools.get(this.planCall);
      if (t) t.phase = "done";
      this.emit({
        type: ActionType.ChatToolCallComplete,
        toolCallId: this.planCall,
        result: { success: true, pastTenseMessage: "Plan", content: this.planContent },
        _meta: { "iinc.plan": this.planEntries },
      });
    }
  }

  /** `session/request_permission` becomes a tool call waiting for the owner, with the agent's options. */
  permission(p: Json): void {
    const call = (p.toolCall ?? {}) as Json;
    const id = String(call.toolCallId);
    const options = (p.options ?? []) as Json[];
    let t = this.tools.get(id);
    if (!t) {
      t = { title: String(call.title ?? id), kind: String(call.kind ?? "other"), phase: "streaming" };
      this.tools.set(id, t);
      this.closeText();
      this.emit({
        type: ActionType.ChatToolCallStart,
        toolCallId: id,
        toolName: t.kind,
        displayName: t.title,
      });
    }
    t.optionKinds = new Map(options.map((o) => [String(o.optionId), String(o.kind)]));
    const diffs = mapToolContent(
      (call.content as Json[] | undefined)?.filter((c) => c.type === "diff"),
      this.env.put,
    );
    this.ready(id, { ...call, title: call.title ?? t.title }, undefined, {
      confirmationTitle: String(call.title ?? t.title),
      options: options.map((o) => ({
        id: String(o.optionId),
        label: String(o.name),
        kind: String(o.kind).startsWith("allow")
          ? ConfirmationOptionKind.Approve
          : ConfirmationOptionKind.Deny,
        // AHP has no once-or-always flag: the group carries it (0 once, 1 always); the labels say it too.
        group: String(o.kind).endsWith("always") ? 1 : 0,
      })),
      ...(diffs.length ? { edits: { items: diffs.map(({ type: _t, ...edit }) => edit) } } : {}),
    });
  }

  /** The ACP answer for a confirmation: the option the owner chose, or the plain allow or reject. */
  permissionOutcome(toolCallId: string, approved: boolean, selectedOptionId?: string): Json {
    const kinds = this.tools.get(toolCallId)?.optionKinds;
    let optionId = selectedOptionId;
    if (!optionId || !kinds?.has(optionId)) {
      const want = approved ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
      optionId = [...(kinds ?? [])].find(([, k]) => want.includes(k))?.[0];
    }
    return optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" };
  }

  /** The owner answered: approved means running; denied means the call is over (the reducer cancels it). */
  confirmed(id: string, approved: boolean): void {
    const t = this.tools.get(id);
    if (!t) return;
    t.phase = approved ? "running" : "done";
    if (approved) t.confirmed = ToolCallConfirmationReason.UserAction;
  }
}

/** A user message into ACP prompt content blocks: text, then images, files and links. */
export function promptBlocks(m: Message, caps: Json = {}): Json[] {
  const prompt = (caps.promptCapabilities ?? {}) as Json;
  const blocks: Json[] = [{ type: "text", text: m.text }];
  for (const raw of m.attachments ?? []) {
    const a = raw as unknown as Json;
    const label = String(a.label ?? "attachment");
    const type = String(a.contentType ?? "");
    if (a.type === "embeddedResource" && type.startsWith("image/")) {
      if (prompt.image) blocks.push({ type: "image", data: a.data, mimeType: type });
      else
        blocks.push({
          type: "text",
          text: `[The user attached an image, ${label}, but this agent can't see images.]`,
        });
    } else if (a.type === "embeddedResource") {
      const text = /^(text\/|application\/(json|xml|x-yaml))/.test(type)
        ? Buffer.from(String(a.data), "base64").toString("utf8")
        : undefined;
      if (prompt.embeddedContext) {
        blocks.push({
          type: "resource",
          resource: {
            uri: `attachment:///${label}`,
            mimeType: type,
            ...(text !== undefined ? { text } : { blob: a.data }),
          },
        });
      } else if (text !== undefined) {
        blocks.push({ type: "text", text: `<attachment name="${label}">\n${text}\n</attachment>` });
      } else {
        blocks.push({
          type: "text",
          text: `[The user attached ${label} (${type}), which this agent can't read.]`,
        });
      }
    } else if (a.type === "resource") {
      blocks.push({ type: "resource_link", uri: a.uri, name: label, ...(type ? { mimeType: type } : {}) });
    } else if (a.type === "simple" && typeof a.modelRepresentation === "string") {
      blocks.push({ type: "text", text: a.modelRepresentation });
    }
  }
  return blocks;
}

/** The agent's session modes and select options as a session config schema with its current values. */
export function configFromAcp(modes: Json | undefined, options: Json[] | undefined): SessionConfigState {
  const properties: SessionConfigState["schema"]["properties"] = {};
  const values: Record<string, unknown> = {};
  const available = (modes?.availableModes ?? []) as Json[];
  if (available.length) {
    properties.mode = {
      type: "string",
      title: "Mode",
      sessionMutable: true,
      enum: available.map((m) => String(m.id)),
      enumLabels: available.map((m) => String(m.name ?? m.id)),
      enumDescriptions: available.map((m) => String(m.description ?? "")),
    };
    values.mode = modes?.currentModeId;
  }
  for (const o of options ?? []) {
    if (o.type !== "select" || typeof o.id !== "string") continue;
    if (o.id === "mode" && properties.mode) continue; // the modes list already says it
    const flat = ((o.options ?? []) as Json[]).flatMap((x) =>
      Array.isArray(x.options) ? (x.options as Json[]) : [x],
    );
    properties[o.id] = {
      type: "string",
      title: String(o.name ?? o.id),
      ...(typeof o.description === "string" ? { description: o.description } : {}),
      sessionMutable: true,
      enum: flat.map((x) => String(x.value)),
      enumLabels: flat.map((x) => String(x.name ?? x.value)),
    };
    values[o.id] = o.currentValue;
  }
  return { schema: { type: "object", properties }, values };
}
