// Images added to a ticket that exists, and sent with a "Not quite" reply (#15): the same picker as
// the new-ticket form, multipart only when there are images.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/ticket.ts";

let posts: { url: string; headers: Headers; body: unknown }[] = [];

const attachment = (n: number) => ({
  n,
  name: `${n}.png`,
  mime: "image/png",
  size: 10,
  url: `/api/tickets/9/attachments/${n}`,
});

function ticket(o: Record<string, unknown> = {}) {
  return {
    id: "9",
    title: "The chart is cut off",
    project: "Duet",
    type: "fix",
    effort: "low",
    assignee: { id: "ada", name: "Ada", tint: 1 },
    column: "doing",
    status: "running",
    held: false,
    stages: [],
    live: "Building",
    needsYou: null,
    waiting: null,
    report: null,
    failure: null,
    outcome: null,
    attachments: [attachment(1)],
    ...o,
  };
}

const ready = {
  status: "ready",
  report: { checks: "Checks green", byline: "Ada", minutes: 12, engines: "", judgment: "Moved it" },
};

function serve(t: ReturnType<typeof ticket>, events: unknown[] = []) {
  posts = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      posts.push({ url, headers: new Headers(init.headers), body: init.body });
      return reply({ ok: true });
    }
    if (url === "/api/tickets/9") return reply({ ticket: t, events });
    return reply({ sessions: [] });
  });
}

const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

type El = HTMLElement & { ticketId: string; updateComplete: Promise<unknown> };

async function mount(): Promise<{ el: El; r: ShadowRoot }> {
  const el = document.createElement("inc-ticket") as El;
  el.ticketId = "9";
  document.body.append(el);
  await tick();
  return { el, r: el.shadowRoot as ShadowRoot };
}

const png = (name: string) => new File([new Uint8Array(10)], name, { type: "image/png" });

function pick(r: ShadowRoot, id: string, files: File[]) {
  const input = r.querySelector(`#${id}-input`) as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change"));
}

const button = (r: ShadowRoot, text: string) =>
  [...r.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("adding images to a ticket", () => {
  it("sends the picked images in one multipart request, then clears them", async () => {
    serve(ticket());
    const { el, r } = await mount();
    expect(r.querySelector("#add-label")?.textContent).toBe("More images");
    expect(r.textContent).toContain("Ada sees them at their next session.");
    expect(button(r, "Send 1 image")).toBeUndefined();

    pick(r, "add", [png("before.png"), png("after.png")]);
    await el.updateComplete;
    button(r, "Send 2 images")?.click();
    await tick();

    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post?.url).toBe("/api/tickets/9/attachments");
    expect(post?.headers.get("x-i-inc-upload")).toBe("1");
    const form = post?.body as FormData;
    expect((form.getAll("image") as File[]).map((f) => f.name)).toEqual(["before.png", "after.png"]);
    expect(r.querySelectorAll(".thumbs img")).toHaveLength(0);
  });

  it("takes no more than the ticket has room for", async () => {
    serve(ticket({ attachments: Array.from({ length: 22 }, (_, i) => attachment(i + 1)) }));
    const { el, r } = await mount();
    pick(r, "add", [png("a.png"), png("b.png"), png("c.png")]);
    await el.updateComplete;
    expect(r.querySelectorAll(".thumbs img")).toHaveLength(2);
    expect(r.querySelector("[role=alert]")?.textContent).toContain("You can add 2 more images now.");
    expect((r.querySelector("#add-input + .thumbs + button.pick") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says a queued ticket takes them at pick-up, and offers nothing once it's done", async () => {
    serve(ticket({ status: "queued" }));
    const queued = await mount();
    expect(queued.r.textContent).toContain("They go with the ticket when it's picked up.");

    document.body.innerHTML = "";
    serve(ticket({ status: "done", outcome: "merged" }));
    const { r } = await mount();
    expect(r.querySelector("input[type=file]")).toBeNull();
  });

  it("shows them in the timeline", async () => {
    serve(ticket(), [{ type: "owner-attached", at: 0, attachments: [attachment(2), attachment(3)] }]);
    const { r } = await mount();
    expect(r.querySelector("aside")?.textContent).toContain("You added 2 images");
  });
});

describe("images with a 'Not quite' reply", () => {
  async function reply(note: string, files: File[]) {
    serve(ticket(ready));
    const { el, r } = await mount();
    // On a ready ticket, images go with the reply, not on their own.
    expect(r.querySelector("#add-input")).toBeNull();
    const box = r.querySelector("textarea") as HTMLTextAreaElement;
    box.value = note;
    box.dispatchEvent(new Event("input"));
    if (files.length) pick(r, "reply", files);
    await el.updateComplete;
    button(r, "Request changes")?.click();
    await tick();
    return r;
  }

  it("sends the note and the images as one multipart request", async () => {
    const r = await reply("Match this layout", [png("wanted.png")]);
    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post?.url).toBe("/api/tickets/9/decide");
    expect(post?.headers.get("x-i-inc-upload")).toBe("1");
    const form = post?.body as FormData;
    expect(JSON.parse(String(form.get("decision")))).toEqual({
      decision: "changes",
      note: "Match this layout",
    });
    expect((form.getAll("image") as File[]).map((f) => f.name)).toEqual(["wanted.png"]);
    expect(r.querySelectorAll(".thumbs img")).toHaveLength(0);
  });

  it("stays JSON without images", async () => {
    await reply("Smaller, please", []);
    expect(posts[0]?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(posts[0]?.body))).toEqual({ decision: "changes", note: "Smaller, please" });
  });
});
