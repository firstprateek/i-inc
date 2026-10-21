// The actions the Conversations screen sends, built in one place so the shapes the host accepts (contract
// C22) are written once and tested. Each returns a StateAction for `AhpConnection.dispatch`.
import type { ConfirmationOption, StateAction } from "@microsoft/agent-host-protocol";
import {
  ActionType,
  ConfirmationOptionKind,
  type Json,
  PendingMessageKind,
  USER_ORIGIN,
} from "../ahp/wire.ts";

/**
 * What the host accepts (contract C22), so the client can say no before it sends: a message is at most 256,000
 * characters, a frame without an attachment 1 MB, and a whole frame 24 MiB (over that the host closes the
 * connection), so the images in one message are kept to 12 MB in all (base64 adds a third).
 */
export const LIMITS = {
  messageChars: 256_000,
  plainFrameBytes: 900_000,
  attachments: 6,
  attachmentBytes: 12 * 1024 * 1024,
  label: 200,
} as const;

/** Why a message cannot be sent, in words, or null when it can. */
export function checkOutgoing(text: string, files: { size: number }[]): string | null {
  if (text.length > LIMITS.messageChars) {
    const over = (text.length - LIMITS.messageChars).toLocaleString("en-US");
    return `That message is ${over} characters over the limit (${LIMITS.messageChars.toLocaleString("en-US")}). Shorten it or send it in parts.`;
  }
  if (files.length > LIMITS.attachments) return `A message takes at most ${LIMITS.attachments} attachments.`;
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (bytes > LIMITS.attachmentBytes) {
    return `Those images are ${(bytes / 1048576).toFixed(1)} MB together; a message takes at most ${LIMITS.attachmentBytes / 1048576} MB. Send some in another message.`;
  }
  // Text alone can still be large once quotes and control characters are escaped.
  if (!files.length && JSON.stringify(text).length > LIMITS.plainFrameBytes) {
    return "That message is too large to send as it is. Shorten it or send it in parts.";
  }
  return null;
}

const act = (a: Json): StateAction => a as unknown as StateAction;

/** A message as the host takes it: text, the user origin, and attachments. */
export function userMessage(text: string, attachments: Json[] = []): Json {
  return { text, origin: USER_ORIGIN, ...(attachments.length ? { attachments } : {}) };
}

export const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Starts a turn with this message (only while no turn is running; the host refuses otherwise). */
export function turnStarted(
  text: string,
  attachments: Json[] = [],
  turnId = newId(),
  now = new Date(),
): StateAction {
  return act({
    type: ActionType.ChatTurnStarted,
    turnId,
    startedAt: now.toISOString(),
    message: userMessage(text, attachments),
  });
}

/** A message for while a turn runs: `steering` runs next, ahead of the queue; `queued` waits its turn. */
export function pendingMessage(
  kind: "steering" | "queued",
  text: string,
  attachments: Json[] = [],
  id = newId(),
): StateAction {
  return act({
    type: ActionType.ChatPendingMessageSet,
    kind: kind === "steering" ? PendingMessageKind.Steering : PendingMessageKind.Queued,
    id,
    message: userMessage(text, attachments),
  });
}

export function removePending(kind: "steering" | "queued", id: string): StateAction {
  return act({
    type: ActionType.ChatPendingMessageRemoved,
    kind: kind === "steering" ? PendingMessageKind.Steering : PendingMessageKind.Queued,
    id,
  });
}

export function cancelTurn(turnId: string, startedAt: string | undefined, now = Date.now()): StateAction {
  const began = startedAt ? Date.parse(startedAt) : now;
  return act({
    type: ActionType.ChatTurnCancelled,
    turnId,
    duration: Math.max(0, now - (Number.isNaN(began) ? now : began)),
  });
}

/**
 * Answers a tool confirmation with one of the agent's options (or a plain allow or deny when it offered none).
 * The first answer from any device wins; later ones are refused by the host.
 */
export function confirmTool(
  turnId: string,
  toolCallId: string,
  option: ConfirmationOption | { approve: boolean },
): StateAction {
  const chosen = "id" in option ? option : undefined;
  const approved = chosen
    ? chosen.kind === ConfirmationOptionKind.Approve
    : (option as { approve: boolean }).approve;
  return act(
    approved
      ? {
          type: ActionType.ChatToolCallConfirmed,
          turnId,
          toolCallId,
          approved: true,
          confirmed: "user-action",
          ...(chosen ? { selectedOptionId: chosen.id } : {}),
        }
      : {
          type: ActionType.ChatToolCallConfirmed,
          turnId,
          toolCallId,
          approved: false,
          reason: "denied",
          ...(chosen ? { selectedOptionId: chosen.id } : {}),
        },
  );
}

export function setConfig(values: Json): StateAction {
  return act({ type: ActionType.SessionConfigChanged, config: values });
}

export function answerInput(
  requestId: string,
  response: "accept" | "decline" | "cancel",
  answers?: Json,
): StateAction {
  return act({
    type: ActionType.ChatInputCompleted,
    requestId,
    response,
    ...(answers && Object.keys(answers).length ? { answers } : {}),
  });
}

/** An image or file the owner added, as a message attachment (base64 data; the host checks the bytes). */
export async function attachmentOf(file: File): Promise<Json> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    type: "embeddedResource",
    label: (file.name || "image").slice(0, LIMITS.label),
    contentType: file.type || "application/octet-stream",
    data: btoa(bin),
  };
}
