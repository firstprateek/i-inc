// Images on a new ticket (#12): one multipart request, checked by their leading bytes, stored with the
// ticket and served back behind the owner's auth. Images added to it later, or with a "Not quite"
// reply (#15), or with a chat message about the current ticket (#16), get the same checks and reach
// the builder's next session.
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
  /** Images for a ticket that exists, with any other fields the path takes. */
  const send = async (
    path: string,
    files: { data: Uint8Array; name: string }[],
    o: { fields?: Record<string, string>; headers?: Record<string, string> } = {},
  ) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(o.fields ?? {})) form.set(k, v);
    for (const f of files) form.append("image", new Blob([f.data as BlobPart]), f.name);
    const res = await handle(
      new Request(`http://127.0.0.1:7420${path}`, {
        method: "POST",
        body: form,
        headers: { ...base, "x-i-inc-upload": "1", ...o.headers },
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const post = async (path: string, body: unknown) => {
    const res = await handle(
      new Request(`http://127.0.0.1:7420${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { ...base, "content-type": "application/json" },
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { app, handle, upload, get, send, post };
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

/** A ticket with one image, waiting at the plan gate. */
async function waitingAtTheGate() {
  const g = await guarded();
  g.app.agent.on({ duty: "plan" }, { kind: "done", output: "Add an alerts table: a schema change." });
  const r = await g.upload([{ data: png, name: "chart.png" }]);
  const id = (r.body.ticket as { id: string }).id;
  await g.app.daemon.idle();
  expect((await g.app.daemon.state(id)).status).toBe("needs-you");
  return { ...g, id };
}

describe("images added to an existing ticket", () => {
  it("numbers them after the ticket's own, serves them back, and briefs the builder after the owner answers", async () => {
    const { app, id, send, get, post } = await waitingAtTheGate();
    app.clock.advance(1);
    const r = await send(`/api/tickets/${id}/attachments`, [
      { data: jpeg, name: "receipt.jpeg" },
      { data: png, name: "after.png" },
    ]);
    expect(r).toEqual({
      status: 201,
      body: {
        attachments: [
          { n: 2, name: "receipt.jpg", mime: "image/jpeg", size: jpeg.byteLength },
          { n: 3, name: "after.png", mime: "image/png", size: png.byteLength },
        ],
      },
    });
    expect(app.deps.tickets.get(id)?.ticket.attachments?.map((a) => a.n)).toEqual([1, 2, 3]);
    expect(new Uint8Array(await (await get(`/api/tickets/${id}/attachments/2`)).arrayBuffer())).toEqual(jpeg);
    const view = await (await get(`/api/tickets/${id}`)).json();
    expect(view.ticket.attachments).toHaveLength(3);
    // Still waiting on the owner: adding images doesn't answer for them.
    expect(view.ticket.status).toBe("needs-you");

    app.clock.advance(1);
    await post(`/api/tickets/${id}/answer`, { answer: "approve" });
    await app.daemon.idle();
    const build = app.agent.callsFor("ada", "build")[0]?.brief ?? "";
    expect(build).toContain(
      "Images from the owner (open them):\n- .inc/attachments/1-chart.png\n- .inc/attachments/2-receipt.jpg\n- .inc/attachments/3-after.png",
    );
    expect(build).toContain(
      "The owner added images since your last session (open them):\n- .inc/attachments/2-receipt.jpg\n- .inc/attachments/3-after.png",
    );
  });

  it("reaches a running session's next turn, without stopping it", async () => {
    const { app, upload, send } = await guarded();
    app.agent.on({ stage: "build" }, { kind: "hang" });
    const r = await upload([{ data: png, name: "chart.png" }]);
    const id = (r.body.ticket as { id: string }).id;
    while (!app.agent.callsFor("ada", "build").length) await new Promise((res) => setTimeout(res, 0));

    app.clock.advance(1);
    expect((await send(`/api/tickets/${id}/attachments`, [{ data: jpeg, name: "receipt.jpg" }])).status).toBe(
      201,
    );
    expect(app.agent.callsFor("ada", "build")).toHaveLength(1);
    expect((await app.daemon.state(id)).attachments.map((a) => a.n)).toEqual([2]);

    // The session ends (here the owner stops it); the next one is told.
    app.clock.advance(1);
    app.daemon.interrupt(id, "ada");
    await app.daemon.idle();
    const builds = app.agent.callsFor("ada", "build");
    expect(builds).toHaveLength(2);
    expect(builds[0]?.brief).not.toContain("receipt");
    expect(builds[1]?.brief).toContain(
      "The owner added images since your last session (open them):\n- .inc/attachments/2-receipt.jpg",
    );
  });

  it.each([
    ["an SVG", [{ data: svg, name: "x.svg" }], /isn't a PNG/],
    ["a file whose bytes aren't its type", [{ data: svg, name: "x.png" }], /isn't a PNG/],
    ["more than six at a time", Array.from({ length: 7 }, () => ({ data: png, name: "a.png" })), /at most 6/],
    ["an image over 10 MB", [{ data: new Uint8Array(10 * 1024 * 1024 + 1), name: "big.png" }], /over 10 MB/],
    ["no images", [], /at least one/],
  ])("refuses %s and stores nothing", async (_what, files, error) => {
    const { app, id, send } = await waitingAtTheGate();
    const r = await send(`/api/tickets/${id}/attachments`, files);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(error);
    expect(app.deps.tickets.attachments(id)).toHaveLength(1);
    expect((await app.daemon.state(id)).attachments).toEqual([]);
  });

  it("stops at 24 images on a ticket", async () => {
    const { app, id, send } = await waitingAtTheGate();
    const six = Array.from({ length: 6 }, () => ({ data: png, name: "a.png" }));
    for (let i = 0; i < 3; i++) expect((await send(`/api/tickets/${id}/attachments`, six)).status).toBe(201);
    expect(app.deps.tickets.attachments(id)).toHaveLength(19);
    const r = await send(`/api/tickets/${id}/attachments`, six);
    expect(r).toEqual({
      status: 400,
      body: { error: "a ticket takes at most 24 images, and this one has 19" },
    });
    expect((await send(`/api/tickets/${id}/attachments`, six.slice(1))).status).toBe(201);
    expect(app.deps.tickets.attachments(id)).toHaveLength(24);
  });

  it("refuses multipart without the upload header, and an unknown or done ticket", async () => {
    const { app, id, send, post } = await waitingAtTheGate();
    const one = [{ data: png, name: "a.png" }];
    expect(
      (await send(`/api/tickets/${id}/attachments`, one, { headers: { "x-i-inc-upload": "" } })).status,
    ).toBe(415);
    expect((await send("/api/tickets/99/attachments", one)).status).toBe(404);
    expect((await post(`/api/tickets/${id}/attachments`, {})).status).toBe(400);
    // The header opens only the paths that take images.
    expect((await send(`/api/tickets/${id}/answer`, one)).status).toBe(415);
    expect((await send(`/api/tickets/${id}/attachments/1`, one)).status).toBe(415);

    await post(`/api/tickets/${id}/answer`, { answer: "approve" });
    await app.daemon.idle();
    await post(`/api/tickets/${id}/decide`, { decision: "approve" });
    await app.daemon.idle();
    expect((await app.daemon.state(id)).status).toBe("done");
    expect(await send(`/api/tickets/${id}/attachments`, one)).toEqual({
      status: 409,
      body: { error: `ticket ${id} is done` },
    });
    expect(app.deps.tickets.attachments(id)).toHaveLength(1);
  });
});

describe("images with a 'Not quite' reply", () => {
  async function ready() {
    const g = await guarded();
    const r = await g.upload([{ data: png, name: "chart.png" }]);
    const id = (r.body.ticket as { id: string }).id;
    await g.app.daemon.idle();
    expect((await g.app.daemon.state(id)).status).toBe("ready");
    return { ...g, id };
  }

  it("stores them, then sends the ticket back to Build with the note and the images", async () => {
    const { app, id, send } = await ready();
    app.clock.advance(1);
    const r = await send(`/api/tickets/${id}/decide`, [{ data: jpeg, name: "wanted.jpg" }], {
      fields: { decision: JSON.stringify({ decision: "changes", note: "match this layout" }) },
    });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(app.deps.tickets.get(id)?.ticket.attachments?.map((a) => a.name)).toEqual([
      "chart.png",
      "wanted.jpg",
    ]);
    await app.daemon.idle();

    const builds = app.agent.callsFor("ada", "build");
    expect(builds).toHaveLength(2);
    expect(builds[1]?.brief).toContain("The owner asked for changes: match this layout");
    expect(builds[1]?.brief).toContain(
      "The owner added images since your last session (open them):\n- .inc/attachments/2-wanted.jpg",
    );
    expect((await app.daemon.state(id)).status).toBe("ready");
  });

  it("takes a reply with no images as multipart too", async () => {
    const { app, id, send } = await ready();
    const r = await send(`/api/tickets/${id}/decide`, [], {
      fields: { decision: JSON.stringify({ decision: "changes", note: "smaller" }) },
    });
    expect(r.status).toBe(200);
    expect(app.deps.tickets.attachments(id)).toHaveLength(1);
  });

  it("refuses images with anything but a request for changes, bad images, and a ticket that isn't ready", async () => {
    const { app, id, send } = await ready();
    const one = [{ data: png, name: "a.png" }];
    const as = (decision: unknown) => ({ fields: { decision: JSON.stringify(decision) } });
    expect((await send(`/api/tickets/${id}/decide`, one, as({ decision: "approve" }))).status).toBe(400);
    expect(
      (await send(`/api/tickets/${id}/decide`, [{ data: svg, name: "x.png" }], as({ decision: "changes" })))
        .status,
    ).toBe(400);
    expect((await send(`/api/tickets/${id}/decide`, one, { fields: { decision: "{" } })).status).toBe(400);
    expect((await send("/api/tickets/99/decide", one, as({ decision: "changes" }))).status).toBe(404);
    expect(app.deps.tickets.attachments(id)).toHaveLength(1);
    expect((await app.daemon.state(id)).status).toBe("ready");

    const gate = await waitingAtTheGate();
    const r = await gate.send(`/api/tickets/${gate.id}/decide`, one, as({ decision: "changes" }));
    expect(r).toEqual({ status: 409, body: { error: `ticket ${gate.id} is needs-you, not ready` } });
    expect(gate.app.deps.tickets.attachments(gate.id)).toHaveLength(1);
  });
});

describe("images with a chat message", () => {
  /** A ticket with one image whose build session hangs, so Ada is on it now. */
  async function building() {
    const g = await guarded();
    g.app.agent.on({ stage: "build" }, { kind: "hang" });
    const r = await g.upload([{ data: png, name: "chart.png" }]);
    const id = (r.body.ticket as { id: string }).id;
    while (!g.app.agent.callsFor("ada", "build").length) await new Promise((res) => setTimeout(res, 0));
    g.app.clock.advance(1);
    const say = (
      files: { data: Uint8Array; name: string }[],
      message: Record<string, unknown> = {},
      headers: Record<string, string> = {},
    ) =>
      g.send("/api/chat/ada", files, {
        fields: { message: JSON.stringify({ ticket: id, ...message }) },
        headers,
      });
    return { ...g, id, say };
  }

  it("stores the images on the running ticket with the note, without stopping its session", async () => {
    const { app, id, say, get } = await building();
    expect((await (await get("/api/chat/ada")).json()).current).toEqual({
      id,
      title: refunds.title,
      images: 1,
    });

    const r = await say([{ data: jpeg, name: "receipt.jpeg" }], { text: "Match this receipt" });
    expect(r.status).toBe(200);
    expect(app.deps.tickets.get(id)?.ticket.attachments?.map((a) => a.name)).toEqual([
      "chart.png",
      "receipt.jpg",
    ]);
    const events = await app.deps.store.read(id);
    const kinds = events.map((e) => e.type);
    expect(kinds.slice(-2)).toEqual(["owner-attached", "owner-message"]);
    expect(events.at(-1)).toMatchObject({ type: "owner-message", text: "Match this receipt" });
    expect(app.helper.asked).toEqual([]);
    expect(app.agent.callsFor("ada", "build")).toHaveLength(1);

    const entries = r.body.entries as Record<string, unknown>[];
    expect(entries.at(-2)).toMatchObject({
      from: "owner",
      text: "Match this receipt",
      images: { ticketId: id, ns: [2] },
    });
    expect(entries.at(-1)).toMatchObject({
      from: "system",
      text: "Ada will see the image when their next session starts, and this at the next stage boundary.",
    });
    expect(r.body.current).toEqual({ id, title: refunds.title, images: 2 });

    // The session ends (here the owner stops it); the next one has the image.
    app.daemon.interrupt(id, "ada");
    await app.daemon.idle();
    expect(app.agent.callsFor("ada", "build")[1]?.brief).toContain(
      "The owner added images since your last session (open them):\n- .inc/attachments/2-receipt.jpg",
    );
  });

  it("stops the session for an urgent message, and the next brief has the note and the image", async () => {
    const { app, say } = await building();
    const r = await say([{ data: jpeg, name: "wanted.jpg" }], { text: "Use this layout", urgent: true });
    expect((r.body.entries as { text: string }[]).at(-1)?.text).toBe(
      "Ada stopped to read this, and carries on from there.",
    );
    await app.daemon.idle();
    const builds = app.agent.callsFor("ada", "build");
    expect(builds).toHaveLength(2);
    expect(builds[1]?.brief).toContain("- Use this layout");
    expect(builds[1]?.brief).toContain(".inc/attachments/2-wanted.jpg");
  });

  it("takes images with no text, and records no note", async () => {
    const { app, id, say } = await building();
    const r = await say([
      { data: png, name: "a.png" },
      { data: png, name: "b.png" },
    ]);
    expect(r.status).toBe(200);
    expect((r.body.entries as { text: string }[]).slice(-2)).toMatchObject([
      { from: "owner", text: "", images: { ticketId: id, ns: [2, 3] } },
      { from: "system", text: "Ada will see the 2 images when their next session starts." },
    ]);
    expect((await app.deps.store.read(id)).map((e) => e.type)).not.toContain("owner-message");
  });

  it.each([
    ["an SVG", [{ data: svg, name: "x.svg" }], /isn't a PNG/],
    ["a file whose bytes aren't its type", [{ data: svg, name: "x.png" }], /isn't a PNG/],
    ["more than six at a time", Array.from({ length: 7 }, () => ({ data: png, name: "a.png" })), /at most 6/],
    ["an image over 10 MB", [{ data: new Uint8Array(10 * 1024 * 1024 + 1), name: "big.png" }], /over 10 MB/],
  ])("refuses %s and stores nothing", async (_what, files, error) => {
    const { app, id, say } = await building();
    const before = app.deps.chatLog.thread("ada").length;
    const r = await say(files, { text: "see this" });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(error);
    expect(app.deps.tickets.attachments(id)).toHaveLength(1);
    expect(app.deps.chatLog.thread("ada")).toHaveLength(before);
  });

  it("stops at 24 images on the ticket", async () => {
    const { app, id, send, say } = await building();
    const six = Array.from({ length: 6 }, () => ({ data: png, name: "a.png" }));
    for (let i = 0; i < 3; i++) expect((await send(`/api/tickets/${id}/attachments`, six)).status).toBe(201);
    expect(await say(six, { text: "and these" })).toEqual({
      status: 400,
      body: { error: "a ticket takes at most 24 images, and this one has 19" },
    });
    expect(app.deps.tickets.attachments(id)).toHaveLength(19);
  });

  it("refuses a ticket that isn't the current one, no current ticket, no header and an unknown employee", async () => {
    const { app, id, say, send } = await building();
    const one = [{ data: png, name: "a.png" }];
    expect(await say(one, { text: "x", ticket: "99" })).toEqual({
      status: 409,
      body: { error: `Ada is on #${id} now, not #99`, current: { id, title: refunds.title, images: 1 } },
    });
    expect((await say(one, { text: "x" }, { "x-i-inc-upload": "" })).status).toBe(415);
    expect(
      (await send("/api/chat/nobody", one, { fields: { message: JSON.stringify({ ticket: id }) } })).status,
    ).toBe(404);
    expect((await send("/api/chat/ada", one, { fields: { message: "{" } })).status).toBe(400);
    // Kit has no ticket on the go.
    expect(
      await send("/api/chat/kit", one, { fields: { message: JSON.stringify({ text: "x", ticket: id }) } }),
    ).toEqual({ status: 409, body: { error: "Kit isn't on a ticket now", current: null } });
    // The header opens the chat thread, not its drafts.
    expect((await send("/api/chat/ada/drafts/1", one)).status).toBe(415);
    expect(app.deps.tickets.attachments(id)).toHaveLength(1);
  });

  it("still sends a plain JSON message through the helper", async () => {
    const { app, id, post } = await building();
    const r = await post("/api/chat/ada", { text: "Keep this one small" });
    expect(r.status).toBe(200);
    expect(app.helper.asked.length).toBeGreaterThan(0);
    expect((await app.deps.store.read(id)).at(-1)).toMatchObject({
      type: "owner-message",
      text: "Keep this one small",
    });
    expect((r.body.entries as Record<string, unknown>[]).at(-2)).not.toHaveProperty("images");
    expect(r.body.current).toEqual({ id, title: refunds.title, images: 1 });
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
