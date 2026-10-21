// The AHP wire vocabulary, as the web app uses it.
//
// `@microsoft/agent-host-protocol` 1.0.0 ships its enums as `declare const enum`, which our TypeScript
// settings (`isolatedModules`) refuse to read as values (TS2748). So, like the daemon (apps/daemon/src/ahp/
// wire.ts), this file holds the string values we use as plain constants typed as the package's enum members:
// every action we build still type-checks against the official types, and the official reducers do the work.
// The package is pinned exactly (1.0.0), so these literals cannot drift under us; bumping it means re-reading
// this file and the daemon's.
import type {
  ActionType as AT,
  ChatAction,
  ChatState,
  ConfirmationOptionKind as COK,
  PendingMessageKind as PMK,
  RootState,
  ResponsePartKind as RPK,
  SessionState,
  SessionInputRequestKind as SIRK,
  SessionStatus as SS,
  StateAction,
  ToolCallStatus as TCS,
  ToolResultContentType as TRCT,
  TurnState as TS,
} from "@microsoft/agent-host-protocol";
import { chatReducer, rootReducer, sessionReducer } from "@microsoft/agent-host-protocol";

export type { ChatAction, ChatState, RootState, SessionState, StateAction };

export type Json = Record<string, unknown>;

export const ROOT = "ahp-root://";
export const PROTOCOL_VERSION = "1.0.0";

export const ActionType = {
  SessionTitleChanged: "session/titleChanged" as AT.SessionTitleChanged,
  SessionConfigChanged: "session/configChanged" as AT.SessionConfigChanged,
  SessionIsReadChanged: "session/isReadChanged" as AT.SessionIsReadChanged,
  ChatTurnStarted: "chat/turnStarted" as AT.ChatTurnStarted,
  ChatToolCallConfirmed: "chat/toolCallConfirmed" as AT.ChatToolCallConfirmed,
  ChatTurnCancelled: "chat/turnCancelled" as AT.ChatTurnCancelled,
  ChatPendingMessageSet: "chat/pendingMessageSet" as AT.ChatPendingMessageSet,
  ChatPendingMessageRemoved: "chat/pendingMessageRemoved" as AT.ChatPendingMessageRemoved,
  ChatIsReadChanged: "chat/isReadChanged" as AT.ChatIsReadChanged,
  ChatInputAnswerChanged: "chat/inputAnswerChanged" as AT.ChatInputAnswerChanged,
  ChatInputCompleted: "chat/inputCompleted" as AT.ChatInputCompleted,
  ChatTurnsLoaded: "chat/turnsLoaded" as AT.ChatTurnsLoaded,
} as const;

/** The status bits (spec: `SessionStatus`). */
export const SessionStatus = {
  Idle: 1 as SS.Idle,
  Error: 2 as SS.Error,
  InProgress: 8 as SS.InProgress,
  InputNeeded: 24 as SS.InputNeeded,
  IsRead: 32 as SS.IsRead,
  IsArchived: 64 as SS.IsArchived,
} as const;
/** The mutually exclusive activity bits (0-4). */
export const STATUS_ACTIVITY_MASK = 31;
export const activity = (status: number): number => status & STATUS_ACTIVITY_MASK;

export const ToolCallStatus = {
  Streaming: "streaming" as TCS.Streaming,
  PendingConfirmation: "pending-confirmation" as TCS.PendingConfirmation,
  Running: "running" as TCS.Running,
  Completed: "completed" as TCS.Completed,
  Cancelled: "cancelled" as TCS.Cancelled,
} as const;

export const ConfirmationOptionKind = {
  Approve: "approve" as COK.Approve,
  Deny: "deny" as COK.Deny,
} as const;

export const ResponsePartKind = {
  Markdown: "markdown" as RPK.Markdown,
  ToolCall: "toolCall" as RPK.ToolCall,
  Reasoning: "reasoning" as RPK.Reasoning,
  SystemNotification: "systemNotification" as RPK.SystemNotification,
  InputRequest: "inputRequest" as RPK.InputRequest,
  Error: "error" as RPK.Error,
} as const;

export const ToolResultContentType = {
  Text: "text" as TRCT.Text,
  EmbeddedResource: "embeddedResource" as TRCT.EmbeddedResource,
  Resource: "resource" as TRCT.Resource,
  FileEdit: "fileEdit" as TRCT.FileEdit,
} as const;

export const TurnState = {
  Complete: "complete" as TS.Complete,
  Cancelled: "cancelled" as TS.Cancelled,
  Error: "error" as TS.Error,
} as const;

export const PendingMessageKind = {
  Steering: "steering" as PMK.Steering,
  Queued: "queued" as PMK.Queued,
} as const;

export const SessionInputRequestKind = {
  ChatInput: "chatInput" as SIRK.ChatInput,
  ToolConfirmation: "toolConfirmation" as SIRK.ToolConfirmation,
} as const;

/** `MessageKind` is a regular enum in the package, but we only need its user value. */
export const USER_ORIGIN = { kind: "user" } as never;

export type ChannelKind = "root" | "session" | "chat";

export const channelKind = (uri: string): ChannelKind | undefined =>
  uri === ROOT
    ? "root"
    : uri.startsWith("ahp-session:/")
      ? "session"
      : uri.startsWith("ahp-chat:/")
        ? "chat"
        : undefined;

/** A channel's state, tagged by kind, so the reducer for it is picked by the type. */
export type ChannelState =
  | { kind: "root"; state: RootState }
  | { kind: "session"; state: SessionState }
  | { kind: "chat"; state: ChatState };

/** Runs the official reducer for a channel. The package's reducers are pure and never throw on bad input. */
export function reduce(c: ChannelState, action: StateAction): ChannelState {
  switch (c.kind) {
    case "root":
      return { kind: "root", state: rootReducer(c.state, action as never) };
    case "session":
      return { kind: "session", state: sessionReducer(c.state, action as never) };
    case "chat":
      return { kind: "chat", state: chatReducer(c.state, action as never) };
  }
}

/** The state of a snapshot, tagged by what its channel is. */
export function tagged(uri: string, state: unknown): ChannelState | undefined {
  const kind = channelKind(uri);
  return kind ? ({ kind, state } as ChannelState) : undefined;
}
