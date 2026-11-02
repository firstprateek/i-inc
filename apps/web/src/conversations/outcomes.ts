// How a ticket or PR request ended, once its dialog has gone. Leaving the Conversations screen doesn't stop a request
// that is under way, and while the screen is up its dialog stays to say how it ended. With the screen gone, this holds
// the outcome, and the shell shows it on whatever page the owner is on until they dismiss it. It lasts as long as the page.
import type { ShipDone, ShipKind } from "../components/conv-ship.ts";
import { webHref } from "../links.ts";

export interface ShipOutcome {
  id: number;
  conversationId: string;
  /** The conversation's title when the request was made. */
  title: string;
  kind: ShipKind;
  done?: ShipDone;
  /** The daemon's sentence, when it didn't happen. */
  failure?: string;
}

let list: ShipOutcome[] = [];
let lastId = 0;
const listeners = new Set<(added?: ShipOutcome) => void>();

export const shipOutcomes = {
  list: (): ShipOutcome[] => list,
  add(o: Omit<ShipOutcome, "id">): void {
    const added = { ...o, id: ++lastId };
    list = [...list, added];
    for (const fn of listeners) fn(added);
  },
  dismiss(id: number): void {
    list = list.filter((o) => o.id !== id);
    for (const fn of listeners) fn();
  },
  /** `added`: the outcome that has just come in, and undefined when one is dismissed. */
  subscribe(fn: (added?: ShipOutcome) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  clear(): void {
    list = [];
  },
};

/** The outcome as a sentence, and where it leads: to the result, or to the conversation to try again. */
export function outcomeView(o: ShipOutcome): {
  text: string;
  href?: string;
  label: string;
  external: boolean;
} {
  const conversation = {
    href: `#/conversations/${o.conversationId}`,
    label: "Open the conversation",
    external: false,
  };
  const title = `"${o.title}"`;
  if (o.failure !== undefined) {
    const what =
      o.kind === "ticket"
        ? `Couldn't make a ticket from ${title}`
        : o.kind === "pr"
          ? `Couldn't open a pull request for ${title}`
          : `Couldn't take back the work on ${title}`;
    return { text: `${what}: ${o.failure}`, ...conversation };
  }
  const d = o.done;
  if (d?.kind === "ticket") {
    return {
      text: `Ticket #${d.ticketId} is made from ${title}.`,
      href: `#/ticket/${d.ticketId}`,
      label: `Open ticket #${d.ticketId}`,
      external: false,
    };
  }
  if (d?.kind === "pr") {
    const href = webHref(d.pr?.url);
    return {
      text: `Pull request #${d.pr?.number} for ${title} is open as a draft.`,
      ...(href ? { href } : {}),
      label: "Open it on GitHub",
      external: true,
    };
  }
  const open =
    d?.prState === "open"
      ? ` Its pull request is still open on GitHub${d.prProblem ? `: ${d.prProblem}` : "."}`
      : "";
  return { text: `The work on ${title} is yours again.${open}`, ...conversation };
}
