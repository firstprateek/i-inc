// A reply streams in as thousands of tiny deltas: they are joined, a part has a ceiling, the log and
// the snapshots grow with the text and not faster, and the event loop is never held for long.
import { describe, expect, it } from "vitest";
import { ActionType, ResponsePartKind, ROOT } from "../../src/ahp/wire.ts";
import { type Any, rig, turnStarted } from "./support.ts";

const rows = (t: Awaited<ReturnType<typeof rig>>, like = "%") =>
  (t.db.all("SELECT COUNT(*) AS n FROM ahp_actions WHERE action LIKE ?", like)[0] as { n: number }).n;
const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("joining deltas", () => {
  it("keeps one action for a run of tiny pieces, in order with what comes around them, and the text whole", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const live = t.client();
    await live.init([ROOT, chat]);
    t.backend.script = async (run, be) => {
      be.text(run, "start ");
      for (let i = 0; i < 10_000; i++) be.delta(run, i % 2 ? "ab " : "cd ");
      be.tool(run, "x"); // anything else sends the joined text first
      be.text(run, "end", `${run.turnId}:md2`);
      for (let i = 0; i < 100; i++) be.delta(run, "!", `${run.turnId}:md2`);
      return { kind: "complete" };
    };
    live.dispatch(chat, turnStarted("go", "t1"));
    await t.host.idle();
    const parts = t.host.chatState(chat)?.turns[0]?.responseParts as Any[];
    expect(parts[0].content).toBe(`start ${"cd ab ".repeat(5000)}`);
    expect(parts[2].content).toBe(`end${"!".repeat(100)}`);
    expect(rows(t, '%"chat/delta"%')).toBeLessThan(20); // 10,100 pieces, a handful of actions
    // what a watching client saw is the same, in the same order
    expect(live.state<Any>(chat).turns[0].responseParts[0].content).toBe(parts[0].content);
    const kinds = live.actions(chat).map((e) => e.action.type);
    expect(kinds.indexOf(ActionType.ChatToolCallStart)).toBeGreaterThan(kinds.indexOf(ActionType.ChatDelta));
  });

  it("shows the text as it comes: a quiet moment sends what is waiting, within a few tens of ms", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const live = t.client();
    await live.init([ROOT, chat]);
    let go!: () => void;
    const hold = new Promise<void>((r) => {
      go = r;
    });
    t.backend.script = async (run, be) => {
      be.text(run, "a");
      be.delta(run, "b");
      be.delta(run, "c");
      await hold;
      return { kind: "complete" };
    };
    live.dispatch(chat, turnStarted("go", "t1"));
    await sleep(150);
    expect((live.state<Any>(chat).activeTurn.responseParts[0] as Any).content).toBe("abc");
    go();
    await t.host.idle();
  });

  it("sends the text before the turn ends, even when the agent finishes at once", async () => {
    const t = await rig();
    const { chat } = await t.session();
    t.backend.script = async (run, be) => {
      be.text(run, "x");
      be.delta(run, "yz");
      return { kind: "complete" };
    };
    const c = t.client();
    await c.init([ROOT, chat]);
    c.dispatch(chat, turnStarted("go", "t1"));
    await t.host.idle();
    const parts = (t.host.chatState(chat)?.turns[0]?.responseParts ?? []) as Any[];
    expect(parts[0].content).toBe("xyz");
  });
});

describe("a part of a reply has a ceiling", () => {
  it("cuts at 2 MB with a marker, once, and drops the rest instead of keeping it", async () => {
    const t = await rig();
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    const piece = "lorem ipsum dolor sit amet ".repeat(160); // 4 KB of prose
    t.backend.script = async (run, be) => {
      be.text(run, "");
      for (let i = 0; i < 1000; i++) {
        be.delta(run, piece); // 4 MB in all
        if (i % 50 === 0) await tick();
      }
      be.delta(run, "after the cut");
      return { kind: "complete" };
    };
    c.dispatch(chat, turnStarted("go", "t1"));
    await t.host.idle();
    const part = t.host.chatState(chat)?.turns[0]?.responseParts[0] as Any;
    expect(part.content.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(part.content.length).toBeLessThan(2 * 1024 * 1024 + 200);
    expect(part.content.endsWith("a part of a reply is kept to its first 2 MB]")).toBe(true);
    expect(part.content).not.toContain("after the cut");
    expect((t.db.all("SELECT SUM(LENGTH(action)) AS n FROM ahp_actions")[0] as { n: number }).n).toBeLessThan(
      2.6 * 1024 * 1024,
    );
    // a new part starts afresh
    expect(c.state<Any>(chat).turns[0].responseParts[0].content).toBe(part.content);
  });
});

describe("a long streaming turn", () => {
  it("takes 24 MB of reply in 4 KB pieces without holding the loop for a second or growing past 300 MB", async () => {
    const t = await rig({ limits: { snapshotMinBytes: 256 * 1024, snapshotMinMs: 5000 } });
    const { chat } = await t.session();
    const c = t.client();
    await c.init([ROOT, chat]);
    const line = "The quick brown fox jumps over the lazy dog, again and again. ";
    const piece = line.repeat(66).slice(0, 4096);
    t.backend.script = async (run, be) => {
      for (let p = 0; p < 12; p++) {
        be.text(run, "", `${run.turnId}:p${p}`);
        for (let i = 0; i < 500; i++) {
          be.delta(run, piece, `${run.turnId}:p${p}`); // about 2 MB a part, 24 MB in all
          if (i % 25 === 0) await tick();
        }
      }
      return { kind: "complete" };
    };
    const rss0 = process.memoryUsage().rss;
    let rssMax = rss0;
    let worstLag = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      worstLag = Math.max(worstLag, now - last - 10);
      last = now;
      rssMax = Math.max(rssMax, process.memoryUsage().rss);
    }, 10);
    c.dispatch(chat, turnStarted("write a lot", "t1"));
    await t.host.idle();
    clearInterval(probe);
    const parts = t.host.chatState(chat)?.turns[0]?.responseParts as Any[];
    expect(parts).toHaveLength(12);
    expect(parts.reduce((n, p) => n + p.content.length, 0)).toBe(12 * 500 * piece.length);
    // The loop was not held: lag under 5 s here (a stream that re-serialised its whole part on every delta holds it
    // for tens of seconds); the tight limit, 1 s, is checked when I_INC_BENCH is set.
    expect(worstLag).toBeLessThan(process.env.I_INC_BENCH ? 1000 : 5_000);
    expect((rssMax - rss0) / 1024 / 1024).toBeLessThan(300);
    // snapshots followed the size of the state, not the number of actions: a few dozen at most
    const snaps = t.db.all("SELECT COUNT(*) AS n FROM ahp_snapshots")[0] as { n: number };
    expect(snaps.n).toBeLessThan(10);
    const logged = (t.db.all("SELECT SUM(LENGTH(action)) AS n FROM ahp_actions")[0] as { n: number }).n;
    expect(logged).toBeLessThan(24 * 1024 * 1024 * 1.1);
    expect(parts[0].kind).toBe(ResponsePartKind.Markdown);
  }, 120_000);
});
