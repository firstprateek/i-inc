// Images on a new ticket (#12): one multipart request, checked by their leading bytes, stored with the
// ticket and served back behind the owner's auth.
import { describe, expect, it } from "vitest";
import { createApi, sniffImage } from "../src/api.ts";
import { safeName } from "../src/tickets.ts";
import { refunds, testApp } from "./setup.ts";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const svg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

async function guarded() {
  const app = await testApp();
  const handle = createApi(app.daemon, app.deps, { token: "t0ken", hosts: ["127.0.0.1:7420"] });
  const base = { host: "127.0.0.1:7420", authorization: "Bearer t0ken" };
  const upload = async (
    files: { data: Uint8Array; name: string; type?: string }[],
    o: { ticket?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const form = new FormData();
    if (o.ticket !== null) form.set("ticket", JSON.stringify(o.ticket ?? refunds));
    for (const f of files)
      form.append("image", new Blob([f.data as BlobPart], { type: f.type ?? "" }), f.name);
    const res = await handle(
      new Request("http://127.0.0.1:7420/api/tickets", {
        method: "POST",
        body: form,
        headers: { ...base, "x-i-inc-upload": "1", ...o.headers },
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const get = (path: string, headers: Record<string, string> = base) =>
    handle(new Request(`http://127.0.0.1:7420${path}`, { headers }));
  return { app, handle, upload, get };
}

describe("images on a new ticket", () => {
  it("stores the ticket and its images in one request, and serves the same bytes back", async () => {
    const { app, upload, get } = await guarded();
    const r = await upload([
      { data: png, name: "My chart (v2).png", type: "image/png" },
      { data: jpeg, name: "receipt.jpeg", type: "image/jpeg" },
    ]);
    expect(r.status).toBe(201);
    const id = (r.body.ticket as { id: string }).id;
    expect(app.deps.tickets.get(id)?.ticket.attachments).toEqual([
      { n: 1, name: "My-chart-v2.png", mime: "image/png", size: png.byteLength },
      { n: 2, name: "receipt.jpg", mime: "image/jpeg", size: jpeg.byteLength },
    ]);

    const view = await (await get(`/api/tickets/${id}`)).json();
    expect(view.ticket.attachments.map((a: { url: string }) => a.url)).toEqual([
      `/api/tickets/${id}/attachments/1`,
      `/api/tickets/${id}/attachments/2`,
    ]);

    const res = await get(`/api/tickets/${id}/attachments/1`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="My-chart-v2.png"');
    expect(res.headers.get("cache-control")).toMatch(/^private/);

    expect((await get(`/api/tickets/${id}/attachments/3`)).status).toBe(404);
    expect((await get(`/api/tickets/${id}/attachments/x`)).status).toBe(404);
    expect((await get("/api/tickets/99/attachments/1")).status).toBe(404);
    expect((await get(`/api/tickets/${id}/attachments/1`, { host: "127.0.0.1:7420" })).status).toBe(401);
  });

  it("still takes a plain JSON ticket, with no images", async () => {
    const app = await testApp();
    const r = await app.call("POST", "/api/tickets", refunds);
    expect(r.status).toBe(201);
    expect(app.deps.tickets.get(r.body.ticket.id)?.ticket.attachments).toBeUndefined();
  });

  it.each([
    ["an SVG", [{ data: svg, name: "x.svg", type: "image/svg+xml" }], {}, /isn't a PNG/],
    [
      "a file whose bytes aren't its type",
      [{ data: svg, name: "x.png", type: "image/png" }],
      {},
      /isn't a PNG/,
    ],
    [
      "more than six images",
      Array.from({ length: 7 }, () => ({ data: png, name: "a.png" })),
      {},
      /at most 6/,
    ],
    [
      "an image over 10 MB",
      [{ data: new Uint8Array(10 * 1024 * 1024 + 1), name: "big.png" }],
      {},
      /over 10 MB/,
    ],
    ["no ticket field", [{ data: png, name: "a.png" }], { ticket: null }, /ticket field/],
    [
      "a ticket that isn't valid",
      [{ data: png, name: "a.png" }],
      { ticket: { ...refunds, title: "" } },
      /title/,
    ],
  ])("refuses %s and files no ticket", async (_what, files, o, error) => {
    const { app, upload } = await guarded();
    const r = await upload(files, o);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(error);
    expect(app.deps.tickets.all()).toHaveLength(0);
  });

  it("refuses multipart without the upload header, so another site can't send it", async () => {
    const { app, upload } = await guarded();
    const r = await upload([{ data: png, name: "a.png" }], { headers: { "x-i-inc-upload": "" } });
    expect(r.status).toBe(415);
    expect(app.deps.tickets.all()).toHaveLength(0);
  });
});

describe("image checks", () => {
  it("tells the four types by their leading bytes", () => {
    const ascii = (t: string) => new TextEncoder().encode(t);
    expect(sniffImage(png)).toBe("image/png");
    expect(sniffImage(jpeg)).toBe("image/jpeg");
    expect(sniffImage(ascii("GIF89a..."))).toBe("image/gif");
    expect(sniffImage(ascii("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(svg)).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });

  it("makes names safe for a shell, a path and a header", () => {
    expect(safeName("../../etc/passwd", "image/png")).toBe("passwd.png");
    expect(safeName(`a"b';$(rm).jpeg`, "image/jpeg")).toBe("a-b-rm.jpg");
    expect(safeName(".png", "image/png")).toBe("image.png");
    expect(safeName("photo.HEIC", "image/jpeg")).toBe("photo.jpg");
  });
});
