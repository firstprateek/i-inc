// Outbound permissions (spec §7): what a PA may do by itself, what waits for the owner, and what it
// may not even propose. Anything that goes out in the owner's name starts as Ask.
import type { OutboundAction, OutboundSetting, Proposal } from "./model.ts";

/** Never automatic, whatever the settings: these are always proposals, or things the owner does. */
export const neverAutomatic: readonly OutboundAction[] = [
  "book",
  "pay",
  "delete-mail",
  "forward",
  "share-file",
  "account-settings",
];

export type OutboundDecision = "auto" | "ask" | "off";

export function decideOutbound(
  proposal: Proposal,
  settings: Partial<Record<OutboundAction, OutboundSetting>>,
  isContact: (address: string) => boolean,
): OutboundDecision {
  const setting = settings[proposal.action] ?? { mode: "ask" };
  if (setting.mode === "off") return "off";
  if (setting.mode === "ask" || neverAutomatic.includes(proposal.action)) return "ask";

  // A rule. Sending to someone outside the owner's contacts is never automatic.
  const to = proposal.to ?? [];
  if (to.some((address) => !isContact(address))) return "ask";
  if (setting.rule.noInvitees && proposal.invitesOthers) return "ask";
  if (setting.rule.onlyToContacts && to.length === 0) return "ask";
  return "auto";
}
