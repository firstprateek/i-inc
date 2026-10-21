// What the first-run checklist (components/getting-started.ts) shares with the shell and the chat: where
// "dismissed" and "has talked" are remembered, and the window events that wake the checklist up.

/** Set to "1" when the owner dismisses the checklist. */
export const DISMISS_KEY = "i-inc-getting-started-dismissed";
/** Set to "1" once the owner has said something in a conversation, so it is not looked for again. */
export const STARTED_KEY = "i-inc-first-conversation";
/** The chat sends this on `window` after the daemon accepted an owner message. */
export const MESSAGE_SENT_EVENT = "i-inc-message-sent";
/** The account menu sends this on `window` to bring a dismissed checklist back. */
export const SHOW_EVENT = "i-inc-show-getting-started";

export function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Brings the checklist back after Dismiss. A checklist on screen wakes up; one not mounted yet reads the flag. */
export function showGettingStarted(): void {
  try {
    localStorage.removeItem(DISMISS_KEY);
  } catch {}
  window.dispatchEvent(new Event(SHOW_EVENT));
}

/** The owner just sent a message: the "Start a conversation" step is done. */
export function messageSent(): void {
  try {
    localStorage.setItem(STARTED_KEY, "1");
  } catch {}
  window.dispatchEvent(new Event(MESSAGE_SENT_EVENT));
}
