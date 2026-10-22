// What needs the owner, counted one way for the top-bar badge, the phone tab and the Needs you list.
import {
  api,
  type Conversation,
  type NeedsYouView,
  type PolicyProposal,
  type ProposalView,
  type TicketView,
} from "./api.ts";
import { waitsForAssignee } from "./assign.ts";

/**
 * Tickets asking for the owner, tickets nobody can start until the owner picks someone, handbook policy
 * proposals, and open follow-up proposals. The Needs you list, the top-bar badge and the phone tab all use it.
 */
export function needsYouCount(
  tickets: TicketView[],
  policies: PolicyProposal[] = [],
  proposals: ProposalView[] = [],
  conversations: Pick<Conversation, "needsYou">[] = [],
): number {
  return (
    tickets.filter((t) => t.status === "needs-you").length +
    tickets.filter(waitsForAssignee).length +
    policies.length +
    proposals.length +
    conversations.filter((c) => c.needsYou).length
  );
}

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
