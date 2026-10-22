// What the daemon answers for the board and Needs you (T63), worked out from a list of tickets the way
// apps/daemon/src/board-summary.ts and GET /api/needs-you do, so a view's test can say what exists and
// leave the paging to this. `answer(url)` returns the JSON body, or undefined for a URL that isn't theirs.
import { digestRow, type TicketEvent, UNASSIGNED, waitsForAssignee } from "@i-inc/core";

// biome-ignore lint/suspicious/noExplicitAny: a test's tickets are partial views.
type T = any;

export interface BoardWorld {
  tickets: T[];
  /** Handbook policy changes waiting for the owner. */
  awaiting?: T[];
  proposals?: T[];
  /** Conversations (only those with needsYou are sent). */
  conversations?: T[];
  /** Each ticket's events, for the report on its Done card. */
  events?: Record<string, TicketEvent[]>;
  /** The page sizes the summary opens with (the daemon's are 40 and 15). */
  limit?: number;
  doneLimit?: number;
}

const COLUMNS = ["todo", "in-progress", "review", "done"];
const num = (id: string) => Number(id) || 0;

function ordered(tickets: T[], column: string): T[] {
  const mine = tickets.filter((t) => t.column === column);
  return column === "done" ? [...mine].sort((a, b) => num(b.id) - num(a.id)) : mine;
}

function reportsOf(world: BoardWorld, tickets: T[]) {
  const out: Record<string, unknown> = {};
  for (const t of tickets) {
    if (t.column !== "done") continue;
    const r = digestRow(t, world.events?.[t.id] ?? []);
    if (r) out[t.id] = r;
  }
  return out;
}

export function answer(world: BoardWorld, url: string): unknown | undefined {
  const u = new URL(url, "http://i.inc");
  const q = u.searchParams;
  switch (u.pathname) {
    case "/api/board/summary": {
      const limit = Number(q.get("limit") ?? world.limit ?? 40);
      const doneLimit = Number(q.get("doneLimit") ?? world.doneLimit ?? 15);
      const columns: Record<string, unknown> = {};
      const shown: T[] = [];
      for (const c of COLUMNS) {
        const all = ordered(world.tickets, c);
        const page = all.slice(0, c === "done" ? doneLimit : limit);
        shown.push(...page);
        columns[c] = { total: all.length, tickets: page };
      }
      return { columns, reports: reportsOf(world, shown) };
    }
    case "/api/board/column": {
      const all = ordered(world.tickets, q.get("column") ?? "");
      const offset = Number(q.get("offset") ?? 0);
      const page = all.slice(offset, offset + Number(q.get("limit") ?? 40));
      return { total: all.length, tickets: page, reports: reportsOf(world, page) };
    }
    case "/api/board/cards": {
      const ids = (q.get("ids") ?? "").split(",").filter(Boolean);
      const tickets = world.tickets.filter((t) => ids.includes(t.id));
      return {
        tickets,
        reports: reportsOf(world, tickets),
        gone: ids.filter((id) => !world.tickets.some((t) => t.id === id)),
      };
    }
    case "/api/board/recent":
      return {
        tickets: world.tickets
          .filter((t) => t.assignee && t.status !== "queued")
          .map((t) => ({ id: t.id, project: t.project, status: t.status, assignee: { id: t.assignee.id } })),
      };
    case "/api/needs-you": {
      const tickets = world.tickets.filter(
        (t) => t.status === "needs-you" || t.status === "ready" || waitsForAssignee(t),
      );
      const policies = world.awaiting ?? [];
      const proposals = world.proposals ?? [];
      const conversations = (world.conversations ?? []).filter((c) => c.needsYou);
      const count =
        tickets.filter((t) => t.status === "needs-you").length +
        tickets.filter(waitsForAssignee).length +
        policies.length +
        proposals.length +
        conversations.length;
      return { count, tickets, policies, proposals, conversations };
    }
    default:
      return undefined;
  }
}

export { UNASSIGNED };

/** The data an `inc-board` holds once loaded, for a test that sets it directly. */
export function boardData(tickets: T[]) {
  const s = answer({ tickets }, "/api/board/summary") as {
    columns: Record<string, unknown>;
    reports: unknown;
  };
  return s;
}
