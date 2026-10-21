// ACP -> AHP event mapper, and the reverse helpers. This is the only place that knows ACP's shapes.
// Forward: one TurnMapper per prompt turn turns session/update notifications into AHP chat actions.
// Reverse: promptBlocks() (Message -> ACP content blocks), permissionOutcome() (confirmation -> ACP answer).
import {
  type ChatAction,
  ConfirmationOptionKind,
  type ContentRef,
  ResponsePartKind,
  ToolCallConfirmationReason,
  ToolResultContentType,
  ActionType,
  type Message,
} from "@microsoft/agent-host-protocol";
import type { Json } from "./acp.ts";

export type PutContent = (text: string, mime?: string) => ContentRef;

/** What the mapper remembers about one ACP tool call. */
interface ToolState {
  title: string;
  kind: string;
  phase: "streaming" | "pending-confirmation" | "running" | "done";
  /** ACP option kinds by optionId, kept so a confirmation can be answered with the right option. */
  optionKinds?: Map<string, string>;
}

const lines = (s: string | undefined) => (s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);

/** ACP tool-call content -> AHP ToolResultContent[]. Diffs become fileEdit with ContentRefs. */
export function mapToolContent(content: Json[] | undefined, put: PutContent): any[] {
  const out: any[] = [];
  for (const c of content ?? []) {
    if (c.type === "content" && c.content?.type === "text") {
      out.push({ type: ToolResultContentType.Text, text: String(c.content.text) });
    } else if (c.type === "content" && c.content?.type === "image") {
      out.push({ type: ToolResultContentType.EmbeddedResource, data: c.content.data, contentType: c.content.mimeType });
    } else if (c.type === "diff") {
      const uri = `file://${c.path}`;
      out.push({
        type: ToolResultContentType.FileEdit,
        ...(c.oldText !== undefined && c.oldText !== null ? { before: { uri, content: put(c.oldText, "text/plain") } } : {}),
        after: { uri, content: put(String(c.newText ?? ""), "text/plain") },
        diff: { added: lines(c.newText), removed: lines(c.oldText) },
      });
    } else if (c.type === "terminal") {
      // GAP: AHP wants a terminal channel (ToolResultTerminalContent). ACP terminals live in the agent's
      // own process; for the spike we surface the id as text.
      out.push({ type: ToolResultContentType.Text, text: `[terminal ${c.terminalId}]` });
    }
  }
  return out;
}

export class TurnMapper {
  private n = 0;
  private mdPart: string | undefined;
  private thoughtPart: string | undefined;
  private planCall: string | undefined;
  private planContent: any[] = [];
  private planEntries: unknown[] = [];
  readonly tools = new Map<string, ToolState>();
  closed = false;

  constructor(
    readonly turnId: string,
    private readonly emit: (a: ChatAction) => void,
    private readonly put: PutContent,
    /** Side effects the mapper cannot express as chat actions (modes, commands, usage). */
    private readonly side: (kind: string, u: Json) => void = () => {},
  ) {}

  private partId(k: string) {
    return `${this.turnId}:${k}${++this.n}`;
  }

  private closeText() {
    this.mdPart = undefined;
    this.thoughtPart = undefined;
  }

  /** One ACP `session/update` -> zero or more AHP actions. */
  update(u: Json): void {
    if (this.closed) return;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        if (u.content?.type !== "text") return; // GAP: image/audio/resource_link chunks from the agent are dropped
        this.thoughtPart = undefined;
        if (!this.mdPart) {
          this.mdPart = this.partId("md");
          this.emit({
            type: ActionType.ChatResponsePart, turnId: this.turnId,
            part: { kind: ResponsePartKind.Markdown, id: this.mdPart, content: u.content.text },
          } as ChatAction);
        } else {
          this.emit({ type: ActionType.ChatDelta, turnId: this.turnId, partId: this.mdPart, content: u.content.text } as ChatAction);
        }
        return;
      }
      case "agent_thought_chunk": {
        if (u.content?.type !== "text") return;
        this.mdPart = undefined;
        if (!this.thoughtPart) {
          this.thoughtPart = this.partId("th");
          this.emit({
            type: ActionType.ChatResponsePart, turnId: this.turnId,
            part: { kind: ResponsePartKind.Reasoning, id: this.thoughtPart, content: u.content.text },
          } as ChatAction);
        } else {
          this.emit({ type: ActionType.ChatReasoning, turnId: this.turnId, partId: this.thoughtPart, content: u.content.text } as ChatAction);
        }
        return;
      }
      case "tool_call":
        return this.toolCall(u);
      case "tool_call_update":
        return this.toolUpdate(u);
      case "plan":
        return this.plan(u);
      case "usage_update": // ACP (unstable) context usage: used/size
        return this.side("usage", u);
      case "current_mode_update":
      case "config_option_update":
      case "available_commands_update":
        return this.side(String(u.sessionUpdate), u);
      case "user_message_chunk":
        // Only seen while replaying history on session/load. The host already owns the transcript, so a
        // live conversation ignores the replay. (Importing a foreign session would map these to turns.)
        return this.side("user_message_chunk", u);
      default:
        return this.side(`unknown:${String(u.sessionUpdate)}`, u);
    }
  }

  private toolCall(u: Json) {
    this.closeText();
    const id = String(u.toolCallId);
    const meta = u.locations?.length ? { "iinc.locations": u.locations } : undefined;
    this.tools.set(id, { title: String(u.title ?? id), kind: String(u.kind ?? "other"), phase: "streaming" });
    this.emit({
      type: ActionType.ChatToolCallStart, turnId: this.turnId, toolCallId: id,
      toolName: String(u.kind ?? "other"), displayName: String(u.title ?? id),
      ...(meta ? { _meta: meta } : {}),
    } as ChatAction);
    // pending = the agent may still ask for permission; anything else is already running.
    if (u.status && u.status !== "pending") this.ready(id, u, ToolCallConfirmationReason.NotNeeded);
  }

  private ready(id: string, u: Json, confirmed?: ToolCallConfirmationReason, extra: Json = {}) {
    const t = this.tools.get(id);
    if (!t) return;
    t.phase = confirmed ? "running" : "pending-confirmation";
    this.emit({
      type: ActionType.ChatToolCallReady, turnId: this.turnId, toolCallId: id,
      invocationMessage: String(u.title ?? t.title),
      ...(u.rawInput !== undefined ? { toolInput: JSON.stringify(u.rawInput) } : {}),
      ...(confirmed ? { confirmed } : {}),
      ...extra,
    } as ChatAction);
  }

  private toolUpdate(u: Json) {
    const id = String(u.toolCallId);
    let t = this.tools.get(id);
    if (!t) {
      // The agent never announced it (or the turn was replayed): announce now.
      this.toolCall({ ...u, title: u.title ?? id, kind: u.kind ?? "other", status: "pending" });
      t = this.tools.get(id);
    }
    if (!t || t.phase === "done") return;
    if (u.title) t.title = String(u.title);
    if (t.phase === "streaming" && u.status && u.status !== "pending") {
      this.ready(id, u, ToolCallConfirmationReason.NotNeeded);
    }
    if (u.status === "completed" || u.status === "failed") {
      if (t.phase === "pending-confirmation") return; // denied path already ended it
      t.phase = "done";
      const ok = u.status === "completed";
      this.emit({
        type: ActionType.ChatToolCallComplete, turnId: this.turnId, toolCallId: id,
        result: {
          success: ok,
          pastTenseMessage: t.title,
          content: mapToolContent(u.content, this.put),
          ...(ok ? {} : { error: { message: `${t.title} failed` } }),
        },
        ...(u.locations?.length ? { _meta: { "iinc.locations": u.locations } } : {}),
      } as ChatAction);
    } else if (u.content?.length && t.phase === "running") {
      this.emit({
        type: ActionType.ChatToolCallContentChanged, turnId: this.turnId, toolCallId: id,
        content: mapToolContent(u.content, this.put),
      } as ChatAction);
    }
  }

  /** GAP: AHP has no plan part. A pseudo tool call "plan" carries the entries in _meta and a checklist as text. */
  private plan(u: Json) {
    const entries = (u.entries ?? []) as { content: string; status: string; priority: string }[];
    const md = entries.map((e) => `- [${e.status === "completed" ? "x" : " "}] ${e.content}`).join("\n");
    const content = [{ type: ToolResultContentType.Text, text: md }];
    this.planContent = content;
    this.planEntries = entries;
    if (!this.planCall) {
      this.closeText();
      this.planCall = `${this.turnId}:plan`;
      this.tools.set(this.planCall, { title: "Plan", kind: "plan", phase: "running" });
      this.emit({
        type: ActionType.ChatToolCallStart, turnId: this.turnId, toolCallId: this.planCall,
        toolName: "x-iinc-plan", displayName: "Plan",
      } as ChatAction);
      this.emit({
        type: ActionType.ChatToolCallReady, turnId: this.turnId, toolCallId: this.planCall,
        invocationMessage: "Plan", confirmed: ToolCallConfirmationReason.NotNeeded,
      } as ChatAction);
    }
    this.emit({
      type: ActionType.ChatToolCallContentChanged, turnId: this.turnId, toolCallId: this.planCall,
      content, _meta: { "iinc.plan": entries },
    } as ChatAction);
  }

  /** Before turnComplete: end the pseudo plan tool call so the turn doesn't force-cancel it. */
  finish(): void {
    if (this.planCall && this.tools.get(this.planCall)?.phase !== "done") {
      this.tools.get(this.planCall)!.phase = "done";
      this.emit({
        type: ActionType.ChatToolCallComplete, turnId: this.turnId, toolCallId: this.planCall,
        result: { success: true, pastTenseMessage: "Plan", content: this.planContent },
        _meta: { "iinc.plan": this.planEntries },
      } as ChatAction);
    }
  }

  /** `session/request_permission` -> toolCallReady without `confirmed` = pending-confirmation + options. */
  permission(p: Json): void {
    const id = String(p.toolCall?.toolCallId);
    const t = this.tools.get(id) ?? { title: String(p.toolCall?.title ?? id), kind: String(p.toolCall?.kind ?? "other"), phase: "streaming" as const };
    if (!this.tools.has(id)) {
      this.tools.set(id, t);
      this.emit({
        type: ActionType.ChatToolCallStart, turnId: this.turnId, toolCallId: id,
        toolName: t.kind, displayName: t.title,
      } as ChatAction);
    }
    t.optionKinds = new Map((p.options as Json[]).map((o) => [String(o.optionId), String(o.kind)]));
    const diffs = mapToolContent((p.toolCall?.content as Json[] | undefined)?.filter((c) => c.type === "diff"), this.put);
    this.ready(id, { ...p.toolCall, title: p.toolCall?.title ?? t.title }, undefined, {
      confirmationTitle: String(p.toolCall?.title ?? t.title),
      options: (p.options as Json[]).map((o) => ({
        id: String(o.optionId),
        label: String(o.name),
        kind: String(o.kind).startsWith("allow") ? ConfirmationOptionKind.Approve : ConfirmationOptionKind.Deny,
        // GAP: AHP has no once/always distinction; the group number carries it (0 = once, 1 = always)
        group: String(o.kind).endsWith("always") ? 1 : 0,
      })),
      ...(diffs.length ? { edits: { items: diffs.map(({ type: _t, ...edit }) => edit) } } : {}),
    });
  }

  /** The ACP answer for a confirmation (approved or not, with the option the user picked). */
  permissionOutcome(toolCallId: string, approved: boolean, selectedOptionId?: string): Json {
    const kinds = this.tools.get(toolCallId)?.optionKinds;
    let optionId = selectedOptionId;
    if (!optionId || !kinds?.has(optionId)) {
      const want = approved ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
      optionId = [...(kinds ?? [])].find(([, k]) => want.includes(k))?.[0];
    }
    return optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" };
  }

  /** A client confirmed or denied: approved -> running; denied -> the tool call is over (reducer cancels it). */
  confirmed(id: string, approved: boolean) {
    const t = this.tools.get(id);
    if (t) t.phase = approved ? "running" : "done";
  }
}

/** AHP Message -> ACP prompt content blocks (text + images + resource links). */
export function promptBlocks(m: Message): Json[] {
  const blocks: Json[] = [{ type: "text", text: m.text }];
  for (const a of m.attachments ?? []) {
    const att = a as Json;
    if (att.type === "embeddedResource" && String(att.contentType).startsWith("image/")) {
      blocks.push({ type: "image", data: att.data, mimeType: att.contentType });
    } else if (att.type === "embeddedResource") {
      blocks.push({ type: "resource", resource: { uri: `attachment:${att.label}`, mimeType: att.contentType, blob: att.data } });
    } else if (att.type === "resource") {
      blocks.push({ type: "resource_link", uri: att.uri, name: att.label });
    }
    // GAP: annotations / chat attachments have no ACP equivalent; they would have to be flattened to text.
  }
  return blocks;
}

/** ACP session modes + config options -> an AHP session config schema + values. */
export function configFromAcp(modes: Json | undefined, options: Json[] | undefined) {
  const properties: Record<string, any> = {};
  const values: Record<string, unknown> = {};
  if (modes?.availableModes?.length) {
    properties.mode = {
      type: "string", title: "Mode", sessionMutable: true,
      enum: modes.availableModes.map((m: Json) => m.id),
      enumLabels: modes.availableModes.map((m: Json) => m.name),
      enumDescriptions: modes.availableModes.map((m: Json) => m.description ?? ""),
    };
    values.mode = modes.currentModeId;
  }
  for (const o of options ?? []) {
    if (o.type !== "select") continue;
    const flat = (o.options as Json[]).flatMap((x) => (x.options ? (x.options as Json[]) : [x]));
    properties[String(o.id)] = {
      type: "string", title: String(o.name), sessionMutable: true,
      enum: flat.map((x) => x.value), enumLabels: flat.map((x) => x.name ?? x.value),
    };
    values[String(o.id)] = o.currentValue;
  }
  return { schema: { type: "object" as const, properties }, values };
}
