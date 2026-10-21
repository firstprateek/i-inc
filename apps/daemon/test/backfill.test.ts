// T51: the backfill script turns "not filed" log lines into open proposals.
import { describe, expect, it } from "vitest";
import { backfill, parseDroppedFollowUps, RECOVERED_BODY } from "../scripts/backfill-dropped-follow-ups.ts";
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

describe("backfill", () => {
  it("a dry run writes nothing and says what it would store", async () => {
    const app = await testApp();
    const result = backfill(parseDroppedFollowUps(log), null, 5);
    expect(result.stored).toHaveLength(3);
    expect(result.skipped).toHaveLength(1);
    expect(app.deps.proposals.list()).toEqual([]);
  });

  it("stores open proposals with the recovered body, and skips repeats and existing ones", async () => {
    const app = await testApp();
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
    const open = proposals.list("open");
    const first = backfill(parseDroppedFollowUps(log), proposals, 7_000, open);
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
    // Running it again adds nothing.
    const again = backfill(parseDroppedFollowUps(log), proposals, 8_000, proposals.list("open"));
    expect(again.stored).toEqual([]);
    expect(proposals.list("open")).toHaveLength(4);
    // The owner can accept a recovered one.
    const id = stored.find((p) => p.title === "Cover the retry path")?.id;
    const res = await app.call("POST", `/api/proposals/${id}/accept`, {});
    expect(res.status).toBe(201);
    expect(res.body.ticket.createdBy).toBe("ada");
  });
});
