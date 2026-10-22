// The board's pages and what a live update does to them (T63).
import { describe, expect, it } from "vitest";
import type { BoardSummaryView, TicketView } from "../src/api.ts";
import {
  appendPage,
  applyCards,
  type BoardData,
  fromSummary,
  loadedLimits,
} from "../src/components/board-model.ts";

const t = (id: string, column: TicketView["column"]): TicketView =>
  ({ id, title: `T${id}`, column, status: "running", project: "Duet" }) as TicketView;

const board = (cols: Partial<Record<TicketView["column"], { total: number; ids: string[] }>>): BoardData => {
  const columns = {} as BoardSummaryView["columns"];
  for (const c of ["todo", "in-progress", "review", "done"] as const) {
    const x = cols[c] ?? { total: 0, ids: [] };
    columns[c] = { total: x.total, tickets: x.ids.map((id) => t(id, c)) };
  }
  return fromSummary({ columns, reports: {} });
};
const ids = (d: BoardData, c: TicketView["column"]) => d.columns[c].tickets.map((x) => x.id);
const none = { reports: {}, gone: [] as string[] };

describe("applyCards", () => {
  it("replaces a card where it stands when its column did not change", () => {
    const d = board({ "in-progress": { total: 2, ids: ["3", "5"] } });
    const next = applyCards(d, { tickets: [{ ...t("3", "in-progress"), live: "now" }], ...none });
    expect(next?.columns["in-progress"].tickets.map((x) => [x.id, x.live])).toEqual([
      ["3", "now"],
      ["5", undefined],
    ]);
    expect(next?.columns["in-progress"].total).toBe(2);
  });

  it("moves a card to its new column and keeps both totals right", () => {
    const d = board({ "in-progress": { total: 2, ids: ["3", "5"] }, review: { total: 1, ids: ["4"] } });
    const next = applyCards(d, { tickets: [t("3", "review")], ...none });
    expect(ids(next as BoardData, "in-progress")).toEqual(["5"]);
    expect(ids(next as BoardData, "review")).toEqual(["3", "4"]);
    expect(next?.columns["in-progress"].total).toBe(1);
    expect(next?.columns.review.total).toBe(2);
  });

  it("puts a newly filed ticket in order and counts it", () => {
    const d = board({ todo: { total: 2, ids: ["1", "2"] } });
    const next = applyCards(d, { tickets: [t("9", "todo")], ...none });
    expect(ids(next as BoardData, "todo")).toEqual(["1", "2", "9"]);
    expect(next?.columns.todo.total).toBe(3);
  });

  it("puts a finished ticket first in Done (newest first) with its report", () => {
    const d = board({ "in-progress": { total: 1, ids: ["7"] }, done: { total: 2, ids: ["5", "2"] } });
    const report = { id: "7", title: "T7", outcome: "Merged", note: "pushed", at: 1 } as const;
    const next = applyCards(d, { tickets: [t("7", "done")], reports: { "7": report }, gone: [] });
    expect(ids(next as BoardData, "done")).toEqual(["7", "5", "2"]);
    expect(next?.columns.done.total).toBe(3);
    expect(next?.columns["in-progress"].total).toBe(0);
    expect(next?.reports["7"]).toEqual(report);
  });

  it("counts, but does not show, a card that sorts after the cards not loaded yet", () => {
    // 3 of 50 To do cards are loaded; a new ticket 90 belongs after the 47 unloaded ones.
    const d = board({ todo: { total: 50, ids: ["1", "2", "3"] } });
    const next = applyCards(d, { tickets: [t("90", "todo")], ...none });
    expect(ids(next as BoardData, "todo")).toEqual(["1", "2", "3"]);
    expect(next?.columns.todo.total).toBe(51);
  });

  it("asks for a reload for an older ticket it never loaded: it cannot tell where it was", () => {
    const d = board({ todo: { total: 50, ids: ["10", "11", "12"] } });
    expect(applyCards(d, { tickets: [t("4", "review")], ...none })).toBeNull();
  });

  it("removes a ticket that is gone", () => {
    const d = board({ todo: { total: 2, ids: ["1", "2"] } });
    const next = applyCards(d, { tickets: [], reports: {}, gone: ["1"] });
    expect(ids(next as BoardData, "todo")).toEqual(["2"]);
    expect(next?.columns.todo.total).toBe(1);
  });

  it("does not change the data it was given", () => {
    const d = board({ todo: { total: 1, ids: ["1"] } });
    applyCards(d, { tickets: [t("1", "review")], ...none });
    expect(ids(d, "todo")).toEqual(["1"]);
    expect(d.columns.todo.total).toBe(1);
  });
});

describe("paging", () => {
  it("adds a page to a column once, however often it arrives", () => {
    const d = board({ done: { total: 5, ids: ["5", "4"] } });
    const page = { total: 5, tickets: [t("3", "done"), t("4", "done"), t("2", "done")], reports: {} };
    const next = appendPage(d, "done", page);
    expect(ids(next, "done")).toEqual(["5", "4", "3", "2"]);
    expect(ids(appendPage(next, "done", page), "done")).toEqual(["5", "4", "3", "2"]);
  });

  it("reloads as many cards as are on screen, so Show more survives a refresh", () => {
    expect(loadedLimits(null)).toEqual({});
    const many = Array.from({ length: 70 }, (_, i) => String(i + 1));
    const d = board({ todo: { total: 70, ids: many }, done: { total: 80, ids: many.slice(0, 30) } });
    expect(loadedLimits(d)).toEqual({ limit: 70, doneLimit: 30 });
    expect(loadedLimits(board({ done: { total: 3, ids: ["1"] } }))).toEqual({ limit: 40, doneLimit: 15 });
  });
});
