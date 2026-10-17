// Owner account signup, username + password login, and token compatibility.
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";
import { testApp } from "./setup.ts";

describe("owner signup and login API", () => {
  async function guardedApp() {
    const app = await testApp();
    const handle = createApi(app.daemon, app.deps, {
      token: "s3cret-token",
      hosts: ["127.0.0.1:7420"],
    });
    const send = async (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const res = await handle(
        new Request(`http://127.0.0.1:7420${path}`, {
          method,
          ...(method === "GET"
            ? { headers: { host: "127.0.0.1:7420", ...headers } }
            : {
                body: JSON.stringify(body ?? {}),
                headers: {
                  host: "127.0.0.1:7420",
                  "content-type": "application/json",
                  ...headers,
                },
              }),
        }),
      );
      const data = (await res.json()) as Record<string, unknown>;
      return { status: res.status, body: data, headers: res.headers };
    };
    return { app, send };
  }

  it("reports initialized=false before signup and initialized=true after signup, without needing the token", async () => {
    const { send } = await guardedApp();
    expect((await send("GET", "/api/board")).status).toBe(401);

    const before = await send("GET", "/api/auth");
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ initialized: false });

    const created = await send("POST", "/api/signup", {
      username: "  owner  ",
      password: "correct-horse-battery",
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ ok: true, username: "owner" });
    const cookie = created.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("i_inc=s3cret-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=31536000");

    const after = await send("GET", "/api/auth");
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ initialized: true });

    const board = await send("GET", "/api/board", undefined, {
      cookie: cookie.split(";")[0] as string,
    });
    expect(board.status).toBe(200);
  });

  it("validates username and password length on signup and rejects duplicate signup with 409", async () => {
    const { send } = await guardedApp();

    const emptyUser = await send("POST", "/api/signup", {
      username: "   ",
      password: "long-enough-password",
    });
    expect(emptyUser.status).toBe(400);
    expect(emptyUser.body.error).toBeTruthy();

    const shortPass = await send("POST", "/api/signup", {
      username: "owner",
      password: "short",
    });
    expect(shortPass.status).toBe(400);
    expect(shortPass.body.error).toBeTruthy();

    const ok = await send("POST", "/api/signup", {
      username: "owner",
      password: "long-enough-password",
    });
    expect(ok.status).toBe(201);

    const duplicate = await send("POST", "/api/signup", {
      username: "other",
      password: "another-long-password",
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({ error: "owner account already exists" });
  });

  it("logs in with username + password, rejects wrong credentials, and keeps token login working", async () => {
    const { send } = await guardedApp();

    // Password login before signup fails with 400.
    const beforeSignup = await send("POST", "/api/login", {
      username: "owner",
      password: "long-enough-password",
    });
    expect(beforeSignup.status).toBe(400);
    expect(beforeSignup.body).toEqual({ error: "create an owner account first" });

    await send("POST", "/api/signup", {
      username: "owner",
      password: "long-enough-password",
    });

    const wrongPass = await send("POST", "/api/login", {
      username: "owner",
      password: "wrong-password-123",
    });
    expect(wrongPass.status).toBe(401);
    expect(wrongPass.body).toEqual({ error: "wrong username or password" });

    const wrongUser = await send("POST", "/api/login", {
      username: "intruder",
      password: "long-enough-password",
    });
    expect(wrongUser.status).toBe(401);
    expect(wrongUser.body).toEqual({ error: "wrong username or password" });

    const okLogin = await send("POST", "/api/login", {
      username: "owner",
      password: "long-enough-password",
    });
    expect(okLogin.status).toBe(200);
    expect(okLogin.body).toEqual({ ok: true });
    expect(okLogin.headers.get("set-cookie")).toContain("i_inc=s3cret-token");

    // Existing { token } login and Bearer header still work.
    const tokenLogin = await send("POST", "/api/login", { token: "s3cret-token" });
    expect(tokenLogin.status).toBe(200);
    expect(tokenLogin.body).toEqual({ ok: true });
    expect(tokenLogin.headers.get("set-cookie")).toContain("i_inc=s3cret-token");

    const bearerBoard = await send("GET", "/api/board", undefined, {
      authorization: "Bearer s3cret-token",
    });
    expect(bearerBoard.status).toBe(200);
  });
});
