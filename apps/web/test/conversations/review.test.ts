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
  anchor,
  COMMENTS_CAP,
  commentDrafts,
  commentsBlock,
  fileNote,
  holdsComments,
  isCommand,
  type LineComment,
  quoteOf,
  reviewComments,
  withComments,
} from "../../src/conversations/review.ts";
import { draftKey, draftMemo } from "../../src/drafts.ts";
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

  it("keeps a day's comments through a reload, far past a draft's size", () => {
    for (let i = 0; i < 6; i++) reviewComments.add("c1", note({ text: "x".repeat(3999) }));
    expect(JSON.parse(localStorage.getItem("inc.chat.draft.comments:c1") ?? "[]").length).toBe(6);
    expect(reviewComments.unsaved("c1")).toBe(0);
  });

  it("keeps the ones that fit when the list outgrows storage, says how many won't last, and forgets all at sign-out", () => {
    const n = Math.ceil(COMMENTS_CAP / 4000) + 3;
    for (let i = 0; i < n; i++) reviewComments.add("c1", note({ text: "x".repeat(4000) }));
    expect(reviewComments.list("c1").length).toBe(n);
    const kept = JSON.parse(localStorage.getItem("inc.chat.draft.comments:c1") ?? "[]");
    expect(kept.length).toBeGreaterThan(40);
    expect(reviewComments.unsaved("c1")).toBe(n - kept.length);
    reviewComments.add("c2", note());
    draftMemo.clearAll();
    expect(reviewComments.list("c1")).toEqual([]);
    expect(reviewComments.list("c2")).toEqual([]);
  });

  it("hears another tab send or add comments", () => {
    const heard: string[] = [];
    const off = reviewComments.subscribe((id) => heard.push(id));
    dispatchEvent(new StorageEvent("storage", { key: draftKey("comments:c9") }));
    dispatchEvent(new StorageEvent("storage", { key: draftKey("conv:c9") }));
    dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    off();
    expect(heard).toEqual(["c9"]);
  });

  it("caps a long quoted line", () => {
    expect(reviewComments.add("c1", note({ quote: "q".repeat(5000) })).quote.length).toBeLessThan(310);
  });
});

describe("a comment being written", () => {
  const at = { path: "a.ts", line: 3, side: "new" as const, quote: "x" };

  it("lasts until it is dropped, and a second start doesn't empty it", () => {
    commentDrafts.start("c1", at);
    commentDrafts.write("c1", at, "half a thought");
    commentDrafts.start("c1", at);
    commentDrafts.start("c1", { ...at, line: 4 });
    expect(commentDrafts.list("c1").map((d) => d.text)).toEqual(["half a thought", ""]);
    commentDrafts.drop("c1", at);
    expect(commentDrafts.list("c1").map((d) => d.line)).toEqual([4]);
  });

  it("is stored while it has words in it, and goes at sign-out", () => {
    commentDrafts.start("c1", at);
    expect(localStorage.getItem(draftKey("comment-drafts:c1"))).toBeNull();
    commentDrafts.write("c1", at, "kept");
    expect(localStorage.getItem(draftKey("comment-drafts:c1"))).toContain("kept");
    draftMemo.clearAll();
    expect(commentDrafts.list("c1")).toEqual([]);
  });
});

describe("where a comment sits", () => {
  const rows = [
    { kind: "ctx", text: "  alpha", oldNo: 1, newNo: 1 },
    { kind: "gap", count: 4 },
    { kind: "del", text: "beta", oldNo: 6 },
    { kind: "add", text: "gamma", newNo: 6 },
  ] as Any;
  const c = (line: number, side: "new" | "old", quote: string) => ({ path: "a", line, side, quote });

  it("is its line while that line reads as it quoted it", () => {
    const r = anchor(rows, [c(1, "new", "alpha"), c(6, "old", "beta"), c(6, "new", "gamma")]);
    expect([...r.at.keys()]).toEqual([0, 2, 3]);
    expect(r.moved).toEqual([]);
  });

  it("is nowhere once the line reads otherwise or has gone", () => {
    const r = anchor(rows, [c(1, "new", "omega"), c(6, "old", "gamma"), c(90, "new", "alpha")]);
    expect(r.at.size).toBe(0);
    expect(r.moved.length).toBe(3);
  });

  it("matches a line too long to quote whole", () => {
    const long = "y".repeat(5000);
    const r = anchor([{ kind: "ctx", text: long, oldNo: 1, newNo: 1 }] as Any, [c(1, "new", quoteOf(long))]);
    expect(r.moved).toEqual([]);
  });
});

describe("what counts as a command", () => {
  it("is a slash and a word at the start, not a path", () => {
    expect(isCommand("/remember")).toBe(true);
    expect(isCommand("  /remember the build")).toBe(true);
    expect(isCommand("/plugin:do x")).toBe(true);
    expect(isCommand("/usr/bin/env is broken")).toBe(false);
    expect(isCommand("please /remember")).toBe(false);
    expect(isCommand("")).toBe(false);
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

  it("doesn't let a second steer displace comments that went as the first", async () => {
    const chat = {
      turns: [],
      activeTurn: { id: "t" },
      steeringMessage: { id: "s", message: { text: withComments("", [note() as LineComment]) } },
    };
    reviewComments.add("c1", note({ text: "written since" }));
    const { el, send } = await mount(chat);
    await typeIn(el, "also fix the tests");
    await el.submit("steer");
    expect(send.mock.calls[0]).toEqual([
      expect.objectContaining({ intent: "queue", text: expect.stringContaining("written since") }),
    ]);
    expect(reviewComments.list("c1")).toEqual([]);
  });

  it("leaves comments out of a command, and says they wait", async () => {
    reviewComments.add("c1", note());
    const { el, send, root } = await mount();
    await typeIn(el, "/remember");
    expect(root.querySelector(".going")?.textContent).toContain("1 comment waits for your next message");
    await el.submit("turn");
    expect(send.mock.calls[0]).toEqual([{ text: "/remember", files: [], intent: "turn" }]);
    expect(reviewComments.list("c1").length).toBe(1);
  });

  it("takes comments out of the conversation they went from, whatever is open by then", async () => {
    const a = reviewComments.add("c1", note());
    const other = reviewComments.add("c2", note({ text: "other" }));
    const { el, send } = await mount();
    send.mockImplementationOnce(async () => {
      el.conversationId = "c2";
      await el.updateComplete;
      return null;
    });
    await el.submit("turn");
    expect(reviewComments.list("c1").map((c) => c.id)).not.toContain(a.id);
    expect(reviewComments.list("c2").map((c) => c.id)).toEqual([other.id]);
  });

  it("drops what another tab already sent", async () => {
    const a = reviewComments.add("c1", note());
    const { el, send, root } = await mount();
    localStorage.removeItem(draftKey("comments:c1"));
    await el.submit("turn");
    expect(send).not.toHaveBeenCalled();
    dispatchEvent(new StorageEvent("storage", { key: draftKey("comments:c1") }));
    await el.updateComplete;
    expect(root.querySelector(".going")).toBeNull();
    expect(reviewComments.list("c1").map((c) => c.id)).not.toContain(a.id);
  });

  it("sends the comments alone from the pane, leaving what is in the box where it is", async () => {
    reviewComments.add("c1", note());
    const { el, send } = await mount();
    await typeIn(el, "half a draft");
    await el.sendComments();
    expect(send.mock.calls[0]).toEqual([
      {
        text: "Comments on the changes:\n\nsrc/a.ts:3\n> const a = 1;\nName this better.",
        files: [],
        intent: "turn",
      },
    ]);
    expect(el.text).toBe("half a draft");
    expect(reviewComments.list("c1")).toEqual([]);
  });

  it("does nothing on Send comments with no comments", async () => {
    const { el, send } = await mount();
    await typeIn(el, "half a draft");
    await el.sendComments();
    expect(send).not.toHaveBeenCalled();
  });

  it("gives queued comments back to the box when their message is removed, and only then", async () => {
    const text = withComments("", [reviewComments.add("x", note())]);
    const chat = {
      turns: [],
      activeTurn: { id: "t" },
      queuedMessages: [
        { id: "q1", message: { text } },
        { id: "q2", message: { text: "plain" } },
      ],
    };
    const { el, root } = await mount(chat);
    const seen: Any[] = [];
    el.addEventListener("conv-unqueue", (e) => seen.push((e as CustomEvent).detail));
    const buttons = () => [...root.querySelectorAll<HTMLButtonElement>(".queue .icon")];
    must(buttons()[1]).click();
    await el.updateComplete;
    expect(el.text).toBe("");
    must(buttons()[0]).click();
    await el.updateComplete;
    expect(el.text).toBe(text);
    expect(seen.map((d) => d.id)).toEqual(["q2", "q1"]);
    expect(holdsComments(text)).toBe(true);
    expect(holdsComments("plain")).toBe(false);
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

  it("doesn't call it nothing when every change has a name it won't show", async () => {
    changes = listing({ files: [], skipped: 1 });
    const a = await mount();
    await settle(a.el);
    expect(a.root.querySelector(".state p")?.textContent).toBe("1 file has a name that isn't safe to show.");
    a.el.remove();
    changes = listing({ files: [], skipped: 2, noProject: true });
    const b = await mount();
    await settle(b.el);
    expect(b.root.querySelector(".state p")?.textContent).toBe(
      "2 files have a name that isn't safe to show.",
    );
    b.el.remove();
    changes = listing({ files: [], skipped: 1, partial: true });
    const c = await mount();
    await settle(c.el);
    expect(c.root.querySelector(".state p")?.textContent).toBe(
      "1 file has a name that isn't safe to show. Some files couldn't be read, so this may not be everything.",
    );
  });

  it("refreshes when a turn ends, not while one runs, and has Refresh", async () => {
    chat = { turns: [], activeTurn: { id: "t", responseParts: [] } };
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

  async function typeAt(el: IncConvReview, root: ShadowRoot, row: string, text: string) {
    must(root.querySelector<HTMLElement>(`${row} .no`)).click();
    await el.updateComplete;
    const ta = root.querySelector(
      `[data-box="${el.selected}|${row.endsWith("del") ? "old" : "new"}-2"] textarea`,
    ) as HTMLTextAreaElement;
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
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

  it("leaves the code to be selected: only a line's number opens a box", async () => {
    const { el, root } = await mount();
    await settle(el);
    must(root.querySelector<HTMLElement>(".row.add .text")).click();
    must(root.querySelector<HTMLElement>(".row.add .sign")).click();
    await el.updateComplete;
    expect(root.querySelector(".box")).toBeNull();
    must(root.querySelector<HTMLElement>(".row.add .no")).click();
    await el.updateComplete;
    expect(root.querySelector(".box")).not.toBeNull();
  });

  it("keeps a half-written comment when another line is picked", async () => {
    const { el, root } = await mount();
    await settle(el);
    await typeAt(el, root, ".row.add", "half written thought");
    must(root.querySelector<HTMLElement>(".row.del .no")).click();
    await el.updateComplete;
    const boxes = [...root.querySelectorAll<HTMLTextAreaElement>(".box textarea")];
    expect(boxes.map((b) => b.value)).toEqual(["", "half written thought"]);
    await until(() => root.activeElement === boxes[0]);
  });

  it("keeps a half-written comment across another file, and closing the pane", async () => {
    const { el, root } = await mount();
    await settle(el);
    await typeAt(el, root, ".row.add", "half written thought");
    must(root.querySelector<HTMLElement>('.f[data-path="new.txt"]')).click();
    await settle(el);
    expect(root.querySelector(".box")).toBeNull();
    must(root.querySelector<HTMLElement>('.f[data-path="src/a.ts"]')).click();
    await settle(el);
    await until(() => root.querySelector(".box"));
    expect(root.querySelector<HTMLTextAreaElement>(".box textarea")?.value).toBe("half written thought");
    el.remove();
    const again = await mount();
    await settle(again.el);
    await until(() => again.root.querySelector(".box"));
    expect(again.root.querySelector<HTMLTextAreaElement>(".box textarea")?.value).toBe(
      "half written thought",
    );
  });

  it("asks before Escape or Cancel throws words away, and Escape then keeps them", async () => {
    const { el, root } = await mount();
    await settle(el);
    const closed = vi.fn();
    el.addEventListener("conv-review-close", closed);
    await typeAt(el, root, ".row.add", "worth keeping");
    const esc = () =>
      must(root.querySelector("textarea")).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }),
      );
    esc();
    await el.updateComplete;
    expect(root.querySelector(".box .acts p")?.textContent).toBe("Discard this comment?");
    await until(() => root.activeElement === root.querySelector(".box .keep"));
    esc();
    await el.updateComplete;
    expect(root.querySelector(".box .acts p")).toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>(".box textarea")?.value).toBe("worth keeping");
    await until(() => root.activeElement === root.querySelector(".box textarea"));
    const button = (name: string) =>
      must([...root.querySelectorAll<HTMLElement>(".box .cbtn")].find((b) => b.textContent === name));
    button("Cancel").click();
    await el.updateComplete;
    button("Discard").click();
    await el.updateComplete;
    expect(root.querySelector(".box")).toBeNull();
    expect(commentDrafts.list("c1")).toEqual([]);
    expect(closed).not.toHaveBeenCalled();
    await until(() => root.activeElement === root.querySelector(".row.add .no"));
  });

  it("goes by the box's own file when another file has a box on the same line number", async () => {
    const { el, root } = await mount();
    await settle(el);
    must(root.querySelector<HTMLElement>(".row.add .no")).click();
    await el.updateComplete;
    must(root.querySelector<HTMLElement>('.f[data-path="new.txt"]')).click();
    await settle(el);
    await typeAt(el, root, ".row.add", "worth keeping");
    const esc = () =>
      must(root.querySelector("textarea")).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }),
      );
    esc();
    await el.updateComplete;
    expect(root.querySelector(".box .acts p")?.textContent).toBe("Discard this comment?");
    expect(commentDrafts.list("c1").find((d) => d.path === "new.txt")?.text).toBe("worth keeping");
    // the other way round: the empty box has nothing to ask about
    must(root.querySelector<HTMLElement>('.f[data-path="src/a.ts"]')).click();
    await settle(el);
    esc();
    await el.updateComplete;
    expect(root.querySelector(".box")).toBeNull();
    expect(commentDrafts.list("c1").map((d) => d.path)).toEqual(["new.txt"]);
  });

  it("closes an empty box with no question", async () => {
    const { el, root } = await mount();
    await settle(el);
    must(root.querySelector<HTMLElement>(".row.add .no")).click();
    await el.updateComplete;
    must(
      [...root.querySelectorAll<HTMLElement>(".box .cbtn")].find((b) => b.textContent === "Cancel"),
    ).click();
    await el.updateComplete;
    expect(root.querySelector(".box")).toBeNull();
  });

  it("marks a comment whose line has changed, and doesn't put it under what took the number", async () => {
    const { el, root } = await mount();
    await settle(el);
    await commentOn(root, el, ".row.add", "about this one");
    fileReply = file({ after: { state: "text", text: "added\nabove\none\n2\nthree\n" } });
    await el.refresh();
    await settle(el);
    expect(root.querySelector(".rows .under .c")).toBeNull();
    expect(root.querySelector(".moved")?.textContent).toContain("This line has changed");
    expect(root.querySelector(".moved blockquote")?.textContent).toBe("2");
    expect(root.querySelector(".moved p:last-child")?.textContent).toBe("about this one");
  });

  it("keeps a box whose line has changed, with its words", async () => {
    const { el, root } = await mount();
    await settle(el);
    await typeAt(el, root, ".row.add", "still mine");
    fileReply = file({ after: { state: "text", text: "changed\nentirely\n" } });
    await el.refresh();
    await settle(el);
    expect(root.querySelector<HTMLTextAreaElement>(".moved .box textarea")?.value).toBe("still mine");
    must(root.querySelector<HTMLButtonElement>(".moved .box .primary")).click();
    await el.updateComplete;
    expect(reviewComments.list("c1")[0]).toMatchObject({ line: 2, quote: "2", text: "still mine" });
  });

  it("keeps a comment and a box in reach when their file now shows a note, not lines", async () => {
    const { el, root } = await mount();
    await settle(el);
    await commentOn(root, el, ".row.add", "about this one");
    await typeAt(el, root, ".row.add", "still mine");
    fileReply = file({ after: { state: "binary" } });
    await el.refresh();
    await settle(el);
    expect(root.querySelector(".diff .note")?.textContent).toContain("binary");
    expect(root.querySelector(".moved p:last-child")?.textContent).toBe("about this one");
    expect(root.querySelector<HTMLTextAreaElement>(".moved .box textarea")?.value).toBe("still mine");
  });

  it("goes to a comment on a file that now shows a note", async () => {
    const { el, root } = await mount();
    await settle(el);
    await commentOn(root, el, ".row.add", "about this one");
    fileReply = file({ after: { state: "too-big" } });
    await el.refresh();
    await settle(el);
    must(root.querySelector<HTMLButtonElement>(".side .where")).click();
    await until(() => root.activeElement?.matches(".moved .c"));
  });

  it("keeps a way to a half-written comment on a file that left the list", async () => {
    const { el, root } = await mount();
    await settle(el);
    await typeAt(el, root, ".row.add", "still mine");
    changes = listing({ files: [{ path: "other.ts", added: 1, removed: 0, status: "modified" }] });
    await el.refresh();
    await settle(el);
    expect(root.querySelector(".box")).toBeNull();
    const link = must(root.querySelector<HTMLButtonElement>(".stray"));
    expect(link.textContent).toBe("src/a.ts:2");
    fileReply = file({ before: { state: "none" }, after: { state: "none" } });
    link.click();
    await settle(el);
    expect(root.querySelector<HTMLTextAreaElement>(".moved .box textarea")?.value).toBe("still mine");
  });

  it("keeps a half-written comment in reach, to finish or discard, when the list empties", async () => {
    const { el, root } = await mount();
    await settle(el);
    await typeAt(el, root, ".row.add", "still mine");
    changes = listing({ files: [] });
    await el.refresh();
    await settle(el);
    expect(root.querySelector(".state")?.textContent).toContain("Nothing has changed yet.");
    expect(root.querySelector("#h-unfinished")?.textContent).toBe("Unfinished comments · 1");
    const ta = root.querySelector(".side .box textarea") as HTMLTextAreaElement;
    expect(ta.value).toBe("still mine");
    expect(ta.getAttribute("aria-label")).toBe("Comment on src/a.ts line 2");
    expect(root.querySelector(".side .where")?.textContent).toBe("src/a.ts:2");
    must(root.querySelector<HTMLButtonElement>(".side .box .primary")).click();
    await el.updateComplete;
    expect(reviewComments.list("c1").map((c) => c.text)).toEqual(["still mine"]);
    expect(commentDrafts.list("c1")).toEqual([]);
    expect(root.querySelector("#h-unfinished")).toBeNull();
    expect(root.querySelector("#h-comments")?.textContent).toBe("Comments · 1");
  });

  it("keeps it in reach when the machine is asleep, and asks before it goes", async () => {
    const { el, root } = await mount();
    await settle(el);
    await typeAt(el, root, ".row.add", "still mine");
    el.remove();
    changes = listing({
      state: "asleep",
      files: [],
      reason: "Ada's machine is asleep, so the changes can't be read right now.",
    });
    const again = await mount();
    await settle(again.el);
    const button = (name: string) =>
      must([...again.root.querySelectorAll<HTMLElement>(".box .cbtn")].find((b) => b.textContent === name));
    expect(again.root.querySelector(".state")?.textContent).toContain("is asleep");
    expect(again.root.querySelector<HTMLTextAreaElement>(".side .box textarea")?.value).toBe("still mine");
    button("Cancel").click();
    await again.el.updateComplete;
    expect(again.root.querySelector(".box .acts p")?.textContent).toBe("Discard this comment?");
    button("Discard").click();
    await again.el.updateComplete;
    expect(commentDrafts.list("c1")).toEqual([]);
    expect(again.root.querySelector(".side")).toBeNull();
  });

  it("asks about one box at a time when two files have one on the same line number", async () => {
    const at = { line: 2, side: "new" as const, quote: "2" };
    for (const path of ["a.ts", "b.ts"]) {
      commentDrafts.start("c1", { ...at, path });
      commentDrafts.write("c1", { ...at, path }, `on ${path}`);
    }
    changes = listing({ files: [] });
    const { el, root } = await mount();
    await settle(el);
    const boxes = [...root.querySelectorAll<HTMLElement>(".box")];
    expect(boxes.length).toBe(2);
    must(
      [...(boxes[1] as HTMLElement).querySelectorAll<HTMLElement>(".cbtn")].find(
        (b) => b.textContent === "Cancel",
      ),
    ).click();
    await el.updateComplete;
    const asked = [...root.querySelectorAll(".box .acts p")];
    expect(asked.length).toBe(1);
    expect(asked[0]?.closest<HTMLElement>(".box")?.dataset.box).toBe("b.ts|new-2");
    await until(() => root.activeElement === root.querySelectorAll(".box")[1]?.querySelector(".keep"));
  });

  it("shows a written comment past the cut when its file opens again", async () => {
    const before = `${Array.from({ length: 1400 }, (_, i) => `old ${i + 1}`).join("\n")}\n`;
    const after = `${Array.from({ length: 1400 }, (_, i) => `new ${i + 1}`).join("\n")}\n`;
    fileReply = file({
      before: { state: "text", text: before },
      after: { state: "text", text: after },
    });
    const place = { path: "src/a.ts", line: 1200, side: "new" as const, quote: "new 1200" };
    commentDrafts.start("c1", place);
    commentDrafts.write("c1", place, "far down");
    const { el, root } = await mount();
    await settle(el);
    expect(el.showAll).toBe(true);
    expect(root.querySelector<HTMLTextAreaElement>(".rows .box textarea")?.value).toBe("far down");
    expect(root.querySelector(".more")).toBeNull();
    // An empty box says nothing is waiting, and a long diff stays cut
    commentDrafts.write("c1", place, "");
    el.remove();
    const again = await mount();
    await settle(again.el);
    expect(again.el.showAll).toBe(false);
    expect(again.root.querySelector(".more")).not.toBeNull();
  });

  it("doesn't drop focus when a file's Try again is replaced by the file", async () => {
    fileReply = file({
      state: "asleep",
      reason: "Ada's machine is asleep, so the changes can't be read right now.",
    });
    const { el, root } = await mount();
    await settle(el);
    must(root.querySelector<HTMLButtonElement>(".diff .note .link-btn")).focus();
    fileReply = file();
    must(root.querySelector<HTMLButtonElement>(".diff .note .link-btn")).click();
    await until(() => root.activeElement?.matches(".rows"));
  });

  it("says apart a removed line and an added one with the same number, in the box too", async () => {
    const { el, root } = await mount();
    await settle(el);
    const del = must(root.querySelector<HTMLElement>(".row.del .no"));
    const add = must(root.querySelector<HTMLElement>(".row.add .no"));
    expect(del.getAttribute("aria-label")).toBe("Comment on removed line 2");
    expect(add.getAttribute("aria-label")).toBe("Comment on line 2");
    del.click();
    await el.updateComplete;
    expect(root.querySelector("textarea")?.getAttribute("aria-label")).toBe("Comment on removed line 2");
    expect(root.querySelector(".row.add .sign")?.getAttribute("role")).toBe("img");
    expect(root.querySelector(".row.add .sign")?.getAttribute("aria-label")).toBe("added");
    expect(root.querySelector(".row.ctx .sign")?.hasAttribute("role")).toBe(false);
  });

  it("keeps focus in the list when a comment is removed", async () => {
    const { el, root } = await mount();
    await settle(el);
    await commentOn(root, el, ".row.add", "first");
    await commentOn(root, el, ".row.del", "second");
    const side = () => [...root.querySelectorAll<HTMLElement>(".side .rm")];
    must(side()[0]).focus();
    must(side()[0]).click();
    await until(() => reviewComments.list("c1").length === 1);
    await el.updateComplete;
    await until(() => root.activeElement?.classList.contains("rm"));
    (root.activeElement as HTMLElement).click();
    await until(() => !root.querySelector(".rm"));
    await until(() => root.activeElement === root.querySelector('.f[aria-current="true"]'));
  });

  it("goes to a comment's line, past the cut if need be", async () => {
    const text = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
    fileReply = file({ before: { state: "none" }, after: { state: "text", text: text(1500) } });
    const { el, root } = await mount();
    await settle(el);
    reviewComments.add("c1", note({ line: 1300, quote: "line 1300" }));
    await el.updateComplete;
    must(root.querySelector<HTMLElement>(".side .where")).click();
    await until(() => root.activeElement === root.querySelector('[data-at="new-1300"] .no'));
    expect(el.showAll).toBe(true);
    await el.updateComplete;
    const rows = must(root.querySelector<HTMLElement>(".rows"));
    const line = must(root.querySelector<HTMLElement>('[data-at="new-1300"] .no'));
    Object.defineProperty(rows, "scrollTop", { value: 0, writable: true });
    vi.spyOn(rows, "getBoundingClientRect").mockReturnValue({ top: 0, height: 400 } as DOMRect);
    vi.spyOn(line, "getBoundingClientRect").mockReturnValue({ top: 2000, height: 20 } as DOMRect);
    must(root.querySelector<HTMLElement>(".side .where")).click();
    await until(() => rows.scrollTop === 1810);
  });

  it("offers no link to a line with no diff to go to", async () => {
    reviewComments.add("c1", note());
    changes = listing({ state: "asleep", files: [], reason: "Asleep." });
    const { el, root } = await mount();
    await settle(el);
    expect(root.querySelector(".side button.where")).toBeNull();
    expect(root.querySelector(".side .where")?.textContent).toBe("src/a.ts:3");
    expect(root.querySelector(".side blockquote")?.textContent).toBe("const a = 1;");
  });

  it("goes to a comment above the diff when its line has changed", async () => {
    reviewComments.add("c1", note({ path: "new.txt", line: 40, quote: "long gone" }));
    const { el, root } = await mount();
    await settle(el);
    must(root.querySelector<HTMLElement>(".side .where")).click();
    await settle(el);
    await until(() => root.activeElement === root.querySelector("[data-moved]"));
    expect(el.selected).toBe("new.txt");
  });

  it("says when a read couldn't reach every file, and doesn't call that nothing", async () => {
    changes = listing({ partial: true, files: [] });
    const first = await mount();
    expect(first.root.querySelector(".state")?.textContent).toContain("Some files couldn't be read");
    expect(first.root.querySelector(".state")?.textContent).not.toContain("Nothing has changed");
    expect(first.root.querySelector(".state .cbtn")?.textContent).toBe("Try again");
    first.el.remove();
    changes = listing({ partial: true });
    const { el, root } = await mount();
    await settle(el);
    expect([...root.querySelectorAll(".say")].map((s) => s.textContent)).toContain(
      "Some files couldn't be read, so this may not be everything.",
    );
  });

  it("says how many comments a reload would lose", async () => {
    const n = Math.ceil(COMMENTS_CAP / 4000) + 2;
    for (let i = 0; i < n; i++) reviewComments.add("c1", note({ text: "x".repeat(4000) }));
    const { el, root } = await mount();
    await settle(el);
    expect(root.querySelector(".side section .say")?.textContent).toContain(
      "too much to keep through a reload",
    );
  });

  it("keeps the diff, the comments and Send comments when a refresh fails", async () => {
    reviewComments.add("c1", note());
    const { el, root } = await mount();
    await settle(el);
    vi.stubGlobal("fetch", async () => reply({ error: "boom" }, 500));
    await el.refresh();
    await el.updateComplete;
    expect(root.querySelector('.say[role="alert"]')?.textContent).toContain("Couldn't read the changes");
    expect(root.querySelector(".rows")).not.toBeNull();
    expect(root.querySelector("#h-comments")?.textContent).toBe("Comments · 1");
    expect(root.querySelector(".send .cbtn")).not.toBeNull();
  });

  it("keeps the list, the diff and a box when a refresh is answered asleep, and says so", async () => {
    const { el, root } = await mount();
    await settle(el);
    await typeAt(el, root, ".row.add", "half a thought");
    const reason = "Ada's machine is asleep, so the changes can't be read right now.";
    changes = listing({ state: "asleep", files: [], reason });
    await el.refresh();
    await settle(el);
    expect(root.querySelector(".rows")).not.toBeNull();
    expect(root.querySelector("#h-files")?.textContent).toBe("Files · 2");
    expect(root.querySelector<HTMLTextAreaElement>(".rows .box textarea")?.value).toBe("half a thought");
    expect(root.querySelector(".state")).toBeNull();
    expect(root.querySelector('.say[role="alert"]')?.textContent).toContain(reason);
    // Its Try again works, and the note goes with the read that worked
    changes = listing();
    const again = must(root.querySelector<HTMLButtonElement>('.say[role="alert"] .link-btn'));
    again.focus();
    again.click();
    await until(() => !root.querySelector('.say[role="alert"]'));
    await settle(el);
    await until(() => root.activeElement === root.querySelector(".refresh"));
  });

  it("keeps it for busy and failed too, but takes a copy that has gone at its word", async () => {
    const { el, root } = await mount();
    await settle(el);
    for (const state of ["busy", "failed"]) {
      changes = listing({ state, files: [], reason: `It is ${state}.` });
      await el.refresh();
      await settle(el);
      expect(root.querySelector(".rows")).not.toBeNull();
      expect(root.querySelector('.say[role="alert"]')?.textContent).toContain(`It is ${state}.`);
    }
    changes = listing({ state: "no-copy", files: [], reason: "This working copy was cleaned away." });
    await el.refresh();
    await settle(el);
    expect(root.querySelector(".rows")).toBeNull();
    expect(root.querySelector(".state")?.textContent).toContain("cleaned away");
    expect(root.querySelector('.say[role="alert"]')).toBeNull();
  });

  it("keeps the file showing when it can't be read again, and says so above it", async () => {
    const { el, root } = await mount();
    await settle(el);
    await typeAt(el, root, ".row.add", "half a thought");
    fileReply = file({
      state: "busy",
      reason: "Ada's machine is busy, so the changes can't be read right now.",
    });
    await el.refresh();
    await settle(el);
    expect(root.querySelector(".rows")).not.toBeNull();
    expect(el.rows.length).toBeGreaterThan(0);
    expect(root.querySelector<HTMLTextAreaElement>(".rows .box textarea")?.value).toBe("half a thought");
    expect(root.querySelector('.diff .note[role="alert"]')?.textContent).toContain("is busy");
    // Its Try again brings the file back, and focus moves on to it
    fileReply = file();
    const again = must(root.querySelector<HTMLButtonElement>('.diff .note[role="alert"] .link-btn'));
    again.focus();
    again.click();
    await until(() => !root.querySelector('.diff .note[role="alert"]'));
    await settle(el);
    expect(root.querySelector(".rows")).not.toBeNull();
  });

  it("keeps the file showing when a read again throws", async () => {
    const { el, root } = await mount();
    await settle(el);
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("/changes/file") ? reply({ error: "boom" }, 500) : reply({ changes }),
    );
    await el.refresh();
    await settle(el);
    expect(root.querySelector(".rows")).not.toBeNull();
    expect(root.querySelector('.diff .note[role="alert"]')?.textContent).toContain(
      "Couldn't read this file again",
    );
  });

  it("doesn't keep one conversation's list for another that can't be read", async () => {
    const { el, root } = await mount();
    await settle(el);
    changes = listing({ state: "asleep", files: [], reason: "Grace's machine is asleep." });
    el.conv = { id: "c2", ahpChat: CHAT, ahpSession: SESSION } as Any;
    await el.updateComplete;
    await settle(el);
    expect(root.querySelector(".rows")).toBeNull();
    expect(root.querySelector("#h-files")).toBeNull();
    expect(root.querySelector(".state")?.textContent).toContain("Grace's machine is asleep.");
  });

  it("keeps the comments when the first read fails", async () => {
    reviewComments.add("c1", note());
    vi.stubGlobal("fetch", async () => reply({ error: "boom" }, 500));
    const { root } = await mount();
    expect(root.querySelector(".state")?.textContent).toContain("Couldn't read the changes");
    expect(root.querySelector(".send .cbtn")).not.toBeNull();
  });

  it("keeps focus on Refresh while it reads, and won't read twice", async () => {
    const { el, root } = await mount();
    await settle(el);
    const refresh = must(root.querySelector<HTMLButtonElement>(".refresh"));
    refresh.focus();
    let release: (r: Response) => void = () => {};
    const seen: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      seen.push(url);
      return url.includes("/changes/file")
        ? Promise.resolve(reply({ file: file() }))
        : new Promise<Response>((r) => {
            release = r;
          });
    });
    refresh.click();
    await el.updateComplete;
    expect((refresh as HTMLButtonElement).disabled).toBe(false);
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    expect(root.activeElement).toBe(refresh);
    refresh.click();
    expect(seen.length).toBe(1);
    release(reply({ changes: listing() }));
    await settle(el);
    expect(root.activeElement).toBe(refresh);
  });

  it("moves focus to Refresh when Try again is replaced by the list", async () => {
    changes = listing({ state: "asleep", files: [], reason: "Asleep." });
    const { el, root } = await mount();
    await settle(el);
    must(root.querySelector<HTMLButtonElement>(".state .cbtn")).focus();
    changes = listing();
    must(root.querySelector<HTMLButtonElement>(".state .cbtn")).click();
    await until(() => root.activeElement === root.querySelector(".refresh"));
    expect(root.querySelector(".rows")).not.toBeNull();
  });

  it("puts focus on the first new line after Show all", async () => {
    const text = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join("\n");
    fileReply = file({ before: { state: "none" }, after: { state: "text", text } });
    const { el, root } = await mount();
    await settle(el);
    must(root.querySelector<HTMLButtonElement>(".more .link-btn")).click();
    await until(() => root.activeElement === root.querySelector('[data-i="1000"] .no'));
  });

  it("says the agent is waiting, not working, and takes the owner to it", async () => {
    chat = {
      turns: [],
      activeTurn: {
        id: "t",
        responseParts: [{ kind: "toolCall", toolCall: { toolCallId: "p", status: "pending-confirmation" } }],
      },
    };
    const { el, root } = await mount();
    await settle(el);
    expect(root.querySelector(".say")?.textContent).toContain("Ada is waiting for your answer");
    expect(root.querySelector(".say")?.textContent).not.toContain("working");
    const answer = vi.fn();
    el.addEventListener("conv-review-answer", answer);
    must(root.querySelector<HTMLButtonElement>(".say .link-btn")).click();
    expect(answer).toHaveBeenCalledTimes(1);
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

  it("gives focus back to the composer's Review link", async () => {
    reviewComments.add(conv.id, note());
    const { el, root, thread } = await mount();
    const composer = must(thread.shadowRoot?.querySelector("inc-conv-composer")) as IncConvComposer;
    await composer.updateComplete;
    const link = must(composer.shadowRoot?.querySelector<HTMLButtonElement>(".going .link-btn"));
    link.click();
    await until(() => root().querySelector("inc-conv-review"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await until(() => !root().querySelector("inc-conv-review"));
    await el.updateComplete;
    await until(() => composer.shadowRoot?.activeElement === link);
  });

  it("leaves the pane open when Escape closes a menu in the list", async () => {
    const { el, root, button } = await mount();
    button().click();
    await until(() => root().querySelector("inc-conv-review"));
    const list = must(root().querySelector("inc-conv-list")) as Any;
    await until(() => list.shadowRoot?.querySelector(".dots"));
    const dots = must(list.shadowRoot?.querySelector(".dots")) as HTMLElement;
    dots.click();
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".menu")).not.toBeNull();
    dots.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }),
    );
    await list.updateComplete;
    await el.updateComplete;
    expect(list.shadowRoot?.querySelector(".menu")).toBeNull();
    expect(root().querySelector("inc-conv-review")).not.toBeNull();
  });

  it("gives a tablet's focus to the context drawer that comes back over the header", async () => {
    const { el, root, button } = await mount();
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: false && q,
      addEventListener() {},
      removeEventListener() {},
    }));
    (el as Any).layout();
    (el as Any).ctx = "open";
    await el.updateComplete;
    expect(root().querySelector(".drawer")).not.toBeNull();
    button().click();
    await until(() => root().querySelector("inc-conv-review"));
    expect(root().querySelector(".drawer")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await until(() => root().querySelector(".drawer"));
    const ctx = must(root().querySelector(".drawer inc-conv-context"));
    await until(() => ctx.shadowRoot?.activeElement === ctx.shadowRoot?.querySelector(".x"));
    expect(ctx.shadowRoot?.activeElement).not.toBeNull();
  });

  it("goes back to the thread and the waiting card on Answer", async () => {
    const { root, thread, button } = await mount();
    button().click();
    await until(() => root().querySelector("inc-conv-review"));
    const review = must(root().querySelector<IncConvReview>("inc-conv-review"));
    const focus = vi.spyOn(thread as Any, "focusPending");
    review.dispatchEvent(new CustomEvent("conv-review-answer", { bubbles: true, composed: true }));
    await until(() => !root().querySelector("inc-conv-review"));
    await until(() => focus.mock.calls.length === 1);
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
