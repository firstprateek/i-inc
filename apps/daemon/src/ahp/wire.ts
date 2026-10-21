// The AHP wire vocabulary, as this daemon uses it.
//
// `@microsoft/agent-host-protocol` 1.0.0 ships its enums as `declare const enum`, which our
// TypeScript settings (`isolatedModules`) refuse to read as values (TS2748). The values do exist at
// runtime, but we do not rely on that: this file holds the string values we need as plain constants
// typed as the package's enum members, so every action we build still type-checks against the
// official `ChatAction` / `StateAction` types and the official reducers. The package is pinned
// exactly (1.0.0), so these literals cannot drift under us; bumping it means re-reading this file.
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
  SessionLifecycle as SL,
  SessionStatus as SS,
  StateAction,
  ToolCallConfirmationReason as TCConf,
  ToolCallCancellationReason as TCCR,
  ToolCallStatus as TCS,
  ToolResultContentType as TRCT,
  TurnState as TS,
} from "@microsoft/agent-host-protocol";
import { chatReducer, rootReducer, sessionReducer } from "@microsoft/agent-host-protocol";

export type { ChatAction, ChatState, RootState, SessionState, StateAction };

export type Json = Record<string, unknown>;

export const ROOT = "ahp-root://";
export const PROTOCOL_VERSIONS = ["1.0.0"] as const;

export const ActionType = {
  RootAgentsChanged: "root/agentsChanged" as AT.RootAgentsChanged,
  SessionReady: "session/ready" as AT.SessionReady,
  SessionCreationFailed: "session/creationFailed" as AT.SessionCreationFailed,
  SessionChatAdded: "session/chatAdded" as AT.SessionChatAdded,
  SessionChatRemoved: "session/chatRemoved" as AT.SessionChatRemoved,
  SessionChatUpdated: "session/chatUpdated" as AT.SessionChatUpdated,
  SessionDefaultChatChanged: "session/defaultChatChanged" as AT.SessionDefaultChatChanged,
  SessionTitleChanged: "session/titleChanged" as AT.SessionTitleChanged,
  SessionInputNeededSet: "session/inputNeededSet" as AT.SessionInputNeededSet,
  SessionInputNeededRemoved: "session/inputNeededRemoved" as AT.SessionInputNeededRemoved,
  SessionIsReadChanged: "session/isReadChanged" as AT.SessionIsReadChanged,
  SessionIsArchivedChanged: "session/isArchivedChanged" as AT.SessionIsArchivedChanged,
  SessionConfigChanged: "session/configChanged" as AT.SessionConfigChanged,
  SessionMetaChanged: "session/metaChanged" as AT.SessionMetaChanged,
  SessionActivityChanged: "session/activityChanged" as AT.SessionActivityChanged,
  ChatTurnStarted: "chat/turnStarted" as AT.ChatTurnStarted,
  ChatDelta: "chat/delta" as AT.ChatDelta,
  ChatResponsePart: "chat/responsePart" as AT.ChatResponsePart,
  ChatToolCallStart: "chat/toolCallStart" as AT.ChatToolCallStart,
  ChatToolCallDelta: "chat/toolCallDelta" as AT.ChatToolCallDelta,
  ChatToolCallReady: "chat/toolCallReady" as AT.ChatToolCallReady,
  ChatToolCallConfirmed: "chat/toolCallConfirmed" as AT.ChatToolCallConfirmed,
  ChatToolCallComplete: "chat/toolCallComplete" as AT.ChatToolCallComplete,
  ChatToolCallContentChanged: "chat/toolCallContentChanged" as AT.ChatToolCallContentChanged,
  ChatTurnComplete: "chat/turnComplete" as AT.ChatTurnComplete,
  ChatTurnCancelled: "chat/turnCancelled" as AT.ChatTurnCancelled,
  ChatError: "chat/error" as AT.ChatError,
  ChatActivityChanged: "chat/activityChanged" as AT.ChatActivityChanged,
  ChatUsage: "chat/usage" as AT.ChatUsage,
  ChatReasoning: "chat/reasoning" as AT.ChatReasoning,
  ChatPendingMessageSet: "chat/pendingMessageSet" as AT.ChatPendingMessageSet,
  ChatPendingMessageRemoved: "chat/pendingMessageRemoved" as AT.ChatPendingMessageRemoved,
  ChatQueuedMessagesReordered: "chat/queuedMessagesReordered" as AT.ChatQueuedMessagesReordered,
  ChatDraftChanged: "chat/draftChanged" as AT.ChatDraftChanged,
  ChatIsReadChanged: "chat/isReadChanged" as AT.ChatIsReadChanged,
  ChatIsArchivedChanged: "chat/isArchivedChanged" as AT.ChatIsArchivedChanged,
  ChatInputRequested: "chat/inputRequested" as AT.ChatInputRequested,
  ChatInputAnswerChanged: "chat/inputAnswerChanged" as AT.ChatInputAnswerChanged,
  ChatInputCompleted: "chat/inputCompleted" as AT.ChatInputCompleted,
  ChatTurnsLoaded: "chat/turnsLoaded" as AT.ChatTurnsLoaded,
} as const;

export const SessionLifecycle = {
  Creating: "creating" as SL.Creating,
  Ready: "ready" as SL.Ready,
  Failed: "failed" as SL.Failed,
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

export const ToolCallStatus = {
  Streaming: "streaming" as TCS.Streaming,
  PendingConfirmation: "pending-confirmation" as TCS.PendingConfirmation,
  Running: "running" as TCS.Running,
  Completed: "completed" as TCS.Completed,
  Cancelled: "cancelled" as TCS.Cancelled,
} as const;

export const ToolCallConfirmationReason = {
  NotNeeded: "not-needed" as TCConf.NotNeeded,
  UserAction: "user-action" as TCConf.UserAction,
  Setting: "setting" as TCConf.Setting,
} as const;

export const ToolCallCancellationReason = {
  Denied: "denied" as TCCR.Denied,
  Skipped: "skipped" as TCCR.Skipped,
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

/** `MessageKind` is a regular (non-const) enum in the package, but we only need its user value. */
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

/** The activity bits of a status. */
export const activity = (status: number): number => status & STATUS_ACTIVITY_MASK;
