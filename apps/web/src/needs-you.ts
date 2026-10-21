// What needs the owner, counted one way for the top-bar badge, the phone tab and the Needs you list.
import { api, type PolicyProposal, type ProposalView, type TicketView } from "./api.ts";
import { waitsForAssignee } from "./assign.ts";

/**
 * Tickets asking for the owner, tickets nobody can start until the owner picks someone, handbook policy
 * proposals, and open follow-up proposals. The Needs you list, the top-bar badge and the phone tab all use it.
 */
export function needsYouCount(
  tickets: TicketView[],
  policies: PolicyProposal[] = [],
  proposals: ProposalView[] = [],
): number {
  return (
    tickets.filter((t) => t.status === "needs-you").length +
    tickets.filter(waitsForAssignee).length +
    policies.length +
    proposals.length
  );
}

/** The current count, from the same data the Needs you tab shows. */
export async function loadNeedsYouCount(): Promise<number> {
  const [tickets, handbook, proposals] = await Promise.all([
    api.board(),
    api.handbook().catch(() => null),
    api.proposals(),
  ]);
  return needsYouCount(tickets, handbook?.awaiting ?? [], proposals);
}
