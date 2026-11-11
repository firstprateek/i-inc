// What needs the owner, counted one way for the top-bar badge, the phone tab and the Needs you list.
import { api, type Conversation, type NeedsYouView } from "./api.ts";

/**
 * Decisions only: tickets asking for the owner, finished reports, conversations waiting, and handbook policy
 * proposals; not follow-up proposals or unassigned tickets (`@i-inc/core`'s rule, which the daemon counts with
 * too). The Needs you page, the top-bar badge and the phone tab all show it.
 */
export { needsYouCount } from "@i-inc/core";

/** Tells the shell to recount: a conversation started or stopped waiting for the owner. */
export const needsYouSignal = new EventTarget();
export const notifyNeedsYou = (): void => {
  needsYouSignal.dispatchEvent(new Event("change"));
};

/** What waits for the owner, as the daemon sees it (`GET /api/needs-you`). */
export type NeedsYouData = Omit<NeedsYouView, "conversations"> & { conversations: Conversation[] };

let shared: Promise<NeedsYouData> | null = null;

/**
 * Everything waiting for the owner, in one request. The shell's badge and the Needs you page ask on the same
 * refresh, in the same turn; they share one request instead of making one each (it was the board, the
 * handbook, the proposals and every conversation, twice). A caller in a later turn gets a fresh answer.
 */
export function loadNeedsYou(): Promise<NeedsYouData> {
  if (!shared) {
    shared = api.needsYou().then((r) => r as NeedsYouData);
    queueMicrotask(() => {
      shared = null;
    });
  }
  return shared;
}

/** The count the badge and the phone tab show. */
export async function loadNeedsYouCount(): Promise<number> {
  return (await loadNeedsYou()).count;
}
