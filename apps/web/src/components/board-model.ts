// The board's data, in pages (T63): each column holds the cards loaded so far and its total, and a live event
// for a ticket updates that one card in place. Pure, so the rules are tested without a page.
import type { DigestRow } from "@i-inc/core";
import type { BoardSummaryView, TicketView } from "../api.ts";

export type Column = TicketView["column"];
export const COLUMN_IDS: readonly Column[] = ["todo", "in-progress", "review", "done"];

/** A board ticket. `createdBy` is the agent that filed it, when the daemon says so (owner tickets have none). */
export type BoardTicket = TicketView & { createdBy?: NonNullable<TicketView["assignee"]> | null };

export interface BoardColumn {
  /** Every ticket in the column, loaded or not. */
  total: number;
  tickets: BoardTicket[];
}

export interface BoardData {
  columns: Record<Column, BoardColumn>;
  /** How each loaded Done card ended, by ticket id. */
  reports: Record<string, DigestRow>;
}

/** Cards a "Show more" adds. */
export const PAGE = 25;

const num = (id: string): number => {
  const n = Number(id);
  return Number.isFinite(n) ? n : 0;
};

/** Done shows the newest first; the others as they were filed. */
const before = (column: Column, a: string, b: string): boolean =>
  column === "done" ? num(a) > num(b) : num(a) < num(b);

export function fromSummary(s: BoardSummaryView): BoardData {
  const columns = {} as Record<Column, BoardColumn>;
  for (const c of COLUMN_IDS) columns[c] = { total: s.columns[c].total, tickets: s.columns[c].tickets };
  return { columns, reports: { ...s.reports } };
}

/** Every loaded ticket, flat. */
export const allTickets = (d: BoardData): BoardTicket[] => COLUMN_IDS.flatMap((c) => d.columns[c].tickets);

/** The limits that make a reload as long as what is on screen, so "Show more" survives a refresh. */
export function loadedLimits(d: BoardData | null): { limit?: number; doneLimit?: number } {
  if (!d) return {};
  const active = Math.max(
    d.columns.todo.tickets.length,
    d.columns["in-progress"].tickets.length,
    d.columns.review.tickets.length,
  );
  return {
    limit: Math.min(100, Math.max(40, active)),
    doneLimit: Math.min(100, Math.max(15, d.columns.done.tickets.length)),
  };
}

/** Adds a page loaded with "Show more" to its column (cards already there are left alone). */
export function appendPage(
  d: BoardData,
  column: Column,
  page: { total: number; tickets: BoardTicket[]; reports: Record<string, DigestRow> },
): BoardData {
  const have = new Set(d.columns[column].tickets.map((t) => t.id));
  const more = page.tickets.filter((t) => !have.has(t.id));
  return {
    columns: {
      ...d.columns,
      [column]: { total: page.total, tickets: [...d.columns[column].tickets, ...more] },
    },
    reports: { ...d.reports, ...page.reports },
  };
}

/**
 * Applies the cards a live event named. Returns null when the board can't tell where they belong (a ticket
 * it never loaded that isn't new): the caller reloads then.
 */
export function applyCards(
  d: BoardData,
  cards: { tickets: BoardTicket[]; reports: Record<string, DigestRow>; gone: string[] },
): BoardData | null {
  const columns = {} as Record<Column, BoardColumn>;
  for (const c of COLUMN_IDS) columns[c] = { total: d.columns[c].total, tickets: [...d.columns[c].tickets] };
  const reports = { ...d.reports };
  const maxId = Math.max(0, ...allTickets(d).map((t) => num(t.id)));

  const remove = (id: string): Column | null => {
    for (const c of COLUMN_IDS) {
      const at = columns[c].tickets.findIndex((t) => t.id === id);
      if (at >= 0) {
        columns[c].tickets.splice(at, 1);
        return c;
      }
    }
    return null;
  };

  for (const id of cards.gone) {
    const was = remove(id);
    if (was) columns[was].total = Math.max(0, columns[was].total - 1);
    delete reports[id];
  }

  for (const card of cards.tickets) {
    const col = columns[card.column];
    const at = col.tickets.findIndex((t) => t.id === card.id);
    if (at >= 0) {
      col.tickets[at] = card; // same column: replaced where it stands
    } else {
      const was = remove(card.id);
      if (was === null && num(card.id) <= maxId) {
        // Not on screen and not new: it is somewhere in a column that isn't fully loaded.
        return null;
      }
      if (was) columns[was].total = Math.max(0, columns[was].total - 1);
      col.total += 1;
      // Where it sorts among what is loaded; past the loaded end of a partly loaded column it is not shown.
      let i = col.tickets.findIndex((t) => before(card.column, card.id, t.id));
      if (i < 0) {
        if (col.tickets.length + 1 < col.total) continue; // more cards are unloaded after these
        i = col.tickets.length;
      }
      col.tickets.splice(i, 0, card);
    }
  }

  for (const card of cards.tickets) {
    if (cards.reports[card.id]) reports[card.id] = cards.reports[card.id] as DigestRow;
    else delete reports[card.id];
  }
  return { columns, reports };
}
