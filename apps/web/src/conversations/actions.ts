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
    label: file.name || "image",
    contentType: file.type || "application/octet-stream",
    data: btoa(bin),
  };
}
