// Scroll rules for the chat's message list, kept free of the DOM so they are easy to test. The list is
// the only thing that scrolls (never the page): it follows new messages while the reader is at the
// bottom, and holds still, offering a "New messages" button, when they have scrolled up to read.

/** How close to the bottom still counts as "at the bottom", in px. */
export const NEAR_BOTTOM_PX = 80;

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** True when the reader is within `threshold` px of the newest message. */
export function isNearBottom(el: ScrollMetrics, threshold = NEAR_BOTTOM_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

interface Keyed {
  from: string;
  at: number;
  text?: string | undefined;
  kind?: string | undefined;
  ticketId?: string | undefined;
}

function key(e: Keyed): string {
  return `${e.from}|${e.at}|${e.kind ?? ""}|${e.ticketId ?? ""}|${e.text ?? ""}`;
}

/** What `next` holds from someone else that `prev` did not, oldest first: replies, draft tickets, errands. */
export function newFromOthers<T extends Keyed>(prev: readonly Keyed[], next: readonly T[]): T[] {
  const seen = new Set(prev.map(key));
  return next.filter((e) => e.from !== "owner" && !seen.has(key(e)));
}

/**
 * True when `next` holds something from someone else that `prev` did not: a reply, a draft ticket,
 * an errand. The owner's own messages never count (sending always scrolls), and a re-fetch that
 * brings nothing new, or a status change on an existing message, does not either.
 */
export function hasNewFromOthers(prev: readonly Keyed[], next: readonly Keyed[]): boolean {
  return newFromOthers(prev, next).length > 0;
}
