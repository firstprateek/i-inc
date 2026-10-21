// T51: the backfill script turns "not filed" log lines into open proposals.
import { describe, expect, it } from "vitest";
import {
  backfill,
  parseDroppedFollowUps,
  RECOVERED_BODY,
  readExisting,
} from "../scripts/backfill-dropped-follow-ups.ts";
import { Proposals } from "../src/proposals.ts";
import { testApp } from "./setup.ts";

const log = [
  "2026-10-19T08:00:00.000Z listening on 127.0.0.1:7420",
  '2026-10-19T08:12:01.000Z follow-up "Cover the retry path" from ada not filed: i-inc\'s budget for today is used',
  "2026-10-19T08:12:02.500Z ticket 41 filed by ada as a follow-up of 40: Something else",
  '2026-10-19T09:30:00.000Z follow-up "Rename "foo" to bar" from kit not filed: Duet\'s budget for today is used',
  'follow-up "No timestamp here" from grace not filed: website\'s budget for today is used',
  '2026-10-19T10:00:00.000Z follow-up "cover the retry path." from ada not filed: i-inc\'s budget for today is used',
  '2026-10-19T10:00:01.000Z follow-up "Almost" from ada not filed: i-inc budget',
].join("\n");

describe("parseDroppedFollowUps", () => {
  it("reads the title, proposer, project and time, and ignores other lines", () => {
    const found = parseDroppedFollowUps(log);
    expect(found.map((f) => [f.project, f.proposedBy, f.title])).toEqual([
      ["i-inc", "ada", "Cover the retry path"],
      ["Duet", "kit", 'Rename "foo" to bar'],
      ["website", "grace", "No timestamp here"],
      ["i-inc", "ada", "cover the retry path."],
    ]);
    expect(found[0]).toMatchObject({ at: Date.parse("2026-10-19T08:12:01.000Z"), line: 2 });
    expect(found[2]?.at).toBeNull();
  });

  it("copes with CRLF and an empty log", () => {
    expect(parseDroppedFollowUps(log.replaceAll("\n", "\r\n"))).toHaveLength(4);
    expect(parseDroppedFollowUps("")).toEqual([]);
  });
});

/** The demo company, plus the i-inc project the log's first lines are about. */
async function appWithIInc() {
  const app = await testApp();
  app.deps.registry.addProject({ id: "i-inc", repo: "demo/i-inc", checks: [] });
  return app;
}

describe("backfill", () => {
  it("a dry run writes nothing and says what it would store", async () => {
    const app = await testApp();
    const result = backfill(parseDroppedFollowUps(log), null, 5);
    expect(result.stored).toHaveLength(3);
    expect(result.skipped).toHaveLength(1);
    expect(app.deps.proposals.list()).toEqual([]);
  });

  it("stores open proposals with the recovered body, and skips repeats and existing ones", async () => {
    const app = await appWithIInc();
    const proposals = new Proposals(app.deps.db);
    proposals.add(
      {
        project: "Duet",
        title: "rename   foo",
        body: "",
        proposedBy: "kit",
        sourceTicket: "1",
        type: "fix",
        effort: "low",
        doneWhen: [],
      },
      1,
    );
    const first = backfill(parseDroppedFollowUps(log), proposals, 7_000, readExisting(app.deps.db));
    expect(first.stored.map((f) => f.title)).toEqual([
      "Cover the retry path",
      'Rename "foo" to bar',
      "No timestamp here",
    ]);
    const stored = proposals.list("open").filter((p) => p.body === RECOVERED_BODY);
    expect(stored).toHaveLength(3);
    expect(stored.every((p) => p.status === "open" && p.sourceTicket === "")).toBe(true);
    expect(stored.find((p) => p.title === "No timestamp here")?.createdAt).toBe(7_000);
    expect(stored.find((p) => p.title === "Cover the retry path")?.createdAt).toBe(
      Date.parse("2026-10-19T08:12:01.000Z"),
    );
    const again = backfill(parseDroppedFollowUps(log), proposals, 8_000, readExisting(app.deps.db));
    expect(again.stored).toEqual([]);
    expect(proposals.list()).toHaveLength(4);
  });

  it("never recreates what the owner already accepted or declined", async () => {
    const app = await appWithIInc();
    const proposals = new Proposals(app.deps.db);
    const found = parseDroppedFollowUps(log);
    backfill(found, proposals, 1, readExisting(app.deps.db));
    const byTitle = (t: string) => proposals.list().find((p) => p.title === t);
    const accepted = byTitle("Cover the retry path");
    const res = await app.call("POST", `/api/proposals/${accepted?.id}/accept`, {});
    expect(res.status).toBe(201);
    await app.call("POST", `/api/proposals/${byTitle('Rename "foo" to bar')?.id}/decline`, {});
    const tickets = app.deps.tickets.all().length;
    const again = backfill(found, proposals, 2, readExisting(app.deps.db));
    expect(again.stored).toEqual([]);
    expect(proposals.list("open").map((p) => p.title)).toEqual(["No timestamp here"]);
    expect(proposals.list()).toHaveLength(3);
    expect(app.deps.tickets.all().length).toBe(tickets);
  });

  it("skips a title a ticket already has, even with different case or quotes", async () => {
    const app = await appWithIInc();
    app.deps.tickets.create(
      {
        title: "\u201cCOVER the retry path\u201d.",
        project: "i-inc",
        type: "fix",
        effort: "low",
        doneWhen: [],
      },
      1,
    );
    const result = backfill(parseDroppedFollowUps(log), null, 5, readExisting(app.deps.db));
    expect(result.skipped.map((f) => f.title)).toContain("Cover the retry path");
  });

  it("warns about an unknown project or employee and skips it unless told otherwise", async () => {
    const app = await testApp();
    const found = parseDroppedFollowUps(log);
    const known = readExisting(app.deps.db);
    // The demo has Duet and website, and ada, kit and grace; "i-inc" isn't one of its projects.
    const result = backfill(found, null, 5, known);
    expect(result.unknown.map((f) => f.project)).toEqual(["i-inc", "i-inc"]);
    expect(result.stored.map((f) => f.project).sort()).toEqual(["Duet", "website"]);
    const all = backfill(found, null, 5, { ...known, includeUnknown: true });
    expect(all.unknown).toEqual([]);
    expect(all.stored).toHaveLength(3);
    expect(all.skipped).toHaveLength(1);
    const ghost = parseDroppedFollowUps(
      '2026-10-19T08:00:00.000Z follow-up "X" from nobody not filed: Duet\'s budget for today is used',
    );
    expect(backfill(ghost, null, 5, known).unknown).toHaveLength(1);
  });
});
