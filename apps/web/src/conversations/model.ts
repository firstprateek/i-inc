// What the Conversations screen reads out of the protocol state: pure functions over the session and chat
// states (and the REST rows), so each rule is easy to test. The i.inc `_meta` extensions (contract C22) are
// read here and nowhere else: locations, the plan, slash commands and brain pages.
import type {
  ActiveTurn,
  ChatState,
  ConfirmationOption,
  FileEdit,
  ResponsePart,
  SessionConfigPropertySchema,
  SessionInputRequest,
  SessionState,
  ToolCallState,
  Turn,
} from "@microsoft/agent-host-protocol";
import { ResponsePartKind, SessionStatus, ToolCallStatus, ToolResultContentType } from "../ahp/wire.ts";
import type { Conversation } from "../api.ts";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

import { visible } from "./visible.ts";

export { visible };

// ───────────────────────────── the list ─────────────────────────────

export type Group = "needs" | "running" | "recent";

/** A row's group: waiting for the owner, working, or neither. */
export function groupOf(c: Pick<Conversation, "needsYou" | "running" | "status">): Group {
  if (c.needsYou || (c.status & 24) === 24) return "needs";
  if (c.running || (c.status & SessionStatus.InProgress) === SessionStatus.InProgress) return "running";
  return "recent";
}

export const GROUP_LABEL: Record<Group, string> = {
  needs: "Needs you",
  running: "Running",
  recent: "Recent",
};

export function groupConversations(list: Conversation[]): { group: Group; items: Conversation[] }[] {
  const by: Record<Group, Conversation[]> = { needs: [], running: [], recent: [] };
  for (const c of [...list].sort((a, b) => b.modifiedAt - a.modifiedAt)) by[groupOf(c)].push(c);
  return (["needs", "running", "recent"] as const)
    .filter((g) => by[g].length)
    .map((g) => ({ group: g, items: by[g] }));
}

export function statusText(c: Pick<Conversation, "needsYou" | "running" | "status" | "archivedAt">): string {
  if (c.archivedAt) return "Archived";
  if (c.needsYou || (c.status & 24) === 24) return "Needs you";
  if (c.running || (c.status & SessionStatus.InProgress) === SessionStatus.InProgress) return "Running";
  if (c.status & SessionStatus.Error) return "Error";
  return "Idle";
}

/** "now", "5m", "3h", "2d", or a date, from a time in ms. */
export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ───────────────────────────── tool calls ─────────────────────────────

export type ToolCategory =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "run"
  | "fetch"
  | "think"
  | "plan"
  | "other";

export const CATEGORY_LABEL: Record<ToolCategory, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  run: "Run",
  fetch: "Fetch",
  think: "Think",
  plan: "Plan",
  other: "Tool",
};

export const PLAN_TOOL = "x-iinc-plan";

/** The tool's kind, from the ACP kind the host puts in `toolName`. */
export function toolCategory(tc: Pick<ToolCallState, "toolName">): ToolCategory {
  switch (tc.toolName) {
    case "read":
    case "edit":
    case "delete":
    case "move":
    case "search":
    case "fetch":
    case "think":
      return tc.toolName;
    case "execute":
      return "run";
    case PLAN_TOOL:
      return "plan";
    default:
      return "other";
  }
}

/** The tool call's own name for what it is doing, as the agent wrote it. */
export function toolTitle(tc: ToolCallState): string {
  if (
    tc.status === ToolCallStatus.Completed &&
    typeof tc.pastTenseMessage === "string" &&
    tc.pastTenseMessage
  )
    return tc.pastTenseMessage;
  const inv = "invocationMessage" in tc ? tc.invocationMessage : undefined;
  const text =
    typeof inv === "string" ? inv : isObj(inv) && typeof inv.markdown === "string" ? inv.markdown : "";
  return visible(text || tc.displayName || tc.toolName);
}

/** The raw input, parsed when it is JSON. A reference to stored input is not read here. */
export function toolInput(tc: ToolCallState): unknown {
  const raw = "toolInput" in tc ? tc.toolInput : undefined;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (tc.status === ToolCallStatus.Streaming && tc.partialInput) return tc.partialInput;
  return undefined;
}

/** The input as text to show: the command for a shell call, otherwise pretty JSON. */
export function toolInputText(tc: ToolCallState): string {
  const input = toolInput(tc);
  if (input === undefined) return "";
  if (typeof input === "string") return visible(input);
  if (toolCategory(tc) === "run" && isObj(input)) {
    const cmd = input.command ?? input.cmd;
    if (typeof cmd === "string") return visible(cmd);
    if (Array.isArray(cmd)) return visible(cmd.map(String).join(" "));
  }
  // JSON.stringify escapes control characters but not bidi or zero-width ones.
  return visible(JSON.stringify(input, null, 2));
}

/** Where a tool call worked, from the agent's locations. */
export function toolLocations(tc: ToolCallState): { path: string; line?: number }[] {
  const raw = tc._meta?.["iinc.locations"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((l): l is { path: string; line?: number } => isObj(l) && typeof l.path === "string");
}

/** A short second part for the one-line card: the file, the command, the pattern. */
export function toolDetail(tc: ToolCallState): string {
  const loc = toolLocations(tc)[0];
  const input = toolInput(tc);
  const cat = toolCategory(tc);
  if (cat === "run") {
    const cmd = toolInputText(tc);
    return cmd.split("\n")[0]?.slice(0, 160) ?? "";
  }
  if (isObj(input)) {
    for (const k of ["path", "file_path", "filePath", "pattern", "query", "url", "command", "description"]) {
      const v = input[k];
      if (typeof v === "string" && v) return visible(v.length > 160 ? `${v.slice(0, 157)}...` : v);
    }
  }
  if (loc) return visible(loc.line ? `${loc.path}:${loc.line}` : loc.path);
  return "";
}

/** The text a finished or running call produced. */
export function toolOutputText(tc: ToolCallState): string {
  const content = "content" in tc ? tc.content : undefined;
  if (!content) return "";
  return visible(
    content
      .map((c) => (c.type === ToolResultContentType.Text ? c.text : ""))
      .filter(Boolean)
      .join("\n"),
  );
}

/** Output that is a stored blob rather than text (images). */
export function toolOutputRefs(tc: ToolCallState): { uri: string; contentType?: string }[] {
  const content = "content" in tc ? tc.content : undefined;
  return (content ?? [])
    .filter((c) => c.type === ToolResultContentType.Resource)
    .map((c) => ({
      uri: (c as { uri: string }).uri,
      contentType: (c as { contentType?: string }).contentType,
    }))
    .map((r) => (r.contentType ? { uri: r.uri, contentType: r.contentType } : { uri: r.uri }));
}

/** The file edits of a call: the diffs it asks to make while pending, or the ones it made. */
export function toolEdits(tc: ToolCallState): FileEdit[] {
  if (tc.status === ToolCallStatus.PendingConfirmation) return tc.edits?.items ?? [];
  const content = "content" in tc ? tc.content : undefined;
  return (content ?? []).filter((c) => c.type === ToolResultContentType.FileEdit) as FileEdit[];
}

export function toolFailed(tc: ToolCallState): boolean {
  return tc.status === ToolCallStatus.Completed && tc.success === false;
}

export function toolError(tc: ToolCallState): string {
  return tc.status === ToolCallStatus.Completed ? visible(tc.error?.message ?? "") : "";
}

export function isPlanCall(tc: Pick<ToolCallState, "toolName">): boolean {
  return tc.toolName === PLAN_TOOL;
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: string;
}

export function planEntries(tc: Pick<ToolCallState, "_meta">): PlanEntry[] | undefined {
  const raw = tc._meta?.["iinc.plan"];
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((e): e is Json => isObj(e) && typeof e.content === "string")
    .map((e) => ({
      content: visible(String(e.content)),
      status: e.status === "completed" || e.status === "in_progress" ? e.status : "pending",
      ...(typeof e.priority === "string" ? { priority: e.priority } : {}),
    }));
}

/** The agent's latest plan across the active turn and the turns before it. */
export function latestPlan(chat: ChatState | undefined): PlanEntry[] | undefined {
  if (!chat) return undefined;
  const turns: { responseParts: ResponsePart[] }[] = [...chat.turns];
  if (chat.activeTurn) turns.push(chat.activeTurn);
  for (let i = turns.length - 1; i >= 0; i--) {
    const parts = turns[i]?.responseParts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p?.kind === ResponsePartKind.ToolCall && isPlanCall(p.toolCall)) {
        const e = planEntries(p.toolCall);
        if (e) return e;
      }
    }
  }
  return undefined;
}

// ───────────────────────────── permission options ─────────────────────────────

export type OptionKind = "once" | "always" | "deny" | "deny-always";

/** What a confirmation option means, from its kind and group (0 once, 1 always). */
export function optionKind(o: ConfirmationOption): OptionKind {
  const approve = o.kind === ("approve" as never);
  if (approve) return o.group === 1 ? "always" : "once";
  return o.group === 1 ? "deny-always" : "deny";
}

/** The agent's options, approve first and the plain allow before the "always" one. */
export function sortedOptions(options: ConfirmationOption[] | undefined): ConfirmationOption[] {
  const rank: Record<OptionKind, number> = { once: 0, always: 1, deny: 2, "deny-always": 3 };
  return [...(options ?? [])].sort((a, b) => rank[optionKind(a)] - rank[optionKind(b)]);
}

// ───────────────────────────── turns ─────────────────────────────

export type AnyTurn = Turn | ActiveTurn;

/** Every tool call of a list of turns. */
export function toolCallsOf(turns: AnyTurn[]): ToolCallState[] {
  const out: ToolCallState[] = [];
  for (const t of turns)
    for (const p of t.responseParts) if (p.kind === ResponsePartKind.ToolCall) out.push(p.toolCall);
  return out;
}

export interface ChangedFile {
  uri: string;
  path: string;
  edit: FileEdit;
  added: number;
  removed: number;
}

/** The path shown for a file URI. */
export function pathOf(uri: string): string {
  const p = uri.replace(/^file:\/\//, "");
  const m = /\/work\/conv-[0-9a-f]+\/(.*)$/.exec(p);
  return visible(m?.[1] ?? p.replace(/^\//, ""));
}

/** The files this conversation has changed, the latest edit of each, newest first. */
export function changedFiles(chat: ChatState | undefined): ChangedFile[] {
  if (!chat) return [];
  const turns: AnyTurn[] = [...chat.turns];
  if (chat.activeTurn) turns.push(chat.activeTurn);
  const by = new Map<string, ChangedFile>();
  for (const tc of toolCallsOf(turns)) {
    if (tc.status !== ToolCallStatus.Completed || tc.success === false) continue;
    for (const edit of toolEdits(tc)) {
      const uri = edit.after?.uri ?? edit.before?.uri;
      if (!uri) continue;
      const prev = by.get(uri);
      // The first "before" and the last "after" make the whole change to the file.
      const merged: FileEdit = {
        ...((prev?.edit.before ?? edit.before) ? { before: prev?.edit.before ?? edit.before } : {}),
        ...(edit.after ? { after: edit.after } : {}),
        diff: edit.diff ?? {},
      } as FileEdit;
      by.delete(uri);
      by.set(uri, {
        uri,
        path: pathOf(uri),
        edit: merged,
        added: (prev?.added ?? 0) + (edit.diff?.added ?? 0),
        removed: (prev?.removed ?? 0) + (edit.diff?.removed ?? 0),
      });
    }
  }
  return [...by.values()].reverse();
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  turns: number;
  model?: string;
}

export function usageTotals(chat: ChatState | undefined): UsageTotals {
  const t: UsageTotals = { input: 0, output: 0, cacheRead: 0, turns: 0 };
  if (!chat) return t;
  const all: AnyTurn[] = [...chat.turns];
  if (chat.activeTurn) all.push(chat.activeTurn);
  for (const turn of all) {
    const u = turn.usage;
    if (!u) continue;
    t.turns++;
    t.input += u.inputTokens ?? 0;
    t.output += u.outputTokens ?? 0;
    t.cacheRead += u.cacheReadTokens ?? 0;
    if (u.model) t.model = u.model;
  }
  return t;
}

export const tokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1000)}k`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : String(n);

/** A turn's usage line, or "" when there is none. */
export function usageLine(
  u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined,
): string {
  if (!u || (u.inputTokens === undefined && u.outputTokens === undefined)) return "";
  const parts = [`${tokens(u.inputTokens ?? 0)} in`, `${tokens(u.outputTokens ?? 0)} out`];
  if (u.cacheReadTokens) parts.push(`${tokens(u.cacheReadTokens)} cached`);
  return parts.join(" · ");
}

export function durationText(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

// ───────────────────────────── what waits for the owner ─────────────────────────────

/** The session's "Needs you" list: pending confirmations and questions across its chats. */
export function inputNeeded(session: SessionState | undefined): SessionInputRequest[] {
  return session?.inputNeeded ?? [];
}

/** The first pending confirmation or question in a chat, for focusing it when the conversation opens. */
export function firstPending(chat: ChatState | undefined): { turnId: string; id: string } | undefined {
  const turn = chat?.activeTurn;
  if (!turn) return undefined;
  for (const p of turn.responseParts) {
    if (p.kind === ResponsePartKind.ToolCall && p.toolCall.status === ToolCallStatus.PendingConfirmation)
      return { turnId: turn.id, id: p.toolCall.toolCallId };
    if (p.kind === ResponsePartKind.InputRequest && p.response === undefined)
      return { turnId: turn.id, id: p.request.id };
  }
  return undefined;
}

// ───────────────────────────── the session's config ─────────────────────────────

export interface Choice {
  value: string;
  label: string;
  description?: string;
}

export interface Picker {
  key: string;
  title: string;
  value: string;
  choices: Choice[];
}

function choicesOf(p: SessionConfigPropertySchema): Choice[] {
  return (p.enum ?? []).map((v, i) => ({
    value: String(v),
    label: p.enumLabels?.[i] ?? String(v),
    ...(p.enumDescriptions?.[i] ? { description: p.enumDescriptions[i] } : {}),
  }));
}

/** The permission-mode picker: the agent's own modes, named as the agent names them. */
export function modePicker(session: SessionState | undefined): Picker | undefined {
  const p = session?.config?.schema.properties.mode;
  if (!p?.enum?.length) return undefined;
  return {
    key: "mode",
    title: p.title || "Mode",
    value: String(session?.config?.values.mode ?? ""),
    choices: choicesOf(p),
  };
}

/** The agent's other settable choices (model, effort...), each as its own picker. */
export function otherPickers(session: SessionState | undefined): Picker[] {
  const props = session?.config?.schema.properties ?? {};
  return Object.entries(props)
    .filter(([k, p]) => k !== "mode" && p.sessionMutable !== false && p.enum?.length && !p.readOnly)
    .map(([key, p]) => ({
      key,
      title: p.title || key,
      value: String(session?.config?.values[key] ?? ""),
      choices: choicesOf(p),
    }));
}

/** The mode the agent calls bypass permissions, if it has one (for the default). */
export function bypassMode(picker: Picker | undefined): Choice | undefined {
  return picker?.choices.find((c) => /bypass|full[- ]access|yolo/i.test(`${c.value} ${c.label}`));
}

export interface Command {
  name: string;
  description?: string;
  hint?: string;
}

/** The agent's slash commands, from the session's `_meta`. */
export function commandsOf(session: SessionState | undefined): Command[] {
  const raw = session?._meta?.["iinc.commands"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Json => isObj(c) && typeof c.name === "string")
    .map((c) => {
      const hint = isObj(c.input) && typeof c.input.hint === "string" ? c.input.hint : undefined;
      return {
        name: String(c.name),
        ...(typeof c.description === "string" ? { description: c.description } : {}),
        ...(hint ? { hint } : {}),
      };
    });
}

/** The commands matching what is typed after a `/` at the cursor, or undefined when none is being typed. */
export function slashQuery(text: string, cursor: number): { word: string; start: number } | undefined {
  const upto = text.slice(0, cursor);
  const m = /(?:^|\s)\/([\w:-]*)$/.exec(upto);
  if (!m) return undefined;
  const word = m[1] ?? "";
  return { word, start: upto.length - word.length - 1 };
}

export function matchCommands(commands: Command[], word: string): Command[] {
  const w = word.toLowerCase();
  return commands
    .filter((c) => c.name.toLowerCase().startsWith(w))
    .concat(
      commands.filter(
        (c) => !c.name.toLowerCase().startsWith(w) && c.name.toLowerCase().includes(w) && w.length > 1,
      ),
    )
    .slice(0, 8);
}

/** Brain pages used for this conversation, when the host says (T57 adds the key; absent: the section hides). */
export function brainPages(
  session: SessionState | undefined,
  chat: ChatState | undefined,
): { title: string; id?: string }[] {
  const raw = chat?._meta?.["iinc.brain"] ?? session?._meta?.["iinc.brain"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) =>
      typeof p === "string"
        ? { title: p }
        : isObj(p) && (typeof p.title === "string" || typeof p.id === "string")
          ? { title: String(p.title ?? p.id), ...(typeof p.id === "string" ? { id: p.id } : {}) }
          : undefined,
    )
    .filter((p): p is { title: string; id?: string } => !!p);
}

/** True while the chat has a turn running. */
export const isRunning = (chat: ChatState | undefined): boolean => !!chat?.activeTurn;
