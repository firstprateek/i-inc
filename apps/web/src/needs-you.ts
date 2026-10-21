// What needs the owner, counted one way for the top-bar badge, the phone tab and the Needs you list.
import { api, type Conversation, type PolicyProposal, type ProposalView, type TicketView } from "./api.ts";
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

/** Conversations with a permission or a question waiting for the owner; none when the host has no conversations. */
export const waitingConversations = (): Promise<Conversation[]> =>
  api
    .conversations()
    .then((all) => all.filter((c) => c.needsYou))
    .catch(() => []);

/** Tells the shell to recount: a conversation started or stopped waiting for the owner. */
export const needsYouSignal = new EventTarget();
export const notifyNeedsYou = (): void => {
  needsYouSignal.dispatchEvent(new Event("change"));
};

/** The current count, from the same data the Needs you tab shows. */
export async function loadNeedsYouCount(): Promise<number> {
  const [tickets, handbook, proposals, conversations] = await Promise.all([
    api.board(),
    api.handbook().catch(() => null),
    api.proposals(),
    waitingConversations(),
  ]);
  return needsYouCount(tickets, handbook?.awaiting ?? [], proposals, conversations);
}
