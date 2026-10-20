// Images with a chat message about the current ticket (#16): the shared picker, offered only when the
// employee is on a ticket, sent as one multipart request naming it, and kept for Retry if it fails.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/chat.ts";
import type { Current, Entry, IncChat } from "../src/components/chat.ts";

const threads = [{ id: "ada", name: "Ada", tint: 0, role: "Senior Engineer", last: null }];
const building: Current = { id: "9", title: "The chart is cut off", images: 1 };

let posts: { url: string; headers: Headers; body: unknown }[] = [];

function serve(o: { current?: Current | null; post?: () => Response } = {}) {
  posts = [];
  const current = o.current === undefined ? building : o.current;
  let entries: Entry[] = [];
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, headers: new Headers(init.headers), body: init.body });
      if (o.post) return o.post();
      const form = init.body instanceof FormData ? init.body : null;
      const message = form
        ? JSON.parse(String(form.get("message")))
        : (JSON.parse(String(init.body)) as { text: string });
      const n = form?.getAll("image").length ?? 0;
      entries = [
        ...entries,
        {
          from: "owner",
          at: Date.now(),
          text: message.text,
          ...(n ? { images: { ticketId: "9", ns: Array.from({ length: n }, (_, i) => i + 2) } } : {}),
        },
      ];
      return reply({ entries, current: current && { ...current, images: current.images + n } });
    }
    if (url === "/api/chat") return reply({ threads });
    return reply({ entries, current });
  });
}

const tick = async (el: IncChat) => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
};

async function mount(): Promise<{ el: IncChat; r: ShadowRoot }> {
  const el = document.createElement("inc-chat") as IncChat;
  el.employeeId = "ada";
  document.body.append(el);
  await tick(el);
  return { el, r: el.shadowRoot as ShadowRoot };
}

const png = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: "image/png" });

function pick(r: ShadowRoot, files: File[]) {
  const input = r.querySelector("#chat-input") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change"));
}

function paste(r: ShadowRoot, files: File[]) {
  const e = new Event("paste", { bubbles: true, cancelable: true, composed: true }) as Event & {
    clipboardData: unknown;
  };
  e.clipboardData = { files };
  (r.querySelector("textarea") as HTMLTextAreaElement).dispatchEvent(e);
  return e;
}

function type(r: ShadowRoot, text: string) {
  const textarea = r.querySelector("textarea") as HTMLTextAreaElement;
  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

const thumbs = (r: ShadowRoot) => [...r.querySelectorAll(".thumbs img")].map((i) => i.getAttribute("alt"));
const sendButton = (r: ShadowRoot) => r.querySelector("button[type=submit]") as HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("images with a chat message", () => {
  it("offers the picker only when the employee is on a ticket", async () => {
    serve({ current: null });
    const { r } = await mount();
    expect(r.querySelector(".add-images")).toBeNull();
    expect(r.querySelector("#chat-input")).toBeNull();
    // A pasted image with no ticket to go to is left alone.
    expect(paste(r, [png("image.png")]).defaultPrevented).toBe(false);

    document.body.innerHTML = "";
    serve();
    const { r: r2 } = await mount();
    expect(r2.querySelector(".add-images")?.getAttribute("aria-label")).toBe("Add images for #9");
  });

  it("shows a pasted image as a thumbnail for the ticket, and refuses HEIC and oversize files", async () => {
    serve();
    const { el, r } = await mount();
    expect(paste(r, [png("image.png")]).defaultPrevented).toBe(true);
    await el.updateComplete;
    expect(thumbs(r)).toEqual(["screenshot-1.png"]);
    expect(r.querySelector(".attach .for")?.textContent).toContain("For #9 The chart is cut off");
    expect(sendButton(r).disabled).toBe(false);

    pick(r, [
      new File(["x"], "IMG_0042.HEIC", { type: "image/heic" }),
      png("huge.png", 10 * 1024 * 1024 + 1),
    ]);
    await el.updateComplete;
    const problem = r.querySelector(".attach [role=alert]")?.textContent ?? "";
    expect(problem).toContain("IMG_0042.HEIC is a HEIC photo, which a ticket can't take.");
    expect(problem).toContain("huge.png is over 10 MB.");
    expect(thumbs(r)).toEqual(["screenshot-1.png"]);

    (r.querySelector('[aria-label="Remove screenshot-1.png"]') as HTMLButtonElement).click();
    await el.updateComplete;
    expect(thumbs(r)).toEqual([]);
    expect(sendButton(r).disabled).toBe(true);
  });

  it("takes no more than the ticket has room for", async () => {
    serve({ current: { ...building, images: 22 } });
    const { el, r } = await mount();
    pick(r, [png("a.png"), png("b.png"), png("c.png")]);
    await el.updateComplete;
    expect(thumbs(r)).toEqual(["a.png", "b.png"]);
    expect(r.querySelector(".attach [role=alert]")?.textContent).toContain("You can add 2 more images now.");
    expect((r.querySelector(".add-images") as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends the text and images in one multipart request naming the ticket, then shows them in the thread", async () => {
    serve();
    const { el, r } = await mount();
    pick(r, [png("before.png"), png("after.png")]);
    type(r, "Match these");
    await el.updateComplete;
    sendButton(r).click();
    await tick(el);

    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post?.url).toBe("/api/chat/ada");
    expect(post?.headers.get("x-i-inc-upload")).toBe("1");
    const form = post?.body as FormData;
    expect(JSON.parse(String(form.get("message")))).toEqual({ text: "Match these", ticket: "9" });
    expect((form.getAll("image") as File[]).map((f) => f.name)).toEqual(["before.png", "after.png"]);

    expect(thumbs(r)).toEqual([]);
    expect([...r.querySelectorAll(".me .sent-images img")].map((i) => i.getAttribute("src"))).toEqual([
      "/api/tickets/9/attachments/2",
      "/api/tickets/9/attachments/3",
    ]);
  });

  it("sends images with no text", async () => {
    serve();
    const { el, r } = await mount();
    pick(r, [png("a.png")]);
    await el.updateComplete;
    sendButton(r).click();
    await tick(el);
    const form = posts[0]?.body as FormData;
    expect(JSON.parse(String(form.get("message")))).toEqual({ text: "", ticket: "9" });
  });

  it("keeps the images of a failed send, and Retry sends them again", async () => {
    let fail = true;
    serve();
    const ok = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && fail) {
        posts.push({ url, headers: new Headers(init.headers), body: init.body });
        return new Response(JSON.stringify({ error: "Can't reach i.inc" }), { status: 502 });
      }
      return ok(url, init);
    });
    const { el, r } = await mount();
    pick(r, [png("chart.png")]);
    type(r, "See this");
    await el.updateComplete;
    sendButton(r).click();
    await tick(el);
    expect(r.querySelector(".me .status.error")).not.toBeNull();
    expect([...r.querySelectorAll(".me .sent-images img")].map((i) => i.getAttribute("alt"))).toEqual([
      "chart.png",
    ]);

    fail = false;
    (r.querySelector(".me .retry") as HTMLButtonElement).click();
    await tick(el);
    expect(posts).toHaveLength(2);
    const form = posts[1]?.body as FormData;
    expect(JSON.parse(String(form.get("message")))).toEqual({ text: "See this", ticket: "9" });
    expect((form.getAll("image") as File[]).map((f) => f.name)).toEqual(["chart.png"]);
    expect(r.querySelector(".me .status.error")).toBeNull();
  });

  it("shows where images would go now when the ticket has moved on", async () => {
    serve({
      post: () =>
        new Response(
          JSON.stringify({
            error: "Ada is on #10 now, not #9",
            current: { id: "10", title: "Dark mode", images: 0 },
          }),
          { status: 409 },
        ),
    });
    const { el, r } = await mount();
    pick(r, [png("chart.png")]);
    await el.updateComplete;
    sendButton(r).click();
    await tick(el);
    expect(r.querySelector(".error-msg")?.textContent).toBe("Ada is on #10 now, not #9");
    expect(r.querySelector(".add-images")?.getAttribute("aria-label")).toBe("Add images for #10");
    // The failed message keeps its images and the ticket they were for.
    expect(r.querySelectorAll(".me .sent-images img")).toHaveLength(1);
  });

  it("still sends a message without images as JSON", async () => {
    serve();
    const { el, r } = await mount();
    type(r, "How is it going?");
    await el.updateComplete;
    sendButton(r).click();
    await tick(el);
    expect(posts[0]?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(posts[0]?.body))).toEqual({ text: "How is it going?" });
  });
});
