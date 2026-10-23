// Every ticket's done-when is checked before it closes (T72). A code ticket with no prove stage (low effort, or
// nobody to verify) gets a light, read-only check by a session that is never the builder's own: all met goes on,
// something not met goes back to the builder once, and a second miss or a "can't tell" goes to the owner with the
// result for each item. A ticket proved by the prove stage is not checked twice; one with no done-when says so.
import { describe, expect, it } from "vitest";
import {
  answer,
  assembleReport,
  fold,
  readDoneWhenCheck,
  reportMarkdown,
  runTicket,
  type TicketEvent,
} from "../src/index.ts";
import { fakePorts, json } from "../src/testing/index.ts";
import { ada, engines, grace, ports, refundsTicket } from "./fixtures.ts";

const direct = <T extends { company: { policy: { mode: string } } }>(p: T) => {
  p.company.policy = { ...p.company.policy, mode: "direct" };
  return p;
};

const low = (over = {}) => refundsTicket({ effort: "low", ...over });
const [first, second] = refundsTicket().doneWhen as [string, string];

type V = "met" | "not met" | "can't tell";
const reply = (...v: V[]) =>
  json({
    items: [first, second].map((doneWhen, n) => ({ doneWhen, verdict: v[n], evidence: `evidence ${n + 1}` })),
  });
const say = (output: string) => ({ kind: "done" as const, output });

const checks = (p: { agent: { calls: { stage: string }[] } }) =>
  p.agent.calls.filter((c) => c.stage === "done-when");
const verdicts = async (p: { store: { read: (id: string) => Promise<TicketEvent[]> } }) =>
  (await p.store.read("42")).filter((e) => e.type === "done-when-verdict");

describe("a code ticket without a prove stage gets a done-when check", () => {
  it("low effort, all items met: a session that is not the builder's checks, then the ticket goes on", async () => {
    const p = direct(ports());
    const result = await runTicket(p, low());
    expect(result).toEqual({ status: "done", outcome: "merged" });
    const s = fold(await p.store.read("42"));
    expect(s.finished).toContain("done-when");
    expect(s.finished).not.toContain("prove");
    const calls = checks(p) as ReturnType<typeof p.agent.callsFor>;
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.employee.id).not.toBe("ada");
    expect(call?.employee.id).toBe("quinn"); // the verifier, since the team has one
    // a short, fresh, light session: the ticket and the task only, at low effort
    expect(call?.effort).toBe("low");
    expect(call?.brief).not.toContain("Assignee:");
    expect(call?.brief).toContain("Done when:");
    expect(call?.brief).toContain(first);
    expect(call?.brief).toContain("git diff origin/main");
    expect(call?.brief).toContain("change no files");
    expect(call?.brief).toContain("passed on the builder's last run");
    expect(s.doneCheck?.items.map((i) => i.verdict)).toEqual(["met", "met"]);
    expect(s.doneCheck?.by).toBe("quinn");
    expect((await p.store.read("42")).filter((e) => e.type === "done-when-checked")).toMatchObject([
      { stage: "done-when", met: true, missing: [] },
    ]);
  });

  it("an unmet item goes back to the builder once with the item, then it is checked again and met", async () => {
    const p = direct(ports());
    p.agent.on(
      { stage: "done-when", duty: "verify" },
      say(reply("met", "not met")),
      say(reply("met", "met")),
    );
    expect(await runTicket(p, low())).toEqual({ status: "done", outcome: "merged" });
    const fix = p.agent.callsFor("ada", "done-when");
    expect(fix).toHaveLength(1);
    expect(fix[0]?.duty).toBe("build");
    expect(fix[0]?.brief).toContain(`- ${second}: not met, evidence 2`);
    expect(fix[0]?.brief).not.toContain(`- ${first}:`);
    expect(checks(p)).toHaveLength(3); // check, the builder's fix, check again
    const s = fold(await p.store.read("42"));
    expect(s.doneCheck?.items.map((i) => i.verdict)).toEqual(["met", "met"]);
    const log = await verdicts(p);
    expect(log.map((e) => (e.type === "done-when-verdict" ? e.retry : null))).toEqual([true, false]);
  });

  it("still unmet after the builder's fix goes to needs-you with the result for each item, never done", async () => {
    const p = direct(ports());
    p.agent.on(
      { stage: "done-when", duty: "verify" },
      say(reply("met", "not met")),
      say(reply("met", "not met")),
    );
    const result = await runTicket(p, low());
    expect(result.status).toBe("needs-you");
    if (result.status !== "needs-you" || result.ask.kind !== "stuck")
      throw new Error("expected a stuck card");
    expect(result.ask.reason).toContain("after the builder's fix");
    expect(result.ask.reason).toContain(`${first} (met: evidence 1)`);
    expect(result.ask.reason).toContain(`${second} (not met: evidence 2)`);
    expect(p.agent.callsFor("ada", "done-when")).toHaveLength(1); // one retry, no more
    const s = fold(await p.store.read("42"));
    expect(s.status).toBe("needs-you");
    expect(s.finished).not.toContain("done-when");
    expect(s.finished).not.toContain("gates");
    expect(p.harness.gateRuns).toBe(0); // nothing was pushed
    // "Keep going" starts the stage again: checked, and met this time
    await answer(p, "42", "continue");
    expect(await runTicket(p, low())).toEqual({ status: "done", outcome: "merged" });
  });

  it("can't tell goes to needs-you at once, with no retry for the builder", async () => {
    const p = direct(ports());
    p.agent.on({ stage: "done-when", duty: "verify" }, say(reply("met", "can't tell")));
    const result = await runTicket(p, low());
    expect(result.status).toBe("needs-you");
    if (result.status !== "needs-you" || result.ask.kind !== "stuck")
      throw new Error("expected a stuck card");
    expect(result.ask.reason).toContain(`${second} (can't tell: evidence 2)`);
    expect(result.ask.reason).not.toContain("after the builder's fix");
    expect(p.agent.callsFor("ada", "done-when")).toHaveLength(0);
    expect(fold(await p.store.read("42")).doneCheck?.items.map((i) => i.verdict)).toEqual([
      "met",
      "cant-tell",
    ]);
  });

  it("a reply that cannot be read, or says met without evidence, is can't tell, not done", async () => {
    const p = direct(ports());
    p.agent.on({ stage: "done-when" }, say("looks fine to me"));
    const result = await runTicket(p, low());
    expect(result.status).toBe("needs-you");
    expect(fold(await p.store.read("42")).doneCheck?.items.map((i) => i.verdict)).toEqual([
      "cant-tell",
      "cant-tell",
    ]);
    expect(
      readDoneWhenCheck({ items: [{ doneWhen: first, verdict: "met", evidence: " " }] }, [first]),
    ).toEqual([
      { doneWhen: first, verdict: "cant-tell", evidence: "the checker said met but gave no evidence" },
    ]);
  });

  it("with no verifier available the check still runs: another reviewer first, then the builder's seat on another engine", async () => {
    const withReviewer = direct(fakePorts([ada, grace], engines));
    await runTicket(withReviewer, low());
    const call = checks(withReviewer)[0] as ReturnType<typeof withReviewer.agent.callsFor>[number];
    expect(call.employee.id).toBe("grace"); // a different employee, who holds the review duty

    const alone = direct(fakePorts([ada], engines));
    expect(await runTicket(alone, low())).toEqual({ status: "done", outcome: "merged" });
    const own = checks(alone) as ReturnType<typeof alone.agent.callsFor>;
    expect(own).toHaveLength(1);
    expect(own[0]?.employee.id).toBe("ada"); // the builder's seat ...
    expect(own[0]?.engine.id).not.toBe("opus"); // ... on a different engine ...
    expect(own[0]?.brief).not.toContain("Assignee:"); // ... with a clean context
    expect(own[0]?.effort).toBe("low");
  });

  it("with one engine and no one else, a fresh session on the builder's own engine checks", async () => {
    const solo = direct(
      fakePorts(
        [ada],
        engines.filter((e) => e.id === "opus"),
      ),
    );
    expect(await runTicket(solo, low())).toEqual({ status: "done", outcome: "merged" });
    const own = checks(solo) as ReturnType<typeof solo.agent.callsFor>;
    expect(own).toHaveLength(1);
    expect(own[0]?.engine.id).toBe("opus");
    expect(own[0]?.brief).not.toContain("Plan:");
  });

  it("the owner-merges flow checks too, before the gates", async () => {
    const p = ports();
    const result = await runTicket(p, low());
    expect(result.status).toBe("ready");
    const s = fold(await p.store.read("42"));
    expect(s.finished).toEqual(["pickup", "build", "checks", "done-when", "gates", "report"]);
    expect(checks(p)).toHaveLength(1);
  });
});

describe("a ticket that was already proved is not checked twice", () => {
  it("medium with a verifier keeps using prove, and the done-when stage only records it", async () => {
    const p = direct(ports());
    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });
    expect(p.agent.callsFor("quinn", "prove")).toHaveLength(1);
    expect(checks(p)).toHaveLength(0);
    const s = fold(await p.store.read("42"));
    expect(s.finished).toContain("prove");
    expect(s.finished).toContain("done-when");
    expect(s.doneCheck).toMatchObject({ by: null, note: "Checked in the prove stage" });
    expect(s.doneCheck?.items.map((i) => i.verdict)).toEqual(["met", "met"]);
  });

  it("medium with nobody holding the verify duty runs the check (the prove stage is skipped)", async () => {
    const p = direct(fakePorts([ada, grace], engines));
    expect(await runTicket(p, refundsTicket())).toEqual({ status: "done", outcome: "merged" });
    const s = fold(await p.store.read("42"));
    expect(s.outputs.prove).toContain("no one on the team has the verify duty");
    expect(checks(p)).toHaveLength(1);
    expect(s.doneCheck?.by).toBe("grace");
  });
});

describe("a ticket with no done-when", () => {
  it("skips the check and says so, with no session", async () => {
    const p = direct(ports());
    expect(await runTicket(p, low({ doneWhen: [] }))).toEqual({ status: "done", outcome: "merged" });
    expect(checks(p)).toHaveLength(0);
    const s = fold(await p.store.read("42"));
    expect(s.finished).toContain("done-when");
    expect(s.doneCheck).toEqual({ by: null, items: [], note: "No done-when to check" });
  });
});

describe("the result shows in the report", () => {
  it("lists each item with its verdict and evidence", async () => {
    const p = ports();
    p.agent.on({ stage: "done-when", duty: "verify" }, say(reply("met", "met")));
    const result = await runTicket(p, low());
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.report.doneWhen).toMatchObject({ by: "Quinn", note: null });
    const md = reportMarkdown(result.report);
    expect(md).toContain("Done when (checked by Quinn)");
    expect(md).toContain(`- ${first}: met, evidence 1`);
    const s = fold(await p.store.read("42"));
    expect(assembleReport(low(), s, p.company).doneWhen?.items).toHaveLength(2);
  });

  it("says when there was nothing to check", async () => {
    const p = ports();
    const result = await runTicket(p, low({ doneWhen: [] }));
    if (result.status !== "ready") throw new Error("expected ready");
    expect(reportMarkdown(result.report)).toContain("Done when: No done-when to check.");
  });
});

describe("matching the checker's reply to the ticket's items", () => {
  it("matches by text, then by position, and treats a missing item as can't tell", () => {
    const got = readDoneWhenCheck(
      {
        items: [
          { doneWhen: "B", verdict: "Not Met", evidence: "x" },
          { doneWhen: "A", verdict: "met", evidence: "y" },
        ],
      },
      ["A", "B", "C"],
    );
    expect(got.map((i) => i.verdict)).toEqual(["met", "not-met", "cant-tell"]);
    expect(
      readDoneWhenCheck({ items: [{ doneWhen: "reworded", verdict: "met", evidence: "z" }] }, ["A"])[0]
        ?.verdict,
    ).toBe("met"); // same count: matched by position
    expect(readDoneWhenCheck(null, ["A"])[0]?.verdict).toBe("cant-tell");
  });
});
