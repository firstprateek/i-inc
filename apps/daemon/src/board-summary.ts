// The board in pages (T63). A board with a thousand tickets is 634 KB; the page opens on a summary instead:
// the tickets that are in play, the newest finished ones, each column's total, and the report of every
// finished card shown (so the web app makes no request per card). A column's rest is fetched on demand, and a
// live event for one ticket is answered with that ticket's card alone.
import { type DigestRow, digestRow, type Id, type TicketEvent } from "@i-inc/core";
import type { BoardColumnView, BoardSummaryView, Column, TicketView } from "./view-types.ts";

export const COLUMNS: readonly Column[] = ["todo", "in-progress", "review", "done"];

/** Cards a column opens with, and the most one request returns. */
export const COLUMN_LIMIT = 40;
export const DONE_LIMIT = 15;
export const MAX_PAGE = 100;

/** A ticket's card, and the events its report is read from. */
export interface BoardItem {
  view: TicketView;
  events: readonly TicketEvent[];
}

const num = (id: string): number => {
  const n = Number(id);
  return Number.isFinite(n) ? n : 0;
};

/** The order a column is shown in: Done newest first, the rest as they were filed. */
function ordered(items: BoardItem[], column: Column): BoardItem[] {
  const mine = items.filter((i) => i.view.column === column);
  return column === "done" ? mine.sort((a, b) => num(b.view.id) - num(a.view.id)) : mine;
}

/** The reports of the Done cards among `items`. */
function reportsOf(items: BoardItem[]): Record<Id, DigestRow> {
  const out: Record<Id, DigestRow> = {};
  for (const i of items) {
    if (i.view.column !== "done") continue;
    const row = digestRow(i.view, i.events);
    if (row) out[i.view.id] = row;
  }
  return out;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.floor(n)));

export function boardSummary(
  items: BoardItem[],
  limits: { limit?: number; doneLimit?: number } = {},
): BoardSummaryView {
  const limit = clamp(limits.limit ?? COLUMN_LIMIT, 1, MAX_PAGE);
  const doneLimit = clamp(limits.doneLimit ?? DONE_LIMIT, 1, MAX_PAGE);
  const columns = {} as Record<Column, BoardColumnView>;
  const shown: BoardItem[] = [];
  for (const c of COLUMNS) {
    const all = ordered(items, c);
    const page = all.slice(0, c === "done" ? doneLimit : limit);
    shown.push(...page);
    columns[c] = { total: all.length, tickets: page.map((i) => i.view) };
  }
  return { columns, reports: reportsOf(shown) };
}

/** One more page of a column. */
export function boardColumn(
  items: BoardItem[],
  column: Column,
  offset: number,
  limit: number,
): BoardColumnView & { reports: Record<Id, DigestRow> } {
  const all = ordered(items, column);
  const page = all.slice(
    clamp(offset, 0, all.length),
    clamp(offset, 0, all.length) + clamp(limit, 1, MAX_PAGE),
  );
  return { total: all.length, tickets: page.map((i) => i.view), reports: reportsOf(page) };
}

/** The reports of the Done cards among these (for the cards of a live update). */
export const reportsFor = reportsOf;

/** Who last worked on a project, as the new-ticket form ranks the people to offer: one entry per project and employee. */
export interface RecentWork {
  id: Id;
  project: string;
  status: string;
  assignee: { id: Id };
}

/** The newest started ticket of each employee in each project: enough to say who usually does what. */
export function recentWork(items: BoardItem[]): RecentWork[] {
  const best = new Map<string, RecentWork>();
  for (const { view } of items) {
    if (!view.assignee || view.status === "queued") continue;
    const key = `${view.project}\u0000${view.assignee.id}`;
    const have = best.get(key);
    if (!have || num(view.id) > num(have.id)) {
      best.set(key, {
        id: view.id,
        project: view.project,
        status: view.status,
        assignee: { id: view.assignee.id },
      });
    }
  }
  return [...best.values()];
}
