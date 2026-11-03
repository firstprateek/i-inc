// The sinks (r131): what each one hides, that it only ever takes text out (the guard), that it never touches
// what is stored, that JSON stays JSON, and what a repeat read costs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactLast, redactProse, redactText, sanitizeAction } from "../src/ahp/sanitize.ts";
import {
  guarded,
  lastDirty,
  lastOf,
  nextLiteral,
  outsideOf,
  outward,
  peopleEvents,
  peopleOf,
  peopleView,
  setSinkLog,
  sinkMemos,
  sinkRedactors,
  sinkStats,
  TextMemo,
  takesOutOnly,
  type Wire,
  wire,
} from "../src/sinks.ts";
import type { TicketView } from "../src/view-types.ts";
import { ALL, CANARIES, SHAPES, visible } from "./canaries.ts";

const real = { ...sinkRedactors };
afterEach(() => {
  Object.assign(sinkRedactors, real);
  for (const m of Object.values(sinkMemos)) m.clear();
});

/** A small seeded random source, so a failure can be run again. */
function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Text built from the pieces the redactors look for, glued at random. */
function fuzz(r: () => number, n: number): string {
  const bits = [
    "://",
    "@",
    "?",
    "&",
    ";",
    "=",
    "token",
    "pwd",
    "x-amz-date",
    "sk-",
    "ghp_",
    "gho_",
    "github_pat_",
    "AIza",
    "xoxb-",
    "AKIA",
    "sk_live_",
    "rk_live_",
    "npm_",
    "whsec_",
    ".eyJ",
    "eyJ",
    "https",
    "postgres",
    "user:pa/ss",
    '"',
    "'",
    "/",
    "#",
    " ",
    "\n",
    "_",
    "-",
    ":",
    "\\u0040",
    "\\/",
    "a",
    "Z",
    "0",
    "9",
    "abcdefghij",
    "ABCDEFGHIJKLMNOP0123456789abcdefghij",
    "localhost:3000",
    "react@18",
    "[redacted]",
  ];
  let s = "";
  for (let i = 0; i < n; i++) s += bits[Math.floor(r() * bits.length)];
  return s;
}

describe("the guard", () => {
  it("keeps what only takes out, and sends [redacted] for anything that adds", () => {
    expect(guarded("a secret b", "a [redacted] b")).toBe("a [redacted] b");
    expect(guarded("abc", "abc")).toBe("abc");
    // one character that was not there, or two swapped, is caught
    expect(guarded("abc", "abXc")).toBe("[redacted]");
    expect(guarded("abc", "acb")).toBe("[redacted]");
    // a run of blanks made one blank (redactText) still passes
    expect(guarded(`a${" ".repeat(300)}b`, "a b")).toBe("a b");
    expect(takesOutOnly("x data:image/png;base64,AAAA y", "x [image/png data, 1 KB] y")).toBe(true);
  });

  it("is linear when redactText made runs of blanks one blank between markers", () => {
    // Each piece between markers is not in the input whole: looking for it whole read the rest of the input
    // every time (0.6 s on 1 MB). Matched one character at a time it is one pass.
    const u = `ab${" ".repeat(210)}cd ghp_${"Ab3".repeat(12)} `;
    const s = u.repeat(Math.ceil(1_000_000 / u.length)).slice(0, 1_000_000);
    const out = redactText(s);
    expect(out).toContain("[redacted]");
    const at = performance.now();
    expect(takesOutOnly(s, out)).toBe(true);
    expect(performance.now() - at).toBeLessThan(60);
  });

  it("catches a sabotaged redactor at every sink, and logs it once", () => {
    const lines: string[] = [];
    setSinkLog((l) => lines.push(l));
    sinkRedactors.last = (s) => `${s} LEAK`;
    const before = sinkStats.trips;
    const ws = outward({ content: "postgres://u:a/b@h" });
    expect(ws.content).toBe("[redacted]");
    expect(peopleOf("token: abc")).toBe("[redacted]");
    expect(outsideOf("plain words")).toBe("[redacted]");
    expect(sinkStats.trips - before).toBe(3);
    expect(lines.length).toBeLessThanOrEqual(1);
    expect(lines.join("")).not.toContain("postgres");
  });

  it("passes every result of main's redactors, chained the way the sinks chain them", () => {
    const r = rand(7);
    for (let i = 0; i < 4000; i++) {
      const x = fuzz(r, 1 + Math.floor(r() * 40));
      for (const m of [x, redactText(x), redactProse(x), String(sanitizeAction({ text: x }).text)]) {
        expect(takesOutOnly(m, redactLast(m)), m).toBe(true);
        expect(takesOutOnly(m, redactLast(redactProse(m))), m).toBe(true);
        expect(takesOutOnly(m, redactLast(redactText(m))), m).toBe(true);
      }
    }
  });
});

describe("the cheap test before redactLast", () => {
  it("only lets through text redactLast would leave as it is", () => {
    const r = rand(11);
    let skipped = 0;
    for (let i = 0; i < 60_000; i++) {
      const x = fuzz(r, 1 + Math.floor(r() * 30));
      if (!lastDirty(x)) {
        skipped++;
        expect(redactLast(x), x).toBe(x);
      }
    }
    for (const c of CANARIES) if (redactLast(c.text) !== c.text) expect(lastDirty(c.text), c.name).toBe(true);
    // the longest secret query name redactLast knows (x-goog- and 40 more): the scan back from `=` reaches its `?`
    for (const n of [1, 39, 40]) {
      const q = `https://h.example/o?x-goog-${"a".repeat(n)}=SECRETVALUE`;
      expect(redactLast(q), q).not.toContain("SECRETVALUE");
      expect(lastDirty(q), q).toBe(true);
      expect(lastOf(q), q).not.toContain("SECRETVALUE");
    }
    // it does skip: a test that skips nothing proves nothing
    expect(skipped).toBeGreaterThan(5000);
  });
});

describe("label retention: main's chains are left as they are", () => {
  const x = 'see https://db.example:?pwd="x"@SECRETTAIL now';
  it("redactText read twice still hides SECRETTAIL, as on main", () => {
    expect(redactText(redactText(x))).not.toContain("SECRETTAIL");
    // the sinks run after main's last read, so they keep that
    expect(lastOf(redactText(redactText(x)))).not.toContain("SECRETTAIL");
    expect(outsideOf(redactText(x))).not.toContain("SECRETTAIL");
  });
  it("control: redactLast inside redactText would show it", () => {
    const inside = (s: string) => redactLast(redactText(s));
    expect(inside(inside(x))).toContain("SECRETTAIL");
  });
});

describe("the WebSocket pass", () => {
  it("hides every canary in agent text, and the shapes main shows", () => {
    for (const c of CANARIES) {
      const stored = sanitizeAction({ type: "x", part: { content: c.text } });
      const sent = outward(stored);
      expect(visible(JSON.stringify(sent), [c]), c.name).toEqual([]);
    }
    // main's own send shows the shapes it lets through: these are what the sink adds
    const stored = sanitizeAction({ content: SHAPES.map((s) => s.text).join("\n") });
    expect(visible(stored.content, SHAPES).length).toBeGreaterThan(0);
    expect(visible(outward(stored).content, SHAPES)).toEqual([]);
  });

  it("leaves the owner's own messages on a conversation, and the brief on a ticket stage gets it", () => {
    const owner = { text: SHAPES[0]?.text ?? "", origin: { kind: "user" } };
    const conv = { channel: "ahp-chat:/c1", action: { type: "chat/turnStarted", message: owner } };
    expect(outward(conv)).toBe(conv);
    const stage = { channel: "ahp-chat:/stage:7", action: { type: "chat/turnStarted", message: owner } };
    expect(visible(JSON.stringify(outward(stage)), SHAPES)).toEqual([]);
    // a read-only channel the host names, whatever its uri
    const ro = { resource: "ahp-chat:/x", state: { turns: [{ message: owner }] } };
    expect(visible(JSON.stringify(outward(ro, (u) => u === "ahp-chat:/x")), SHAPES)).toEqual([]);
    // an agent's message is the agent's text
    const agent = { channel: "ahp-chat:/c1", message: { text: owner.text, origin: { kind: "agent" } } };
    expect(visible(JSON.stringify(outward(agent)), SHAPES)).toEqual([]);
  });

  it("touches nothing outside the text keys, and gives back the same object when nothing changes", () => {
    const leak = SHAPES[0]?.text ?? "";
    const v = {
      id: leak,
      uri: leak,
      toolCallId: leak,
      _meta: { "iinc.locations": [{ path: leak }] },
      data: leak,
      options: [{ id: "allow", value: leak }],
    };
    expect(outward(v)).toBe(v);
    const clean = { content: "hello there", turns: [{ text: "x".repeat(5000) }], title: "Fix the build" };
    expect(outward(clean)).toBe(clean);
    // slash commands' description and hint are text at the sink (G8); the name the owner sends back is not
    const meta = {
      "iinc.commands": [{ name: "deploy", description: leak, input: { hint: leak } }],
    };
    const out = outward(meta) as typeof meta;
    expect(out["iinc.commands"][0]?.name).toBe("deploy");
    expect(visible(JSON.stringify(out), SHAPES)).toEqual([]);
  });

  it("keeps a tool's JSON input valid JSON with every key, and byte-identical with nothing to hide", () => {
    const input = JSON.stringify({
      command: "curl https://api.example:v2/items",
      owner: "ops@corp.example",
      url: "postgres://app:ab/cd@db.example/app",
      nested: { list: ["build9sk-CnryGluedSk15aBcDeFgHiJk", 3, true, null] },
    });
    const out = lastOf(input, true);
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toEqual(["command", "owner", "url", "nested"]);
    expect(parsed.owner).toBe("ops@corp.example");
    expect(parsed.url).not.toContain("ab/cd");
    expect(JSON.stringify(parsed.nested)).not.toContain("CnryGluedSk15");
    // over the serialized string instead, a field is lost
    expect(Object.keys(JSON.parse(redactLast(input)))).not.toEqual(["command", "owner", "url", "nested"]);
    const r = rand(5);
    for (let i = 0; i < 2000; i++) {
      const o: Record<string, unknown> = {};
      for (let k = 0; k < 4; k++) o[`k${k}`] = fuzz(r, 1 + Math.floor(r() * 12)).replaceAll("\\", "");
      const s = JSON.stringify(o);
      const t = lastOf(s, true);
      const back = JSON.parse(t) as Record<string, string>;
      expect(Object.keys(back)).toEqual(Object.keys(o));
      for (const k of Object.keys(o)) {
        const was = o[k] as string;
        expect(takesOutOnly(was, back[k] as string)).toBe(true);
        if (redactLast(was) === was) expect(back[k]).toBe(was);
      }
    }
    // an escape that hides a shape from the cheap test is decoded first
    const escaped = '{"cmd":"psql postgres:\\/\\/app:ab\\/CnrySlashPw12\\u0040db.example\\/app"}';
    expect(lastOf(escaped, true)).not.toContain("CnrySlashPw12");
    expect(() => JSON.parse(lastOf(escaped, true))).not.toThrow();
  });

  it("finds the same JSON string literals as the regex it stands for, in one pass", () => {
    const LITERAL = /"(?:[^"\\\n]|\\.)*"/g;
    const r = rand(5);
    const alphabet = ['"', '"', "\\", "\\", "\n", "\r", "\u2028", "a", "b", ":", " "];
    for (let i = 0; i < 20_000; i++) {
      let x = "";
      const n = Math.floor(r() * 24);
      for (let j = 0; j < n; j++) x += alphabet[Math.floor(r() * alphabet.length)];
      const want = [...x.matchAll(LITERAL)].map((m) => [m.index, m.index + m[0].length]);
      const got: number[][] = [];
      for (let m = nextLiteral(x, 0); m; m = nextLiteral(x, m[1])) got.push(m);
      expect(got, JSON.stringify(x)).toEqual(want);
    }
  });

  it("redacts a tool input sanitizeAction cut, which ends in an open literal, in linear time", () => {
    // The cut ends inside a string full of \": the regex retried from every quote to the end (0.5 to 2 s at 64K).
    const line = '  const url = "https://example.com/api"; // @param task-id "x"\n';
    const cut = String(
      sanitizeAction({ toolInput: JSON.stringify({ file_path: "/a.ts", content: line.repeat(2000) }) })
        .toolInput,
    );
    expect(cut).toContain("more characters not kept");
    const quotes = String(
      sanitizeAction({ toolInput: JSON.stringify({ c: `task- ${'"'.repeat(40_000)}` }) }).toolInput,
    );
    for (const t of [cut, quotes]) {
      expect(lastDirty(t)).toBe(true);
      const at = performance.now();
      expect(lastOf(t, true)).toBe(t);
      expect(performance.now() - at).toBeLessThan(100);
    }
    // and a shape inside the open literal is still hidden
    const shaped = String(
      sanitizeAction({
        toolInput: JSON.stringify({
          content: `${line.repeat(1100)}${SHAPES[0]?.text}\n${line.repeat(1100)}`,
        }),
      }).toolInput,
    );
    expect(visible(lastOf(shaped, true), SHAPES)).toEqual([]);
  });

  it("makes the only frame the host can send", () => {
    const frame: Wire = wire({ jsonrpc: "2.0", method: "action", params: { action: { content: "hi" } } });
    expect(JSON.parse(frame).params.action.content).toBe("hi");
    // @ts-expect-error: a plain string is not a frame the sink made
    const raw: Wire = "{}";
    void raw;
    const host = readFileSync(join(import.meta.dirname, "../src/ahp/host.ts"), "utf8");
    expect(host).toMatch(/private sendText\(conn: Conn, text: Wire\): void/);
    // and nothing but the sink makes one
    const src = join(import.meta.dirname, "../src");
    for (const f of ["ahp/host.ts", "api.ts", "ahp/session-host.ts", "ahp/ticket-channels.ts"])
      expect(readFileSync(join(src, f), "utf8")).not.toMatch(/as Wire\b/);
  });
});

describe("the owner's views", () => {
  const person = { id: "ada", name: "Ada", tint: 1, role: "engineer" };
  const view = (createdBy: typeof person | null): TicketView =>
    ({
      id: "12",
      title: `Fix ${CANARIES[0]?.text}`,
      project: "Duet",
      type: "fix",
      effort: "low",
      doneWhen: [ALL],
      reason: ALL,
      assignee: person,
      column: "review",
      status: "ready",
      held: false,
      stages: [{ id: "build", state: "done" }],
      live: `Failed: ${ALL}`,
      needsYou: { kind: "stuck", reason: ALL },
      waiting: null,
      report: {
        title: `[fix] ${CANARIES[0]?.text}`,
        byline: "Ada",
        engines: null,
        checks: ALL,
        minutes: 3,
        judgment: ALL,
        pr: "https://github.com/o/r/pull/1",
      },
      failure: { stage: "build", reason: ALL, tried: [] },
      outcome: null,
      createdBy,
      attachments: [
        { n: 1, name: "screen.png", mime: "image/png", bytes: 3, url: "/api/tickets/12/attachments/1" },
      ],
    }) as unknown as TicketView;

  it("hides every canary in an agent's follow-up, and keeps ids, links and enums", () => {
    const v = peopleView(view(person));
    expect(visible(JSON.stringify(v))).toEqual([]);
    expect(v.id).toBe("12");
    expect(v.report?.pr).toBe("https://github.com/o/r/pull/1");
    expect(v.attachments?.[0]?.url).toBe("/api/tickets/12/attachments/1");
    expect(v.status).toBe("ready");
  });

  it("leaves the owner's own title, reason and done-when as typed, and still hides the agent's words", () => {
    const v = peopleView(view(null));
    expect(v.title).toBe(view(null).title);
    expect(v.reason).toBe(ALL);
    expect(v.doneWhen).toEqual([ALL]);
    expect(v.report?.title).toBe(view(null).report?.title);
    expect(
      visible(
        JSON.stringify({ ...v, title: "", reason: "", doneWhen: [], report: { ...v.report, title: "" } }),
      ),
    ).toEqual([]);
  });

  it("leaves the owner's own done-when lines as typed where the check repeats them", () => {
    const typed = "Login works when token: is missing";
    const v = peopleView({
      ...view(null),
      doneWhen: [typed],
      doneCheck: { by: null, note: null, items: [{ doneWhen: typed, verdict: "met", evidence: ALL }] },
    } as unknown as TicketView) as unknown as {
      doneCheck: { items: { doneWhen: string; evidence: string }[] };
    };
    expect(v.doneCheck.items[0]?.doneWhen).toBe(typed);
    expect(visible(v.doneCheck.items[0]?.evidence ?? "")).toEqual([]);
    // an agent's follow-up gets the pass on them
    const a = peopleView({
      ...view(person),
      doneWhen: [ALL],
      doneCheck: { by: null, note: null, items: [{ doneWhen: ALL, verdict: "met", evidence: "ok" }] },
    } as unknown as TicketView) as unknown as { doneCheck: { items: { doneWhen: string }[] } };
    expect(visible(a.doneCheck.items[0]?.doneWhen ?? "")).toEqual([]);
  });

  it("runs redactLast on an agent's JSON reply one literal at a time, so it stays JSON with every key", () => {
    const reply = JSON.stringify({
      plan: "curl http://api:v2/health",
      owner: "ops@corp.example",
      steps: [1],
    });
    const out = peopleOf(reply);
    expect(Object.keys(JSON.parse(out))).toEqual(["plan", "owner", "steps"]);
    const shaped = JSON.stringify({ note: SHAPES[0]?.text, n: 2 });
    expect(visible(peopleOf(shaped), SHAPES)).toEqual([]);
    expect(Object.keys(JSON.parse(peopleOf(shaped)))).toEqual(["note", "n"]);
  });

  it("keeps commit ids, and leaves the owner's own events alone", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(peopleOf(`pushed ${sha}`)).toBe(`pushed ${sha}`);
    const events = peopleEvents([
      { type: "stage-finished", at: 1, stage: "build", output: ALL },
      { type: "owner-message", at: 2, text: ALL },
      { type: "pushed", at: 3, sha },
    ] as never[]) as { output?: string; text?: string; sha?: string }[];
    expect(visible(events[0]?.output ?? "")).toEqual([]);
    expect(events[1]?.text).toBe(ALL);
    expect(events[2]?.sha).toBe(sha);
  });
});

describe("what leaves the machine", () => {
  it("hides every canary with redactText then redactLast", () => {
    for (const c of CANARIES) expect(visible(outsideOf(c.text), [c]), c.name).toEqual([]);
  });
});

describe("cost, counted", () => {
  it("a repeat read of the same text runs no redactor", () => {
    const big = `${"a line of agent prose. ".repeat(200)}\n${ALL}`;
    const action = { content: big, turns: [{ text: big }, { text: SHAPES[3]?.text }] };
    outward(action);
    const people = `${big} again`;
    peopleOf(people);
    const before = { ...sinkStats };
    for (let i = 0; i < 5; i++) {
      outward(structuredClone(action));
      peopleOf(`${big} again`);
    }
    expect(sinkStats.last).toBe(before.last);
    expect(sinkStats.prose).toBe(before.prose);
    expect(sinkMemos.last.hits).toBeGreaterThan(0);
  });

  it("re-subscribing to a chat with many big tool inputs finds every one in the memo", () => {
    // About 46 big inputs fitted whole, and a snapshot walks them in the same order every time, so each
    // re-subscribe pushed out the ones the next one needed. Kept by hash, all of them fit.
    const line = '  const url = "https://example.com/api"; // @param task-id "x"\n';
    const parts = [...Array(60)].map((_, i) => ({
      kind: "toolCall",
      toolCallId: `c${i}`,
      toolInput: String(
        sanitizeAction({ toolInput: JSON.stringify({ file_path: `/f${i}.ts`, content: line.repeat(1800) }) })
          .toolInput,
      ),
    }));
    const snap = { jsonrpc: "2.0", id: 1, result: { state: { turns: [{ responseParts: parts }] } } };
    wire(snap);
    const misses = sinkMemos.lastJson.misses;
    const last = sinkStats.last;
    wire(snap);
    expect(sinkMemos.lastJson.misses).toBe(misses);
    expect(sinkStats.last).toBe(last);
    expect(sinkMemos.lastJson.hits).toBeGreaterThanOrEqual(60);
  });

  it("keeps at most so many entries, however short", () => {
    const m = new TextMemo(6_000_000, 1000);
    for (let i = 0; i < 5000; i++) m.set(`sk-${i.toString(36)}`, "[redacted]");
    expect(m.size.entries).toBe(1000);
    // the newest are kept, and a set again is not counted twice
    expect(m.get("sk-3ns")).toBe("[redacted]");
    const chars = m.size.chars;
    m.set("sk-3ns", "[redacted]");
    expect(m.size.chars).toBe(chars);
  });

  it("text with nothing to hide never reaches the redactor", () => {
    const before = sinkStats.last;
    outward({ content: "x".repeat(1_000_000), title: "Fix the board", message: "done" });
    expect(sinkStats.last).toBe(before);
  });
});
