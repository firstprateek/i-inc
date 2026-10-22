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
    createApi(app.daemon, app.deps, {
      token: TOKEN,
      hosts: [HOST, "iinc.tail.ts.net"],
      setupCodePath,
      heartbeatMs: 40,
    });
  let handle = mk();
  const send = async (
    method: string,
    path: string,
    body?: unknown,
    allHeaders: Record<string, string> = {},
  ) => {
    // "x-test-peer" is not a header: it is the socket's peer address, which the daemon learns from Bun, not the client.
    const { "x-test-peer": peer, ...headers } = allHeaders;
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
      { peer },
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
  return {
    app,
    send,
    code,
    setupCodePath,
    logs,
    cookieOf,
    restart: () => (handle = mk()),
    stream: (headers: Record<string, string>) =>
      handle(new Request(`http://${HOST}/api/events`, { headers: { host: HOST, ...headers } })),
    db: app.db,
  };
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
    // the log says where the code is, never what it is
    expect(t.logs.some((l) => l.includes(t.code()))).toBe(false);
    expect(t.logs.some((l) => l.includes(t.setupCodePath))).toBe(true);
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

  const signupWith = (t: Awaited<ReturnType<typeof rig>>, setupCode: string, client: string) =>
    t.send(
      "POST",
      "/api/signup",
      { username: "x", password: "long-enough-password", setupCode },
      { "x-forwarded-for": client },
    );

  it("limits wrong guesses per client: one peer can neither guess on nor invalidate the code for the owner", async () => {
    const t = await rig();
    const code = t.code();
    const wrong = await Promise.all(
      Array.from({ length: 5 }, (_, i) => signupWith(t, `bad${i}`, "100.64.0.9")),
    );
    expect(wrong.every((g) => g.status === 403)).toBe(true);
    // the attacker is told to wait, even with the right code; the code is unchanged
    const blocked = await signupWith(t, code, "100.64.0.9");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(t.code()).toBe(code);
    // another client is not affected, and the owner gets in
    expect((await signupWith(t, "bad", "100.64.0.20")).status).toBe(403);
    expect((await signupWith(t, code, "100.64.0.20")).status).toBe(201);
  }, 15_000);

  it("lets a blocked client try again after the window", async () => {
    const t = await rig();
    await Promise.all(Array.from({ length: 5 }, (_, i) => signupWith(t, `bad${i}`, "100.64.0.9")));
    expect((await signupWith(t, "again", "100.64.0.9")).status).toBe(429);
    t.app.clock.advance(11); // minutes
    expect((await signupWith(t, "again", "100.64.0.9")).status).toBe(403);
  }, 15_000);

  it("caps wrong guesses across all clients: 20, then an hour's refusal, and one new code", async () => {
    const t = await rig();
    const first = t.code();
    await Promise.all(Array.from({ length: 19 }, (_, i) => signupWith(t, `bad${i}`, `100.64.1.${i}`)));
    expect(t.code()).toBe(first);
    await signupWith(t, "bad-last", "100.64.2.1"); // the 20th
    const second = t.code();
    expect(second).not.toBe(first);
    // everyone is refused for the hour, the owner's new code included
    const refused = await signupWith(t, second, "100.64.3.1");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(3000);
    t.app.clock.advance(30);
    expect((await signupWith(t, second, "100.64.3.2")).status).toBe(429);
    t.app.clock.advance(31);
    // an hour on: the old code is dead, the new one works, and the code was not rotated again meanwhile
    expect(t.code()).toBe(second);
    expect((await signupWith(t, first, "100.64.3.3")).status).toBe(403);
    expect((await signupWith(t, second, "100.64.3.4")).status).toBe(201);
  }, 30_000);

  it("cannot be dodged by spoofing X-Forwarded-For: only the hop the proxy appended counts", async () => {
    const t = await rig();
    const code = t.code();
    // the same real client (last hop) behind a different made-up prefix each time
    const spoofed = (i: number) => signupWith(t, `bad${i}`, `10.0.${i}.1, 10.0.${i}.2, 100.64.0.9`);
    const first = await Promise.all(Array.from({ length: 5 }, (_, i) => spoofed(i)));
    expect(first.every((r) => r.status === 403)).toBe(true);
    expect((await spoofed(5)).status).toBe(429);
    expect((await signupWith(t, code, "evil-1, evil-2, 100.64.0.9")).status).toBe(429);
    // a different real client is not caught by it
    expect((await signupWith(t, code, "evil-1, 100.64.0.77")).status).toBe(201);
  }, 20_000);

  it("keys a connection that did not come from the proxy by its socket address, ignoring its headers", async () => {
    const t = await rig();
    const direct = (i: number) =>
      t.send(
        "POST",
        "/api/signup",
        { username: "x", password: "long-enough-password", setupCode: `bad${i}` },
        { "x-forwarded-for": `1.2.3.${i}`, "x-test-peer": "192.168.1.50" },
      );
    const first = await Promise.all(Array.from({ length: 5 }, (_, i) => direct(i)));
    expect(first.every((r) => r.status === 403)).toBe(true);
    expect((await direct(9)).status).toBe(429);
  }, 20_000);

  it("ignores identity headers such as Tailscale-User-Login: varying one cannot dodge the limit", async () => {
    const t = await rig();
    const as = (login: string, i: number) =>
      t.send(
        "POST",
        "/api/signup",
        { username: "x", password: "long-enough-password", setupCode: `bad${i}` },
        { "x-forwarded-for": "100.64.0.9", "tailscale-user-login": login },
      );
    await Promise.all(Array.from({ length: 5 }, (_, i) => as(`a${i}@example.com`, i)));
    expect((await as("someone-else@example.com", 9)).status).toBe(429);
  }, 20_000);

  it("writes the code file with mode 0600 every time, replacing an old readable one", async () => {
    const t = await rig();
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(t.setupCodePath, "old\n", { mode: 0o644 });
    chmodSync(t.setupCodePath, 0o644);
    t.restart();
    expect(statSync(t.setupCodePath).mode & 0o777).toBe(0o600);
    expect(t.code()).not.toBe("old");
  });

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

  it("is Secure on every host but loopback (and on loopback behind an https proxy)", async () => {
    const t = await rig({ owner: true });
    // the browser on the machine itself, over plain http: no Secure, or it couldn't be stored
    for (const host of ["127.0.0.1:7420"])
      expect((await login(t, { host })).headers.get("set-cookie")).not.toContain("Secure");
    // the tailnet name, with no X-Forwarded-Proto and no Origin at all
    const bare = await login(t, { host: "iinc.tail.ts.net" });
    expect(bare.headers.get("set-cookie")).toMatch(/; Secure$/);
    expect((await login(t, { "x-forwarded-proto": "https" })).headers.get("set-cookie")).toMatch(/; Secure$/);
  });

  it("keeps Secure when a GET renews the cookie on the tailnet name", async () => {
    const t = await rig({ owner: true });
    const a = t.cookieOf(await login(t));
    t.app.clock.advance(2 * 24 * 60);
    const renewed = await t.send("GET", "/api/board", undefined, { cookie: a, host: "iinc.tail.ts.net" });
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get("set-cookie")).toMatch(
      /; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure$/,
    );
    // the old cookie swapped for a session on the tailnet name is Secure too
    const legacy = await t.send("GET", "/api/board", undefined, {
      cookie: `i_inc=${TOKEN}`,
      "sec-fetch-site": "same-origin",
      host: "iinc.tail.ts.net",
    });
    expect(legacy.headers.get("set-cookie")).toMatch(/; Secure$/);
  });

  it("throttles password logins per client, before any password is hashed", async () => {
    const t = await rig({ owner: true });
    const wrong = (client: string) =>
      t.send(
        "POST",
        "/api/login",
        { username: "owner", password: "wrong-password" },
        { "x-forwarded-for": client },
      );
    const first = await Promise.all(Array.from({ length: 10 }, () => wrong("100.64.0.5")));
    expect(first.every((r) => r.status === 401)).toBe(true);
    expect((await wrong("100.64.0.5")).status).toBe(429);
    // even the right password waits for that client; another client is fine
    const right = { username: "owner", password: "long-enough-password" };
    expect((await t.send("POST", "/api/login", right, { "x-forwarded-for": "100.64.0.5" })).status).toBe(429);
    expect((await t.send("POST", "/api/login", right, { "x-forwarded-for": "100.64.0.6" })).status).toBe(200);
  }, 20_000);

  it("ignores Tailscale-User-Login on password logins too", async () => {
    const t = await rig({ owner: true });
    const wrong = (i: number) =>
      t.send(
        "POST",
        "/api/login",
        { username: "owner", password: "wrong-password" },
        { "x-forwarded-for": "100.64.0.5", "tailscale-user-login": `u${i}@example.com` },
      );
    await Promise.all(Array.from({ length: 10 }, (_, i) => wrong(i)));
    expect((await wrong(99)).status).toBe(429);
  }, 30_000);

  it("caps wrong passwords across all clients: 100 in an hour, then logins are refused for 15 minutes", async () => {
    const t = await rig({ owner: true });
    const wrong = (i: number) =>
      t.send(
        "POST",
        "/api/login",
        { username: "owner", password: "wrong-password" },
        { "x-forwarded-for": `100.64.${Math.floor(i / 200)}.${i % 200}` },
      );
    // 100 clients, one wrong password each: none is limited on its own
    const wave = await Promise.all(Array.from({ length: 100 }, (_, i) => wrong(i)));
    expect(wave.every((r) => r.status === 401)).toBe(true);
    // now everyone waits, even with the right password, from a fresh client
    const right = { username: "owner", password: "long-enough-password" };
    const refused = await t.send("POST", "/api/login", right, { "x-forwarded-for": "100.64.9.9" });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(800);
    t.app.clock.advance(14);
    expect((await t.send("POST", "/api/login", right, { "x-forwarded-for": "100.64.9.9" })).status).toBe(429);
    t.app.clock.advance(2);
    expect((await t.send("POST", "/api/login", right, { "x-forwarded-for": "100.64.9.9" })).status).toBe(200);
  }, 60_000);

  it("is not dodged by spoofed X-Forwarded-For prefixes on password logins", async () => {
    const t = await rig({ owner: true });
    const wrong = (i: number) =>
      t.send(
        "POST",
        "/api/login",
        { username: "owner", password: "wrong-password" },
        { "x-forwarded-for": `9.9.${i}.1, 8.8.${i}.1, 100.64.0.5` },
      );
    const first = await Promise.all(Array.from({ length: 10 }, (_, i) => wrong(i)));
    expect(first.every((r) => r.status === 401)).toBe(true);
    expect((await wrong(11)).status).toBe(429);
    expect((await wrong(12)).status).toBe(429);
  }, 30_000);

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

describe("the event stream is tied to the session", () => {
  const login = (t: Awaited<ReturnType<typeof rig>>) =>
    t.send("POST", "/api/login", { username: "owner", password: "long-enough-password" });

  /** Reads the stream until it ends or `ms` passes: true when it ended. */
  async function ends(res: Response, ms = 2000): Promise<boolean> {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await Promise.race([
        reader.read(),
        new Promise<null>((ok) => setTimeout(() => ok(null), 100)),
      ]);
      if (r?.done) return true;
    }
    return false;
  }

  it("ends when the session is signed out", async () => {
    const t = await rig({ owner: true });
    const cookie = t.cookieOf(await login(t));
    const res = await t.stream({ cookie });
    expect(res.status).toBe(200);
    await t.send("POST", "/api/logout", {}, { cookie });
    expect(await ends(res)).toBe(true);
  });

  it("ends when the session expires, and delivers nothing more", async () => {
    const t = await rig({ owner: true });
    const cookie = t.cookieOf(await login(t));
    const res = await t.stream({ cookie });
    t.app.clock.advance(31 * 24 * 60);
    expect(await ends(res)).toBe(true); // the heartbeat (40 ms here) notices
  });

  it("leaves another session's stream and a bearer-token stream open", async () => {
    const t = await rig({ owner: true });
    const a = t.cookieOf(await login(t));
    const b = t.cookieOf(await login(t));
    const sa = await t.stream({ cookie: a });
    const sb = await t.stream({ cookie: b });
    const st = await t.stream({ authorization: `Bearer ${TOKEN}` });
    await t.send("POST", "/api/logout", {}, { cookie: a });
    expect(await ends(sa)).toBe(true);
    expect(await ends(sb, 400)).toBe(false);
    expect(await ends(st, 400)).toBe(false);
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
