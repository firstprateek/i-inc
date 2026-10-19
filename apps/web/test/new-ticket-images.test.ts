// Images on the new-ticket form (#12): picked or pasted, checked, shown as thumbnails that can be
// removed, and sent with the ticket in one multipart request.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/new-ticket.ts";
import "../src/components/ticket.ts";

let posts: { headers: Headers; body: unknown }[] = [];

function serve() {
  posts = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/projects") return reply({ projects: [{ id: "Duet" }] });
    if (url === "/api/tickets" && init?.method === "POST") {
      posts.push({ headers: new Headers(init.headers), body: init.body });
      return reply({ ticket: { id: "9" } }, 201);
    }
    return reply({ ok: true });
  });
}

const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

type Form = HTMLElement & { updateComplete: Promise<unknown> };

async function mount(): Promise<{ el: Form; r: ShadowRoot }> {
  const el = document.createElement("inc-new-ticket") as Form;
  document.body.append(el);
  await tick();
  const r = el.shadowRoot as ShadowRoot;
  r.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
  await el.updateComplete;
  return { el, r };
}

const png = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: "image/png" });

/** Picks files the way the browser does: sets the input's files and fires change. */
function pick(r: ShadowRoot, files: File[]) {
  const input = r.querySelector("input[type=file]") as HTMLInputElement;
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

const names = (r: ShadowRoot) => [...r.querySelectorAll(".thumbs img")].map((i) => i.getAttribute("alt"));

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("images on the new-ticket form", () => {
  it("takes only the image types the daemon does, from the camera or the library", async () => {
    serve();
    const { r } = await mount();
    const input = r.querySelector("input[type=file]") as HTMLInputElement;
    expect(input.accept).toBe("image/png,image/jpeg,image/webp,image/gif");
    expect(input.multiple).toBe(true);
    expect(r.querySelector("button.pick")?.textContent?.trim()).toBe("Add images");
  });

  it("shows picked and pasted images as thumbnails, each with a Remove button", async () => {
    serve();
    const { el, r } = await mount();
    pick(r, [png("chart.png"), png("receipt.png")]);
    await el.updateComplete;
    const e = paste(r, [png("image.png")]);
    await el.updateComplete;
    expect(e.defaultPrevented).toBe(true);
    expect(names(r)).toEqual(["chart.png", "receipt.png", "screenshot-3.png"]);

    (r.querySelector("button[aria-label='Remove receipt.png']") as HTMLButtonElement).click();
    await el.updateComplete;
    expect(names(r)).toEqual(["chart.png", "screenshot-3.png"]);
  });

  it("lets a text paste through", async () => {
    serve();
    const { r } = await mount();
    expect(paste(r, []).defaultPrevented).toBe(false);
  });

  it("says why an image was left out: the wrong type, too big, or one too many", async () => {
    serve();
    const { el, r } = await mount();
    pick(r, [new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })]);
    await el.updateComplete;
    expect(r.querySelector("[role=alert]")?.textContent).toContain("logo.svg isn't a PNG, JPEG, WebP or GIF");

    pick(r, [png("huge.png", 10 * 1024 * 1024 + 1)]);
    await el.updateComplete;
    expect(r.querySelector("[role=alert]")?.textContent).toContain("huge.png is over 10 MB");

    pick(
      r,
      Array.from({ length: 7 }, (_, i) => png(`${i}.png`)),
    );
    await el.updateComplete;
    expect(names(r)).toHaveLength(6);
    expect(r.querySelector("[role=alert]")?.textContent).toContain("at most 6 images");
    expect((r.querySelector("button.pick") as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends the ticket and its images in one multipart request, then clears them", async () => {
    serve();
    const { el, r } = await mount();
    const title = r.querySelector("input[name=title]") as HTMLInputElement;
    title.value = "The chart is cut off";
    title.dispatchEvent(new Event("input"));
    pick(r, [png("chart.png")]);
    await el.updateComplete;
    (r.querySelector("button[type=submit]") as HTMLButtonElement).click();
    await tick();

    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post?.headers.get("x-i-inc-upload")).toBe("1");
    expect(post?.body).toBeInstanceOf(FormData);
    const form = post?.body as FormData;
    expect(JSON.parse(String(form.get("ticket")))).toMatchObject({
      title: "The chart is cut off",
      project: "Duet",
    });
    expect((form.getAll("image") as File[]).map((f) => f.name)).toEqual(["chart.png"]);
    expect(names(r)).toEqual([]);
    expect(r.querySelector("[role=status]")?.textContent).toContain("#9");
  });

  it("stays JSON when there are no images", async () => {
    serve();
    const { el, r } = await mount();
    const title = r.querySelector("input[name=title]") as HTMLInputElement;
    title.value = "No pictures";
    title.dispatchEvent(new Event("input"));
    await el.updateComplete;
    (r.querySelector("button[type=submit]") as HTMLButtonElement).click();
    await tick();
    expect(posts[0]?.headers.get("content-type")).toBe("application/json");
    expect(typeof posts[0]?.body).toBe("string");
  });
});

describe("images on the ticket page", () => {
  it("shows each image as a thumbnail that opens it, with its name as the alt text", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const ticket = {
        id: "9",
        title: "The chart is cut off",
        project: "Duet",
        type: "fix",
        effort: "low",
        assignee: null,
        column: "todo",
        status: "queued",
        held: false,
        stages: [],
        live: "",
        needsYou: null,
        waiting: null,
        report: null,
        failure: null,
        outcome: null,
        attachments: [
          { n: 1, name: "chart.png", mime: "image/png", size: 10, url: "/api/tickets/9/attachments/1" },
        ],
      };
      const body = url === "/api/tickets/9" ? { ticket, events: [] } : { sessions: [] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
    const el = document.createElement("inc-ticket") as HTMLElement & { ticketId: string };
    el.ticketId = "9";
    document.body.append(el);
    await tick();
    const link = el.shadowRoot?.querySelector(".shots a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/tickets/9/attachments/1");
    expect(link.querySelector("img")?.getAttribute("alt")).toBe("chart.png");
  });
});
