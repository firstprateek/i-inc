// The review pane: comments and what they do to the next message, the pane on its own against a fake API, and the
// Conversations screen around it (opening, closing, focus, and the thread left undisturbed).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import type { IncConvComposer } from "../../src/components/conv-composer.ts";
import "../../src/components/conv-composer.ts";
import type { IncConvReview } from "../../src/components/conv-review.ts";
import "../../src/components/conv-review.ts";
import type { IncConversations } from "../../src/components/conversations.ts";
import "../../src/components/conversations.ts";
import { LIMITS } from "../../src/conversations/actions.ts";
import {
  commentsBlock,
  fileNote,
  type LineComment,
  reviewComments,
  withComments,
} from "../../src/conversations/review.ts";
import { DRAFT_CAP, draftMemo } from "../../src/drafts.ts";
import { CHAT, hosts, must, SESSION, until } from "../ahp/fake-host.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted JSON.
type Any = any;

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const note = (over: Partial<LineComment> = {}): Omit<LineComment, "id"> => ({
  path: "src/a.ts",
  line: 3,
  side: "new",
  quote: "const a = 1;",
  text: "Name this better.",
  ...over,
});

afterEach(() => {
  document.body.innerHTML = "";
  draftMemo.clearAll();
  localStorage.clear();
  resetAhp();
  vi.unstubAllGlobals();
});

describe("comments", () => {
  it("reads as path:line, the quoted line and the comment", () => {
    const a = reviewComments.add("c1", note());
    const b = reviewComments.add(
      "c1",
      note({ path: "b.ts", line: 9, side: "old", quote: "gone", text: "Why?" }),
    );
    expect(commentsBlock([a, b])).toBe(
      "Comments on the changes:\n\nsrc/a.ts:3\n> const a = 1;\nName this better.\n\nb.ts:9 (removed line)\n> gone\nWhy?",
    );
  });

  it("goes after what was typed, or alone", () => {
    const a = reviewComments.add("c1", note());
    expect(withComments("  Please fix  ", [a])).toMatch(/^Please fix\n\nComments on the changes:/);
    expect(withComments("", [a])).toMatch(/^Comments on the changes:/);
    expect(withComments("hi", [])).toBe("hi");
    expect(withComments("", [])).toBe("");
  });

  it("is kept per conversation, across a reload, in storage", () => {
    reviewComments.add("c1", note());
    reviewComments.add("c2", note({ text: "other" }));
    expect(reviewComments.list("c1").map((c) => c.text)).toEqual(["Name this better."]);
    expect(reviewComments.list("c2").map((c) => c.text)).toEqual(["other"]);
    expect(localStorage.getItem("inc.chat.draft.comments:c1")).toContain("Name this better.");
  });

  it("takes out only what it was told to", () => {
    const a = reviewComments.add("c1", note());
    const b = reviewComments.add("c1", note({ text: "keep" }));
    reviewComments.remove("c1", [a.id]);
    expect(reviewComments.list("c1").map((c) => c.id)).toEqual([b.id]);
    reviewComments.remove("c1", [b.id]);
    expect(localStorage.getItem("inc.chat.draft.comments:c1")).toBeNull();
  });

  it("survives junk in storage", () => {
    localStorage.setItem("inc.chat.draft.comments:c1", "{not json");
    expect(reviewComments.list("c1")).toEqual([]);
    localStorage.setItem("inc.chat.draft.comments:c1", '[{"id":1},{"nope":true}]');
    expect(reviewComments.list("c1")).toEqual([]);
  });

  it("stays in memory when too big to store, and goes at sign-out either way", () => {
    for (let i = 0; i < 8; i++) reviewComments.add("c1", note({ text: "x".repeat(4000) }));
    expect(JSON.stringify(reviewComments.list("c1")).length).toBeGreaterThan(DRAFT_CAP);
    expect(reviewComments.list("c1").length).toBe(8);
    expect(localStorage.getItem("inc.chat.draft.comments:c1")).toBeNull();
    reviewComments.add("c2", note());
    draftMemo.clearAll();
    expect(reviewComments.list("c1")).toEqual([]);
    expect(reviewComments.list("c2")).toEqual([]);
  });

  it("caps a long quoted line", () => {
    expect(reviewComments.add("c1", note({ quote: "q".repeat(5000) })).quote.length).toBeLessThan(310);
  });
});

describe("why a file shows no lines", () => {
  const side = (state: Any) => ({ state });
  it("names each reason, and has none for text", () => {
    expect(fileNote({ before: side("none"), after: side("none"), withheld: true })).toMatch(/secrets/);
    expect(fileNote({ before: side("none"), after: side("outside") })).toMatch(/leaves the working copy/);
    expect(fileNote({ before: side("too-big"), after: side("text") })).toMatch(/1 MB/);
    expect(fileNote({ before: side("binary"), after: side("binary") })).toMatch(/binary/);
    expect(fileNote({ before: side("none"), after: side("other") })).toMatch(/regular file/);
    expect(fileNote({ before: side("none"), after: side("text") })).toBeNull();
    expect(fileNote({ before: side("text"), after: side("link") })).toBeNull();
  });
});

describe("the composer with comments waiting", () => {
  async function mount(chat: Any = { turns: [] }, over: Partial<IncConvComposer> = {}) {
    const el = document.createElement("inc-conv-composer") as IncConvComposer;
    const send = vi.fn(async () => null as string | null);
    el.conversationId = "c1";
    el.name = "Ada";
    el.chat = chat;
    el.onSend = send;
    Object.assign(el, over);
    document.body.append(el);
    await el.updateComplete;
    return { el, send, root: el.shadowRoot as ShadowRoot };
  }
  const typeIn = async (el: IncConvComposer, text: string) => {
    const ta = el.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;
  };

  it("adds them to the next message and clears them once it is sent", async () => {
    reviewComments.add("c1", note());
    const { el, send } = await mount();
    await typeIn(el, "Also this");
    await el.submit("turn");
    expect(send).toHaveBeenCalledWith({
      text: "Also this\n\nComments on the changes:\n\nsrc/a.ts:3\n> const a = 1;\nName this better.",
      files: [],
      intent: "turn",
    });
    expect(reviewComments.list("c1")).toEqual([]);
  });

  it("can send with an empty box, and says what is going", async () => {
    reviewComments.add("c1", note());
    const { el, send, root } = await mount();
    expect(root.querySelector(".going")?.textContent).toContain("1 comment goes with this message");
    expect((root.querySelector(".send") as HTMLButtonElement).disabled).toBe(false);
    await el.submit("turn");
    expect(send).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".going")).toBeNull();
  });

  it("keeps steer and queue what they are, with comments in the message", async () => {
    const chat = { turns: [], activeTurn: { id: "t" } };
    reviewComments.add("c1", note());
    const a = await mount(chat);
    await a.el.submit("steer");
    expect(a.send.mock.calls[0]).toEqual([expect.objectContaining({ intent: "steer" })]);
    reviewComments.add("c1", note());
    await a.el.submit("queue");
    expect(a.send.mock.calls[1]).toEqual([expect.objectContaining({ intent: "queue" })]);
  });

  it("sends comments as a turn when idle, and queues them while one runs", async () => {
    reviewComments.add("c1", note());
    const idle = await mount();
    await idle.el.sendComments();
    expect(idle.send.mock.calls[0]).toEqual([expect.objectContaining({ intent: "turn" })]);
    document.body.innerHTML = "";
    reviewComments.add("c1", note());
    const busy = await mount({ turns: [], activeTurn: { id: "t" } });
    await busy.el.sendComments();
    expect(busy.send.mock.calls[0]).toEqual([expect.objectContaining({ intent: "queue" })]);
  });

  it("keeps the comments when the send fails, and only the typed words go back in the box", async () => {
    reviewComments.add("c1", note());
    const { el, send } = await mount();
    send.mockResolvedValueOnce("Nope");
    await typeIn(el, "Typed");
    await el.submit("turn");
    expect(reviewComments.list("c1").length).toBe(1);
    expect(el.text).toBe("Typed");
    expect(el.error).toBe("Nope");
  });

  it("doesn't send or clear while blocked", async () => {
    reviewComments.add("c1", note());
    const { el, send } = await mount({ turns: [] }, { blocked: "This work is now ticket #4." });
    await el.sendComments();
    expect(send).not.toHaveBeenCalled();
    expect(reviewComments.list("c1").length).toBe(1);
  });

  it("keeps a comment written while the message was going", async () => {
    reviewComments.add("c1", note());
    const { el, send } = await mount();
    send.mockImplementationOnce(async () => {
      reviewComments.add("c1", note({ text: "written meanwhile" }));
      return null;
    });
    await el.submit("turn");
    expect(reviewComments.list("c1").map((c) => c.text)).toEqual(["written meanwhile"]);
  });

  it("refuses a message the comments push over the limit", async () => {
    reviewComments.add("c1", note());
    const { el, send } = await mount();
    await typeIn(el, "x".repeat(LIMITS.messageChars));
    await el.submit("turn");
    expect(send).not.toHaveBeenCalled();
    expect(reviewComments.list("c1").length).toBe(1);
  });
});

const file = (over: Any = {}) => ({
  state: "ok",
  path: "src/a.ts",
  before: { state: "text", text: "one\ntwo\nthree\n" },
  after: { state: "text", text: "one\n2\nthree\n" },
  ...over,
});
const listing = (over: Any = {}) => ({
  state: "ok",
  noProject: false,
  skipped: 0,
  truncated: false,
  files: [
    { path: "src/a.ts", added: 1, removed: 1, status: "modified" },
    { path: "new.txt", added: 1, removed: 0, status: "added" },
  ],
  ...over,
});

describe("the pane", () => {
  let changes: Any;
  let fileReply: Any;
  let calls: string[];
  let chat: Any;
  let notify: (uris: Set<string>) => void;

  beforeEach(() => {
    changes = listing();
    fileReply = file();
    calls = [];
    chat = { turns: [] };
    notify = () => {};
    setAhp({
      chat: () => chat,
      stop() {},
      onChange: (fn: (u: Set<string>) => void) => {
        notify = fn;
        return () => {};
      },
    } as Any);
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url.includes("/changes/file")) return reply({ file: fileReply });
      if (url.includes("/changes")) return reply({ changes });
      return reply({});
    });
  });

  async function mount(over: Partial<IncConvReview> = {}) {
    const el = document.createElement("inc-conv-review") as IncConvReview;
    el.conv = { id: "c1", ahpChat: CHAT, ahpSession: SESSION } as Any;
    el.name = "Ada";
    Object.assign(el, over);
    document.body.append(el);
    const root = el.shadowRoot as ShadowRoot;
    await until(
      () => root.querySelector(".rows") || root.querySelector(".state") || root.querySelector(".note"),
    );
    await el.updateComplete;
    return { el, root };
  }
  const settle = async (el: IncConvReview) => {
    await until(() => !el.loading && !el.fileLoading);
    await el.updateComplete;
  };

  it("lists the files with counts, and shows the first with line numbers", async () => {
    const { el, root } = await mount();
    await settle(el);
    const rows = [...root.querySelectorAll<HTMLElement>(".f")];
    expect(rows.map((r) => r.dataset.path)).toEqual(["src/a.ts", "new.txt"]);
    expect(rows[0]?.textContent).toContain("edited");
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
    expect(root.querySelector(".sum")?.textContent).toBe("2 files · +2 −1");
    const changed = [...root.querySelectorAll(".row.add, .row.del")].map((r) =>
      r.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(changed).toEqual(["2 − two", "2 + 2"]);
  });

  it("asks for a path with odd characters encoded", async () => {
    changes = listing({ files: [{ path: "a b&c.ts", added: 1, removed: 0, status: "added" }] });
    const { el } = await mount();
    await settle(el);
    expect(calls.some((c) => c.endsWith("/changes/file?path=a%20b%26c.ts"))).toBe(true);
  });

  it("renders what came from the sandbox as text, never as HTML", async () => {
    fileReply = file({ after: { state: "text", text: "<img src=x onerror=alert(1)>\n" } });
    changes = listing({
      files: [{ path: "<b>x</b>.ts", added: 1, removed: 0, status: "added" }],
    });
    const { el, root } = await mount();
    await settle(el);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".f b")).toBeNull();
    expect(root.querySelector(".row.add .text")?.textContent).toContain("<img src=x");
  });

  it("makes bidi and control characters visible", async () => {
    fileReply = file({ after: { state: "text", text: "a‮b\n" } });
    const { el, root } = await mount();
    await settle(el);
    expect(root.querySelector(".row.add .text")?.textContent).toContain("⟨U+202E⟩");
  });

  it("says when the machine is asleep, without asking for a file, and tries again", async () => {
    changes = listing({
      state: "asleep",
      files: [],
      reason: "Ada's machine is asleep, so the changes can't be read right now.",
    });
    const { el, root } = await mount();
    await settle(el);
    expect(root.querySelector(".state")?.textContent).toContain("is asleep");
    expect(calls.some((c) => c.includes("/changes/file"))).toBe(false);
    changes = listing();
    must(root.querySelector<HTMLButtonElement>(".state .cbtn")).click();
    await until(() => root.querySelector(".rows"));
  });

  it("says when the machine is busy", async () => {
    changes = listing({
      state: "busy",
      files: [],
      reason: "Ada's machine is busy, so the changes can't be read right now.",
    });
    const { root } = await mount();
    expect(root.querySelector(".state")?.textContent).toContain("is busy");
    expect(root.querySelector(".state .cbtn")?.textContent).toBe("Try again");
  });

  it("doesn't call a project-less conversation an error", async () => {
    changes = listing({ noProject: true, files: [] });
    const { root } = await mount();
    expect(root.querySelector(".state")?.textContent).toContain("Nothing in this conversation's folder yet.");
    expect(root.querySelector(".state .cbtn")).toBeNull();
  });

  it("says why a file shows no lines, and takes no comment on it", async () => {
    fileReply = file({ before: { state: "binary" }, after: { state: "binary" } });
    const { el, root } = await mount();
    await settle(el);
    expect(root.querySelector(".diff .note")?.textContent).toContain("binary");
    expect(root.querySelector(".row")).toBeNull();
  });

  it("says when a file can't be read, and tries again", async () => {
    fileReply = file({
      state: "asleep",
      reason: "Ada's machine is asleep, so the changes can't be read right now.",
    });
    const { el, root } = await mount();
    await settle(el);
    expect(root.querySelector(".diff .note")?.textContent).toContain("is asleep");
    fileReply = file();
    must(root.querySelector<HTMLButtonElement>(".diff .note .link-btn")).click();
    await until(() => root.querySelector(".rows"));
  });

  it("says what it left out", async () => {
    changes = listing({ skipped: 2, truncated: true });
    const { el, root } = await mount();
    await settle(el);
    const says = [...root.querySelectorAll(".say")].map((s) => s.textContent);
    expect(says).toContain("2 files have a name that isn't safe to show.");
    expect(says).toContain("Only the first 2 files are listed.");
  });

  it("refreshes when a turn ends, not while one runs, and has Refresh", async () => {
    chat = { turns: [], activeTurn: { id: "t" } };
    const { el, root } = await mount();
    await settle(el);
    expect(root.querySelector(".say")?.textContent).toContain("Ada is working");
    const lists = () => calls.filter((c) => c.endsWith("/changes")).length;
    expect(lists()).toBe(1);
    notify(new Set([CHAT]));
    await settle(el);
    expect(lists()).toBe(1);
    chat = { turns: [] };
    notify(new Set([CHAT]));
    await until(() => lists() === 2);
    await settle(el);
    expect(root.querySelector(".say")).toBeNull();
    must(
      [...root.querySelectorAll<HTMLButtonElement>(".head .cbtn")].find((b) => b.textContent === "Refresh"),
    ).click();
    await until(() => lists() === 3);
  });

  it("goes to another file if the open one is gone after a refresh", async () => {
    const { el } = await mount();
    await settle(el);
    expect(el.selected).toBe("src/a.ts");
    changes = listing({ files: [{ path: "new.txt", added: 1, removed: 0, status: "added" }] });
    await el.refresh();
    await settle(el);
    expect(el.selected).toBe("new.txt");
  });

  it("doesn't let a slow answer for one file replace the next", async () => {
    const { el, root } = await mount();
    await settle(el);
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", (url: string) =>
      url.includes("new.txt")
        ? new Promise<Response>((r) => {
            release = r;
          })
        : Promise.resolve(reply({ file: file({ after: { state: "text", text: "second\n" } }) })),
    );
    must(root.querySelector<HTMLElement>('.f[data-path="new.txt"]')).click();
    must(root.querySelector<HTMLElement>('.f[data-path="src/a.ts"]')).click();
    await until(() => root.querySelector(".rows")?.textContent?.includes("second"));
    release(reply({ file: file({ after: { state: "text", text: "stale\n" } }) }));
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    expect(root.querySelector(".rows")?.textContent).not.toContain("stale");
  });

  it("opens at the file it was asked for", async () => {
    const { el } = await mount({ path: "new.txt" });
    await settle(el);
    expect(el.selected).toBe("new.txt");
    expect(el.reading).toBe(true);
  });

  it("opens at no file on a phone: the list comes first", async () => {
    const { el, root } = await mount({ phone: true });
    await settle(el);
    expect(el.selected).toBeNull();
    expect(calls.some((c) => c.includes("/changes/file"))).toBe(false);
    must(root.querySelector<HTMLElement>(".f")).click();
    await settle(el);
    expect(root.querySelector(".body")?.classList.contains("reading")).toBe(true);
  });

  async function commentOn(root: ShadowRoot, el: IncConvReview, row: string, text: string) {
    must(root.querySelector<HTMLElement>(`${row} .no`)).click();
    await el.updateComplete;
    const ta = root.querySelector(".box textarea") as HTMLTextAreaElement;
    ta.value = text;
    must(root.querySelector<HTMLButtonElement>(".box .primary")).click();
    await el.updateComplete;
  }

  it("takes a comment on an added line, with its new number and the quoted line", async () => {
    const { el, root } = await mount();
    await settle(el);
    await commentOn(root, el, ".row.add", "Spell it out");
    expect(reviewComments.list("c1")).toEqual([
      expect.objectContaining({ path: "src/a.ts", line: 2, side: "new", quote: "2", text: "Spell it out" }),
    ]);
    expect(root.querySelector(".box")).toBeNull();
    expect(root.querySelector(".under .c p")?.textContent).toBe("Spell it out");
    expect(root.querySelector("#h-comments")?.textContent).toBe("Comments · 1");
    expect(root.querySelector(".f small")?.textContent).toContain("1 comment");
  });

  it("numbers a comment on a removed line as it was", async () => {
    const { el, root } = await mount();
    await settle(el);
    await commentOn(root, el, ".row.del", "Why?");
    expect(reviewComments.list("c1")[0]).toMatchObject({ line: 2, side: "old", quote: "two" });
    expect(root.querySelector(".under .where")?.textContent).toBe("Removed line 2");
    expect(root.querySelector(".side .where")?.textContent).toBe("src/a.ts:2 (removed)");
  });

  it("doesn't add an empty comment", async () => {
    const { el, root } = await mount();
    await settle(el);
    await commentOn(root, el, ".row.add", "   ");
    expect(reviewComments.list("c1")).toEqual([]);
  });

  it("never sends a comment anywhere by writing it", async () => {
    const { el, root } = await mount();
    await settle(el);
    const before = calls.length;
    await commentOn(root, el, ".row.add", "Private");
    expect(calls.length).toBe(before);
  });

  it("lists comments, removes them, and keeps them across a remount", async () => {
    const { el, root } = await mount();
    await settle(el);
    await commentOn(root, el, ".row.add", "Keep");
    el.remove();
    const again = await mount();
    await settle(again.el);
    expect(again.root.querySelector("#h-comments")?.textContent).toBe("Comments · 1");
    must(again.root.querySelector<HTMLButtonElement>(".side .rm")).click();
    await again.el.updateComplete;
    expect(reviewComments.list("c1")).toEqual([]);
    expect(again.root.querySelector("#h-comments")).toBeNull();
  });

  it("offers Send comments, or Queue comments while a turn runs", async () => {
    reviewComments.add("c1", note());
    const { el, root } = await mount();
    await settle(el);
    const seen = vi.fn();
    el.addEventListener("conv-send-comments", seen);
    const send = must(root.querySelector<HTMLButtonElement>(".send .cbtn"));
    expect(send.textContent).toBe("Send comments");
    send.click();
    expect(seen).toHaveBeenCalledTimes(1);
    el.running = true;
    await el.updateComplete;
    expect(root.querySelector(".send .cbtn")?.textContent).toBe("Queue comments");
  });

  it("closes on Escape, but a comment box takes Escape first", async () => {
    const { el, root } = await mount();
    await settle(el);
    const closed = vi.fn();
    el.addEventListener("conv-review-close", closed);
    must(root.querySelector<HTMLElement>(".row.add .no")).click();
    await el.updateComplete;
    const esc = () =>
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true });
    must(root.querySelector("textarea")).dispatchEvent(esc());
    await el.updateComplete;
    expect(root.querySelector(".box")).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    document.dispatchEvent(esc());
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe("the context panel", () => {
  it("keeps its Files changed list, and links into the pane at a file and as a whole", async () => {
    const chat = {
      turns: [
        {
          id: "t1",
          responseParts: [
            {
              kind: "toolCall",
              toolCall: {
                toolCallId: "e",
                status: "completed",
                success: true,
                content: [
                  {
                    type: "fileEdit",
                    after: {
                      uri: "file:///home/employee/work/conv-ab12cd34/src/a.ts",
                      content: { uri: "u" },
                    },
                    diff: { added: 1, removed: 0 },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    setAhp({
      chat: () => chat,
      session: () => undefined,
      readContent: async () => ({ text: "" }),
      onChange: () => () => {},
      stop() {},
    } as Any);
    const ctx = document.createElement("inc-conv-context") as Any;
    ctx.conv = {
      id: "ab12cd34",
      employeeId: "ada",
      project: null,
      ahpChat: CHAT,
      ahpSession: SESSION,
      engineId: "opus",
    };
    const seen: Any[] = [];
    ctx.addEventListener("conv-review", (e: CustomEvent) => seen.push(e.detail));
    document.body.append(ctx);
    await ctx.updateComplete;
    const panel = ctx.shadowRoot as ShadowRoot;
    const row = must(panel.querySelector<HTMLElement>(".f-row"));
    expect(row.textContent).toContain("src/a.ts");
    must(panel.querySelector<HTMLElement>(".to-review")).click();
    expect(seen).toEqual([{ from: "context" }]);
    row.click();
    await ctx.updateComplete;
    const open = [...panel.querySelectorAll<HTMLElement>(".link-btn")].find(
      (b) => b.textContent === "Open in Changes",
    );
    must(open).click();
    expect(seen[1]).toEqual({ from: "context", path: "src/a.ts" });
    expect(panel.querySelector("inc-conv-diff")).not.toBeNull();
  });
});

describe("the screen around it", () => {
  const conv: Any = {
    id: "ab12cd34",
    employeeId: "ada",
    project: null,
    branch: null,
    title: "Greeting",
    mode: null,
    engineId: "opus",
    createdAt: 0,
    archivedAt: null,
    ahpSession: SESSION,
    ahpChat: CHAT,
    status: 1,
    needsYou: false,
    running: false,
    modifiedAt: 1,
  };

  async function mount() {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: /min-width: 1200px/.test(q),
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/changes/file")) return reply({ file: file() });
      if (url.includes("/changes")) return reply({ changes: listing() });
      if (url.includes("/api/conversations")) return reply({ conversations: [conv] });
      if (url.includes("/api/employees"))
        return reply({ employees: [{ id: "ada", name: "Ada", role: "Engineer", tint: 0 }] });
      if (url.includes("/api/projects")) return reply({ projects: [] });
      if (url.includes("/api/engines")) return reply({ engines: [] });
      return reply({});
    });
    const h = hosts();
    const c = new AhpConnection({
      connect: h.connect,
      clientId: "me",
      backoff: () => 5,
      pingMs: 0,
      schedule: (fn) => {
        queueMicrotask(fn);
        return () => {};
      },
    });
    setAhp(c);
    const el = document.createElement("inc-conversations") as IncConversations;
    el.selectedId = conv.id;
    document.body.append(el);
    const root = () => el.shadowRoot as ShadowRoot;
    await until(() => root().querySelector("inc-conv-thread") && c.chat(CHAT));
    const thread = must(root().querySelector("inc-conv-thread"));
    await (thread as Any).updateComplete;
    const button = () => must(thread.shadowRoot?.querySelector<HTMLButtonElement>(".changes-btn"));
    return { el, root, thread, button };
  }

  it("opens from the header over the thread and panel, and leaves the thread in place", async () => {
    const { el, root, thread, button } = await mount();
    button().click();
    await el.updateComplete;
    await until(() => root().querySelector("inc-conv-review"));
    expect(root().querySelector("inc-conv-thread")).toBe(thread);
    const pane = must(root().querySelector(".thread-pane"));
    expect(pane.classList.contains("under")).toBe(true);
    expect(pane.hasAttribute("inert")).toBe(true);
    expect(root().querySelector(".list-pane")?.hasAttribute("inert")).toBe(false);
  });

  it("gives focus to the pane, and back to the button when it closes", async () => {
    const { el, root, thread, button } = await mount();
    button().click();
    await until(() => root().querySelector("inc-conv-review")?.shadowRoot?.activeElement);
    const review = must(root().querySelector<IncConvReview>("inc-conv-review"));
    expect(review.shadowRoot?.activeElement?.getAttribute("aria-label")).toBe("Close changes");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await until(() => !root().querySelector("inc-conv-review"));
    await el.updateComplete;
    await until(() => thread.shadowRoot?.activeElement === button());
    expect(root().querySelector(".thread-pane")?.classList.contains("under")).toBe(false);
  });

  it("closes when another conversation is opened", async () => {
    const { el, root, button } = await mount();
    button().click();
    await until(() => root().querySelector("inc-conv-review"));
    el.selectedId = "other";
    await el.updateComplete;
    expect(root().querySelector("inc-conv-review")).toBeNull();
  });

  it("goes back to the thread and sends through the composer on Send comments", async () => {
    reviewComments.add(conv.id, note());
    const { root, thread, button } = await mount();
    button().click();
    await until(() => root().querySelector("inc-conv-review"));
    const review = must(root().querySelector<IncConvReview>("inc-conv-review"));
    await until(() => review.shadowRoot?.querySelector(".send .cbtn"));
    const composer = must(thread.shadowRoot?.querySelector("inc-conv-composer")) as IncConvComposer;
    const sent = vi.spyOn(composer, "sendComments");
    must(review.shadowRoot?.querySelector<HTMLButtonElement>(".send .cbtn")).click();
    await until(() => !root().querySelector("inc-conv-review"));
    await until(() => sent.mock.calls.length === 1);
  });

  it("the composer's Review opens the pane", async () => {
    reviewComments.add(conv.id, note());
    const { root, thread } = await mount();
    const composer = must(thread.shadowRoot?.querySelector("inc-conv-composer")) as IncConvComposer;
    await composer.updateComplete;
    must(composer.shadowRoot?.querySelector<HTMLButtonElement>(".going .link-btn")).click();
    await until(() => root().querySelector("inc-conv-review"));
  });

  it("opens at the file a link in the context panel names", async () => {
    const { root } = await mount();
    const ctx = must(root().querySelector("inc-conv-context"));
    ctx.dispatchEvent(
      new CustomEvent("conv-review", {
        detail: { from: "context", path: "src/a.ts" },
        bubbles: true,
        composed: true,
      }),
    );
    await until(() => root().querySelector("inc-conv-review"));
    expect((root().querySelector("inc-conv-review") as IncConvReview).path).toBe("src/a.ts");
  });
});
