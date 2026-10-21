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
  /** A text file attached to a message (it goes to the agent as an embedded resource). */
  textFileBytes: 256 * 1024,
} as const;

const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env|log|csv|tsv|xml|html?|css|scss|less|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|[ch](pp)?|cs|php|sh|bash|zsh|sql|diff|patch|graphql|vue|svelte|lock)$|(^|\/)(dockerfile|makefile|readme|license|\.gitignore)$/i;

/** The text type to send a file as, or null when it is not a text file we take. Images are not text files. */
export function textMimeOf(name: string, type: string): string | null {
  if (type.startsWith("image/")) return null;
  if (type.startsWith("text/")) return type;
  if (/^application\/(json|xml|x-yaml|yaml|toml|x-sh|javascript|x-javascript|typescript)$/.test(type))
    return type;
  return TEXT_EXT.test(name) ? "text/plain" : null;
}

/** A file with a NUL byte near its start is not text. */
export const looksBinary = (head: Uint8Array): boolean => head.includes(0);

export type FileVerdict = { ok: true; mime: string } | { ok: false; why: string };

/** Whether a pasted or dropped file that is not an image can go to the agent, and why not when it cannot. */
export async function judgeTextFile(file: File): Promise<FileVerdict> {
  const name = file.name || "that file";
  const mime = textMimeOf(file.name, file.type);
  if (!mime) {
    return {
      ok: false,
      why: `${name} can't be attached: only images and text files can (it isn't one of those).`,
    };
  }
  if (file.size > LIMITS.textFileBytes) {
    return {
      ok: false,
      why: `${name} is ${(file.size / 1024).toFixed(0)} KB; a text file can be at most ${LIMITS.textFileBytes / 1024} KB. Paste the part that matters instead.`,
    };
  }
  const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  if (looksBinary(head))
    return {
      ok: false,
      why: `${name} looks like a binary file; only images and text files can be attached.`,
    };
  return { ok: true, mime };
}

/** Why a message cannot be sent, in words, or null when it can. */
export function checkOutgoing(
  text: string,
  files: { size: number; type?: string; name?: string }[],
): string | null {
  if (text.length > LIMITS.messageChars) {
    const over = (text.length - LIMITS.messageChars).toLocaleString("en-US");
    return `That message is ${over} characters over the limit (${LIMITS.messageChars.toLocaleString("en-US")}). Shorten it or send it in parts.`;
  }
  if (files.length > LIMITS.attachments) return `A message takes at most ${LIMITS.attachments} attachments.`;
  for (const f of files) {
    if (f.type !== undefined && !f.type.startsWith("image/") && f.size > LIMITS.textFileBytes) {
      return `${f.name || "A file"} is over ${LIMITS.textFileBytes / 1024} KB: a text file can be at most that.`;
    }
  }
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
    contentType: file.type.startsWith("image/")
      ? file.type
      : (textMimeOf(file.name, file.type) ?? (file.type || "application/octet-stream")),
    data: btoa(bin),
  };
}

/** The daemon's words for a refused conversation, as a sentence for the owner. Anything unknown is said plainly. */
export function friendlyError(message: string): string {
  const m = message.trim();
  if (/^no employee\b/i.test(m)) return "That employee isn't available.";
  if (/^no project\b/i.test(m)) return "That project isn't available.";
  const works = /^(.+) doesn't work on (.+)$/.exec(m);
  if (works) return `${works[1]} doesn't work on ${works[2]}. Pick another project or another employee.`;
  if (/^no engine\b/i.test(m)) return "That employee has no engine set up.";
  if (/free slot|\d+ of \d+ conversations/i.test(m))
    return "The team already has all its conversations running. Stop or archive one, then try again.";
  if (/github app|couldn't open|could not open|502/i.test(m)) return `Couldn't start the conversation: ${m}`;
  if (/Can't reach i\.inc/i.test(m)) return "Can't reach i.inc. Check the connection and try again.";
  return m ? `Couldn't start the conversation: ${m}` : "Couldn't start the conversation.";
}
