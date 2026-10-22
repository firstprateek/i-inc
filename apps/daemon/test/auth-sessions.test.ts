// First-run signup needs a one-time setup code, and a login is a server-side session, not the daemon token.
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AhpTransport } from "../src/ahp/transport.ts";
import { createApi } from "../src/api.ts";
import { testApp } from "./setup.ts";

const TOKEN = "s3cret-token";
const HOST = "127.0.0.1:7420";

async function rig(opts: { owner?: boolean } = {}) {
  const app = await testApp();
  const dir = mkdtempSync(join(tmpdir(), "i-inc-setup-"));
  const setupCodePath = join(dir, "setup-code");
  const logs: string[] = [];
  app.deps.log = (m: string) => logs.push(m);
  const mk = () =>
    createApi(app.daemon, app.deps, { token: TOKEN, hosts: [HOST, "iinc.tail.ts.net"], setupCodePath });
  let handle = mk();
  const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(
      new Request(`http://${HOST}${path}`, {
        method,
        headers: {
          host: HOST,
          ...(method === "GET" ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
  };
  const code = () => readFileSync(setupCodePath, "utf8").trim();
  const cookieOf = (r: { headers: Headers }) => (r.headers.get("set-cookie") ?? "").split(";")[0] as string;
  if (opts.owner) {
    const r = await send("POST", "/api/signup", {
      username: "owner",
      password: "long-enough-password",
      setupCode: code(),
    });
    expect(r.status).toBe(201);
  }
  return { app, send, code, setupCodePath, logs, cookieOf, restart: () => (handle = mk()), db: app.db };
}

describe("first-run signup needs the setup code", () => {
  it("refuses a signup with no code or a wrong one, and creates nothing", async () => {
    const t = await rig();
    const body = { username: "intruder", password: "long-enough-password" };
    const none = await t.send("POST", "/api/signup", body);
    expect(none.status).toBe(403);
    expect(none.headers.get("set-cookie")).toBeNull();
    const wrong = await t.send("POST", "/api/signup", { ...body, setupCode: "aaaa-bbbb-cccc" });
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect((await t.send("GET", "/api/auth")).body).toEqual({ initialized: false, setupCodeRequired: true });
    // and the visitor got no way in
    expect((await t.send("GET", "/api/board")).status).toBe(401);
  });

  it("logs the code, writes it to a file only its owner can read, and accepts it once", async () => {
    const t = await rig();
    expect(statSync(t.setupCodePath).mode & 0o777).toBe(0o600);
    expect(t.code()).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(t.logs.some((l) => l.includes(t.code()))).toBe(true);
    const code = t.code();
    const ok = await t.send("POST", "/api/signup", {
      username: "owner",
      password: "long-enough-password",
      setupCode: code,
    });
    expect(ok.status).toBe(201);
    // used up: the file is gone and nobody can sign up again with it
    expect(existsSync(t.setupCodePath)).toBe(false);
    const again = await t.send("POST", "/api/signup", {
      username: "x",
      password: "long-enough-password",
      setupCode: code,
    });
    expect(again.status).toBe(409);
  });

  it("takes the code in any case and with stray spaces (typed on a phone)", async () => {
    const t = await rig();
    const ok = await t.send("POST", "/api/signup", {
      username: "owner",
      password: "long-enough-password",
      setupCode: ` ${t.code().toUpperCase()} `,
    });
    expect(ok.status).toBe(201);
  });

  it("also takes the daemon token, which only the machine's owner has", async () => {
    const t = await rig();
    const ok = await t.send("POST", "/api/signup", {
      username: "owner",
      password: "long-enough-password",
      setupCode: TOKEN,
    });
    expect(ok.status).toBe(201);
  });

  it("changes the code after five wrong guesses", async () => {
    const t = await rig();
    const first = t.code();
    const guesses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        t.send("POST", "/api/signup", {
          username: "x",
          password: "long-enough-password",
          setupCode: `bad${i}`,
        }),
      ),
    );
    expect(guesses.every((g) => g.status === 403)).toBe(true);
    expect(t.code()).not.toBe(first);
    const old = await t.send("POST", "/api/signup", {
      username: "x",
      password: "long-enough-password",
      setupCode: first,
    });
    expect(old.status).toBe(403);
  }, 15_000);

  it("makes no code when an owner already exists (a restart of a set-up daemon)", async () => {
    const t = await rig({ owner: true });
    t.restart();
    expect(existsSync(t.setupCodePath)).toBe(false);
    expect((await t.send("GET", "/api/auth")).body).toEqual({ initialized: true, setupCodeRequired: false });
  });
});

describe("a login is a session, not the daemon token", () => {
  const login = (t: Awaited<ReturnType<typeof rig>>, headers: Record<string, string> = {}) =>
    t.send("POST", "/api/login", { username: "owner", password: "long-enough-password" }, headers);

  it("hands the browser a random session, stored only as a hash, with the right cookie flags", async () => {
    const t = await rig({ owner: true });
    const a = await login(t);
    const b = await login(t);
    const cookie = a.headers.get("set-cookie") ?? "";
    expect(cookie).not.toContain(TOKEN);
    expect(cookie).toMatch(/^i_inc=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
    expect(t.cookieOf(a)).not.toBe(t.cookieOf(b));
    const raw = t.cookieOf(a).slice("i_inc=".length);
    const rows = t.db.all<{ id_hash: string }>("SELECT id_hash FROM web_sessions");
    expect(rows.length).toBe(3); // the signup's, and these two
    expect(rows.some((r) => r.id_hash === raw)).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(raw);
    expect((await t.send("GET", "/api/board", undefined, { cookie: t.cookieOf(a) })).status).toBe(200);
  });

  it("is Secure when the request came over https (a forwarded proto or an https origin), not over http", async () => {
    const t = await rig({ owner: true });
    expect((await login(t)).headers.get("set-cookie")).not.toContain("Secure");
    const fwd = await login(t, { "x-forwarded-proto": "https" });
    expect(fwd.headers.get("set-cookie")).toMatch(/; Secure$/);
    const origin = await login(t, { origin: "https://iinc.tail.ts.net", host: "iinc.tail.ts.net" });
    expect(origin.headers.get("set-cookie")).toMatch(/; Secure$/);
  });

  it("is revoked by sign out: a copy of the cookie stops working, the other sessions and the bearer token don't", async () => {
    const t = await rig({ owner: true });
    const a = t.cookieOf(await login(t));
    const other = t.cookieOf(await login(t));
    expect((await t.send("GET", "/api/board", undefined, { cookie: a })).status).toBe(200);
    const out = await t.send("POST", "/api/logout", {}, { cookie: a });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await t.send("GET", "/api/board", undefined, { cookie: a })).status).toBe(401);
    expect((await t.send("GET", "/api/board", undefined, { cookie: other })).status).toBe(200);
    expect((await t.send("GET", "/api/board", undefined, { authorization: `Bearer ${TOKEN}` })).status).toBe(
      200,
    );
  });

  it("expires after 30 days, and use renews it", async () => {
    const t = await rig({ owner: true });
    const a = t.cookieOf(await login(t));
    t.app.clock.advance(20 * 24 * 60);
    // used on day 20: the cookie is sent again with a fresh 30 days
    const used = await t.send("GET", "/api/board", undefined, { cookie: a });
    expect(used.status).toBe(200);
    expect(used.headers.get("set-cookie")).toContain(`${a}; HttpOnly`);
    t.app.clock.advance(20 * 24 * 60); // day 40: past the first expiry, inside the renewed one
    expect((await t.send("GET", "/api/board", undefined, { cookie: a })).status).toBe(200);
    t.app.clock.advance(31 * 24 * 60); // unused for 31 days
    expect((await t.send("GET", "/api/board", undefined, { cookie: a })).status).toBe(401);
  });

  it("does not renew on every request (once a day at most)", async () => {
    const t = await rig({ owner: true });
    const a = t.cookieOf(await login(t));
    const first = await t.send("GET", "/api/board", undefined, { cookie: a });
    expect(first.headers.get("set-cookie")).toBeNull();
  });

  it("keeps bearer-token auth for scripts, and never sets a cookie for it", async () => {
    const t = await rig({ owner: true });
    const r = await t.send("GET", "/api/board", undefined, { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect((await t.send("GET", "/api/board", undefined, { authorization: "Bearer nope" })).status).toBe(401);
  });

  it("rejects a made-up cookie", async () => {
    const t = await rig({ owner: true });
    expect(
      (
        await t.send("GET", "/api/board", undefined, {
          cookie: "i_inc=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        })
      ).status,
    ).toBe(401);
  });
});

describe("a browser logged in before sessions", () => {
  it("keeps working: its cookie (the daemon token) is swapped for a session on its next request", async () => {
    const t = await rig({ owner: true });
    const old = { cookie: `i_inc=${TOKEN}` };
    // a script sending that cookie works and is not given a session
    const script = await t.send("GET", "/api/board", undefined, old);
    expect(script.status).toBe(200);
    expect(script.headers.get("set-cookie")).toBeNull();
    // a browser (it sends Sec-Fetch headers) gets a session cookie, the same one for a minute
    const browser = await t.send("GET", "/api/board", undefined, { ...old, "sec-fetch-site": "same-origin" });
    expect(browser.status).toBe(200);
    const cookie = t.cookieOf(browser);
    expect(cookie).toMatch(/^i_inc=[A-Za-z0-9_-]{40,}$/);
    expect(cookie).not.toContain(TOKEN);
    const second = await t.send("GET", "/api/board", undefined, { ...old, "sec-fetch-site": "same-origin" });
    expect(t.cookieOf(second)).toBe(cookie);
    expect((await t.send("GET", "/api/board", undefined, { cookie })).status).toBe(200);
    // and signing out of that session revokes it
    await t.send("POST", "/api/logout", {}, { cookie });
    expect((await t.send("GET", "/api/board", undefined, { cookie })).status).toBe(401);
  });

  it("is not given a cookie on a 401", async () => {
    const t = await rig({ owner: true });
    const r = await t.send("GET", "/api/board", undefined, {
      cookie: "i_inc=wrong",
      "sec-fetch-site": "same-origin",
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toBeNull();
  });
});

describe("the AHP upgrade accepts a session", () => {
  it("lets a session cookie through and refuses a revoked one", async () => {
    const t = await rig({ owner: true });
    const { WebSessions } = await import("../src/web-sessions.ts");
    const sessions = new WebSessions(t.db, () => t.app.clock.now());
    const s = sessions.create();
    const transport = new AhpTransport(t.app.ahp.host, { token: TOKEN, sessions, hosts: [HOST] });
    const upgrade = (cookie: string) =>
      new Request(`http://${HOST}/ahp`, {
        headers: { host: HOST, upgrade: "websocket", connection: "Upgrade", cookie },
      });
    expect(transport.guard(upgrade(`i_inc=${s.token}`))).toHaveProperty("data");
    sessions.revoke(s.token);
    expect(transport.guard(upgrade(`i_inc=${s.token}`))).toHaveProperty("refusal");
  });
});
