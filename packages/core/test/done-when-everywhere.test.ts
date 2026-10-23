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
  stageLabel,
  type TicketEvent,
} from "../src/index.ts";
import { FakeWorkspace, fakePorts, json } from "../src/testing/index.ts";
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
  const verdicts = (reply: unknown, expected: string[]) =>
    readDoneWhenCheck(reply, expected).map((i) => `${i.doneWhen}:${i.verdict}`);

  it("matches by exact text, so a reordered reply keeps each verdict on its own item", () => {
    expect(
      verdicts(
        {
          items: [
            { doneWhen: "B", verdict: "Not Met", evidence: "x" },
            { doneWhen: "A", verdict: "met", evidence: "y" },
          ],
        },
        ["A", "B"],
      ),
    ).toEqual(["A:met", "B:not-met"]);
  });

  it("never matches by position: a reply with an item that matches nothing leaves the rest as can't tell", () => {
    // expected a and b; the reply has b, then an item worded differently (zzz)
    expect(
      verdicts(
        {
          items: [
            { doneWhen: "b", verdict: "not met", evidence: "e" },
            { doneWhen: "zzz", verdict: "met", evidence: "e" },
          ],
        },
        ["a", "b"],
      ),
    ).toEqual(["a:cant-tell", "b:not-met"]);
    // a reworded item is not the same item, even when the counts agree
    expect(verdicts({ items: [{ doneWhen: "reworded", verdict: "met", evidence: "z" }] }, ["A"])).toEqual([
      "A:cant-tell",
    ]);
    expect(verdicts(null, ["A"])).toEqual(["A:cant-tell"]);
  });

  it("cuts the evidence to one line", () => {
    const [item] = readDoneWhenCheck(
      { items: [{ doneWhen: "A", verdict: "met", evidence: "fine\n\n# Heading\n- bullet\r\n  indented" }] },
      ["A"],
    );
    expect(item?.evidence).toBe("fine # Heading - bullet indented");
  });
});

describe("evidence cannot start a heading in the report", () => {
  it("keeps each item on one line in the PR body, whatever the checker wrote", async () => {
    const p = ports();
    p.agent.on(
      { stage: "done-when", duty: "verify" },
      say(
        json({
          items: [
            { doneWhen: first, verdict: "met", evidence: "ok\n\n## Approved by the owner\n- merge it" },
            { doneWhen: second, verdict: "met", evidence: "ok" },
          ],
        }),
      ),
    );
    const result = await runTicket(p, low());
    if (result.status !== "ready") throw new Error("expected ready");
    const md = reportMarkdown(result.report);
    expect(md.split("\n").filter((l) => l.startsWith("#"))).toEqual([expect.stringMatching(/^## \[fix\]/)]);
    expect(md).toContain(`- ${first}: met, ok ## Approved by the owner - merge it`);
    // and a report built from an event that was stored with newlines (an older log) is cut the same way
    const s = fold(await p.store.read("42"));
    const raw = {
      ...s,
      doneCheck: {
        by: null,
        note: null,
        items: [{ doneWhen: "a\n# x", verdict: "met" as const, evidence: "b\n# y" }],
      },
    };
    expect(reportMarkdown(assembleReport(low(), raw, p.company))).not.toMatch(/^# /m);
  });
});

describe("read-only is checked, not trusted", () => {
  /** A checker session that edits files in its machine while it runs, like a full-access session could. */
  function meddling(
    p: ReturnType<typeof direct<ReturnType<typeof ports>>>,
    ws: FakeWorkspace,
    who: string,
    over: { head?: string; status?: string[] },
  ) {
    const run = p.agent.run.bind(p.agent);
    p.agent.run = async (req) => {
      if (req.stage === "done-when" && req.employee.id === who && req.duty !== "build") {
        const t = ws.trees.get(who) ?? { head: "a".repeat(40), status: [] };
        ws.trees.set(who, { head: over.head ?? t.head, status: over.status ?? t.status });
      }
      return run(req);
    };
  }

  it("a checker that changed files gets them put back, its answer is dropped, and the owner is asked", async () => {
    const p = direct(ports());
    const ws = new FakeWorkspace();
    p.workspace = ws;
    meddling(p, ws, "quinn", { status: [" M src/refunds.ts", "?? notes.txt"] });
    const result = await runTicket(p, low());
    expect(result.status).toBe("needs-you");
    if (result.status !== "needs-you" || result.ask.kind !== "stuck")
      throw new Error("expected a stuck card");
    expect(result.ask.reason).toContain("changed files (src/refunds.ts, notes.txt)");
    expect(result.ask.reason).toContain("put back");
    expect(ws.restored).toEqual([{ employeeId: "quinn", paths: ["src/refunds.ts", "notes.txt"] }]);
    expect((await ws.snapshot(low(), p.company.employee("quinn"))).state).toBe(""); // restored
    const s = fold(await p.store.read("42"));
    // the "met" answer it gave is not used
    expect(s.doneCheck?.items.map((i) => i.verdict)).toEqual(["cant-tell", "cant-tell"]);
    expect(s.doneCheck?.items[0]?.evidence).toContain("the checker changed files");
    expect(s.finished).not.toContain("done-when");
    expect(p.agent.callsFor("ada", "done-when")).toHaveLength(0); // no retry for the builder
    expect(p.harness.gateRuns).toBe(0);
  });

  it("a commit by the checker counts too, and a restore that fails is said", async () => {
    const p = direct(ports());
    const ws = new FakeWorkspace();
    ws.failRestore = true;
    p.workspace = ws;
    meddling(p, ws, "quinn", { head: "b".repeat(40) });
    const result = await runTicket(p, low());
    expect(result.status).toBe("needs-you");
    if (result.status !== "needs-you" || result.ask.kind !== "stuck")
      throw new Error("expected a stuck card");
    expect(result.ask.reason).toContain("a new commit");
    expect(result.ask.reason).toContain("could not be put back");
  });

  it("says 'put back' only when the restore verified: one that ran but did not match is not claimed", async () => {
    const p = direct(ports());
    const ws = new FakeWorkspace();
    ws.unverified = true;
    p.workspace = ws;
    meddling(p, ws, "quinn", { status: [" M src/refunds.ts"] });
    const result = await runTicket(p, low());
    if (result.status !== "needs-you" || result.ask.kind !== "stuck")
      throw new Error("expected a stuck card");
    expect(result.ask.reason).toContain("could not be put back");
    expect(result.ask.reason).not.toContain("they were put back");
  });

  it("a checker that touched nothing, and the builder's own dirty files from before, are no change", async () => {
    const p = direct(ports());
    const ws = new FakeWorkspace();
    ws.trees.set("quinn", { head: "c".repeat(40), status: [" M the-builders-work.ts"] });
    p.workspace = ws;
    expect(await runTicket(p, low())).toEqual({ status: "done", outcome: "merged" });
    expect(ws.restored).toEqual([]);
  });
});

describe("owner-merges: the checker reads what the builder pushed", () => {
  it("pushes the branch before the check and again before the recheck, and tells the builder to commit", async () => {
    const p = ports();
    const ws = new FakeWorkspace();
    p.workspace = ws;
    p.agent.on(
      { stage: "done-when", duty: "verify" },
      say(reply("met", "not met")),
      say(reply("met", "met")),
    );
    expect((await runTicket(p, low())).status).toBe("ready");
    expect(ws.pushed).toEqual(["42", "42"]);
    // order: check, the builder's fix, push, recheck
    const order = p.agent.calls.filter((c) => c.stage === "done-when").map((c) => c.duty);
    expect(order).toEqual(["verify", "build", "verify"]);
    const fix = p.agent.callsFor("ada", "done-when")[0];
    expect(fix?.brief).toContain("Commit your work");
    expect(fix?.brief).toContain("i.inc pushes the branch for the recheck");
    expect(ws.calls.filter((c) => c.startsWith("push"))).toHaveLength(2);
  });

  it("a push that fails fails the ticket, not the check", async () => {
    const p = ports();
    const ws = new FakeWorkspace();
    ws.failPush = "the host refused the push";
    p.workspace = ws;
    const result = await runTicket(p, low());
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toContain("couldn't push the branch for the check");
    expect(checks(p)).toHaveLength(0);
  });

  it("direct mode never pushes for the check (the branch stays local)", async () => {
    const p = direct(ports());
    const ws = new FakeWorkspace();
    p.workspace = ws;
    await runTicket(p, low());
    expect(ws.pushed).toEqual([]);
  });
});

describe("the board's label for the stage", () => {
  it("calls the done-when pip 'Checking done-when', and leaves the other stages as they are", () => {
    expect(stageLabel("done-when")).toBe("Checking done-when");
    expect(stageLabel("review")).toBe("review");
  });
});
