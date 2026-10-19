// Owner account signup, username + password login, and token compatibility.
import type { FakeMachines } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";
import { refunds, testApp } from "./setup.ts";

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

describe("POST /api/employees team assignment", () => {
  const hire = { name: "Nell", duties: ["build"], engines: { default: "opus", fallbacks: [] } };

  it("assigns a new hire to the requested team and removes stale membership elsewhere", async () => {
    const app = await testApp();
    await app.call("PUT", "/api/teams/old", { name: "Old", members: ["ada"] });
    await app.call("PUT", "/api/teams/target", { name: "Target", members: [] });
    app.deps.registry.addTeam({ id: "stale", name: "Stale", members: ["nell"] });

    const res = await app.call("POST", "/api/employees", { ...hire, teamId: "target" });
    expect(res.status).toBe(201);
    const teams = (await app.call("GET", "/api/teams")).body.teams;
    expect(teams.find((team: { id: string }) => team.id === "target").members).toContain("nell");
    expect(teams.find((team: { id: string }) => team.id === "stale").members).not.toContain("nell");
    expect(app.deps.registry.teamOf("nell").id).toBe("target");
  });

  it("rejects an unknown team before creating the employee", async () => {
    const app = await testApp();
    await app.call("PUT", "/api/teams/engineering", { name: "Engineering", members: [] });
    const res = await app.call("POST", "/api/employees", { ...hire, teamId: "missing" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("teamId must name an existing team");
    expect(app.deps.registry.employees().some((employee) => employee.id === "nell")).toBe(false);
  });

  it("defaults to the only configured team", async () => {
    const app = await testApp();
    await app.call("PUT", "/api/teams/engineering", { name: "Engineering", members: [] });
    const res = await app.call("POST", "/api/employees", hire);
    expect(res.status).toBe(201);
    expect(app.deps.registry.teamOf("nell").id).toBe("engineering");
  });

  it("requires a selection when multiple teams are configured", async () => {
    const app = await testApp();
    await app.call("PUT", "/api/teams/engineering", { name: "Engineering", members: [] });
    await app.call("PUT", "/api/teams/design", { name: "Design", members: [] });
    const res = await app.call("POST", "/api/employees", hire);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("choose a team before hiring");
    expect(app.deps.registry.employees().some((employee) => employee.id === "nell")).toBe(false);
  });

  it("keeps the Company fallback when no teams exist", async () => {
    const app = await testApp();
    const res = await app.call("POST", "/api/employees", hire);
    expect(res.status).toBe(201);
    expect(app.deps.registry.teamOf("nell").id).toBe("company");
  });
});

describe("PUT /api/employees/:id", () => {
  it("returns 404 if employee does not exist", async () => {
    const app = await testApp();
    const res = await app.call("PUT", "/api/employees/non-existent", {
      name: "Ghost",
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "no such employee" });
  });

  it("updates an existing employee in place, preserving existing fields and tint", async () => {
    const app = await testApp();
    const before = (await app.call("GET", "/api/employees")).body.employees.find(
      (e: { id: string }) => e.id === "ada",
    );
    expect(before).toBeTruthy();
    expect(before.name).toBe("Ada");

    const res = await app.call("PUT", "/api/employees/ada", {
      name: "Ada Lovelace",
      role: "Principal Engineer",
      duties: ["build"],
      workingHours: { from: 9, to: 17 },
      projects: ["Duet"],
    });

    expect(res.status).toBe(200);
    expect(res.body.employee).toMatchObject({
      id: "ada",
      name: "Ada Lovelace",
      role: "Principal Engineer",
      duties: ["build"],
      workingHours: { from: 9, to: 17 },
      projects: ["Duet"],
      engines: before.engines,
      switchRules: before.switchRules,
      tint: before.tint,
    });

    // Check registry was updated
    const after = (await app.call("GET", "/api/employees")).body.employees.find(
      (e: { id: string }) => e.id === "ada",
    );
    expect(after.name).toBe("Ada Lovelace");
    expect(after.role).toBe("Principal Engineer");
  });

  it("validates employee updates with hiringProblems", async () => {
    const app = await testApp();

    // Invalid engine
    const badEngine = await app.call("PUT", "/api/employees/ada", {
      engines: { default: "imaginary-engine", fallbacks: [] },
    });
    expect(badEngine.status).toBe(400);
    expect(badEngine.body.error).toContain("there is no engine imaginary-engine");

    // Empty duties
    const emptyDuties = await app.call("PUT", "/api/employees/ada", {
      duties: [],
    });
    expect(emptyDuties.status).toBe(400);
    expect(emptyDuties.body.error).toContain("an employee needs at least one duty");

    // Personal Assistant on cloud engine
    const paCloud = await app.call("PUT", "/api/employees/ada", {
      role: "Personal Assistant",
      engines: { default: "opus", fallbacks: [] }, // opus is cloud (local: false)
    });
    expect(paCloud.status).toBe(400);
    expect(paCloud.body.error).toContain("Personal Assistant works on home data");

    // Personal Assistant on local engine succeeds
    const paLocal = await app.call("PUT", "/api/employees/ada", {
      role: "Personal Assistant",
      engines: { default: "qwen", fallbacks: [] }, // qwen is local: true
    });
    expect(paLocal.status).toBe(200);
    expect(paLocal.body.employee.role).toBe("Personal Assistant");
  });
});

describe("accounts API and rate limits", () => {
  it("updates an account with monthlyCap and retrieves live rate limits", async () => {
    const app = await testApp();

    const putRes = await app.call("PUT", "/api/accounts/claude-pro", {
      name: "Claude Pro",
      monthlyFee: 200,
      monthlyCap: 150,
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body.account).toMatchObject({
      id: "claude-pro",
      name: "Claude Pro",
      monthlyFee: 200,
      monthlyCap: 150,
    });

    app.deps.registry.setAccountRateLimit("claude-pro", {
      status: "allowed",
      fiveHourUtilization: 0.45,
      sevenDayUtilization: 0.2,
      resetsAt: 1_790_600_000_000,
      updatedAt: 1_000,
    });

    const getRes = await app.call("GET", "/api/accounts");
    expect(getRes.status).toBe(200);
    expect(getRes.body.accounts.find((a: { id: string }) => a.id === "claude-pro")).toMatchObject({
      id: "claude-pro",
      monthlyCap: 150,
    });
    expect(getRes.body.rateLimits["claude-pro"]).toEqual({
      status: "allowed",
      fiveHourUtilization: 0.45,
      sevenDayUtilization: 0.2,
      resetsAt: 1_790_600_000_000,
      updatedAt: 1_000,
    });
  });
});

describe("POST /api/teams/:id/antigravity-callback", () => {
  it("rejects non-existent team with 404", async () => {
    const app = await testApp();
    const res = await app.call("POST", "/api/teams/missing-team/antigravity-callback", {
      url: "http://127.0.0.1:4567/callback?code=abc",
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "no such team" });
  });

  it("validates that the callback URL is http://127.0.0.1:<port>/ or http://localhost:<port>/", async () => {
    const app = await testApp();
    await app.call("PUT", "/api/teams/devs", { name: "Devs", members: ["ada"] });

    const badProtocol = await app.call("POST", "/api/teams/devs/antigravity-callback", {
      url: "https://127.0.0.1:4567/callback",
    });
    expect(badProtocol.status).toBe(400);

    const badHost = await app.call("POST", "/api/teams/devs/antigravity-callback", {
      url: "http://example.com:4567/callback",
    });
    expect(badHost.status).toBe(400);

    const missingUrl = await app.call("POST", "/api/teams/devs/antigravity-callback", {});
    expect(missingUrl.status).toBe(400);
  });

  it("delivers valid callback URL to machines provider", async () => {
    const app = await testApp();
    await app.call("PUT", "/api/teams/devs", { name: "Devs", members: ["ada"] });

    const res = await app.call("POST", "/api/teams/devs/antigravity-callback", {
      url: "http://127.0.0.1:8085/oauth2callback?code=xyz",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const machines = app.deps.machines as FakeMachines;
    expect(machines.callbacks).toContainEqual({
      teamId: "devs",
      url: "http://127.0.0.1:8085/oauth2callback?code=xyz",
    });
  });
});

describe("usage caps and rate limit scheduling", () => {
  it("populates capReachedUntil on saturated or rejected rate limits and pauses tickets", async () => {
    // Rejected status
    const appRejected = await testApp();
    const resetTime = appRejected.clock.now() + 3_600_000;
    appRejected.deps.registry.setAccountRateLimit("claude-pro", {
      status: "rejected",
      resetsAt: resetTime,
      updatedAt: appRejected.clock.now(),
    });
    await appRejected.call("POST", "/api/tickets", refunds);
    expect(appRejected.daemon.waiting).toContainEqual({
      ticketId: "1",
      reason: "Ada reached its usage cap",
    });
    const boardRejected = (await appRejected.call("GET", "/api/board")).body.tickets;
    expect(boardRejected.find((t: { id: string }) => t.id === "1")?.waiting).toBe(
      "Ada reached its usage cap",
    );

    // Saturated utilization >= 1
    const appSaturated = await testApp();
    const satResetTime = appSaturated.clock.now() + 3_600_000;
    appSaturated.deps.registry.setAccountRateLimit("claude-pro", {
      status: "allowed",
      fiveHourUtilization: 1.0,
      resetsAt: satResetTime,
      updatedAt: appSaturated.clock.now(),
    });
    await appSaturated.call("POST", "/api/tickets", refunds);
    expect(appSaturated.daemon.waiting).toContainEqual({
      ticketId: "1",
      reason: "Ada reached its usage cap",
    });
  });

  it("populates capReachedUntil when monthlyFee exceeds monthlyCap until the next UTC month", async () => {
    const app = await testApp();

    app.deps.registry.addAccount({
      id: "claude-pro",
      name: "Claude Pro",
      monthlyFee: 250,
      monthlyCap: 100,
    });

    await app.call("POST", "/api/tickets", refunds);
    expect(app.daemon.waiting).toContainEqual({
      ticketId: "1",
      reason: "Ada reached its usage cap",
    });

    const board = (await app.call("GET", "/api/board")).body.tickets;
    const ticket = board.find((t: { id: string }) => t.id === "1");
    expect(ticket.waiting).toBe("Ada reached its usage cap");
  });
});

describe("POST /api/logout", () => {
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

  it("clears the session cookie on POST /api/logout even without bearer or cookie token", async () => {
    const { send } = await guardedApp();
    const res = await send("POST", "/api/logout", {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("i_inc=;");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("GET /api/office with accounts and rate limits", () => {
  it("returns accounts and rateLimits alongside employees", async () => {
    const app = await testApp();
    app.deps.registry.setAccountRateLimit("claude-pro", {
      status: "allowed",
      fiveHourUtilization: 0.42,
      sevenDayUtilization: 0.65,
      updatedAt: app.clock.now(),
    });

    const res = await app.call("GET", "/api/office");
    expect(res.status).toBe(200);
    expect(res.body.employees.length).toBeGreaterThan(0);
    expect(res.body.accounts.length).toBeGreaterThan(0);
    expect(res.body.rateLimits["claude-pro"]).toMatchObject({
      status: "allowed",
      fiveHourUtilization: 0.42,
      sevenDayUtilization: 0.65,
    });
  });

  it("enriches accounts with bound models, harnesses, and windowed telemetry", async () => {
    const app = await testApp();
    const now = app.clock.now();

    // Add accounts and engines
    app.deps.registry.addAccount({ id: "google-pro", name: "Google AI Pro" });
    app.deps.registry.addEngine({
      id: "gemini",
      harness: "antigravity",
      model: "gemini-2.5-pro",
      accountId: "google-pro",
      local: false,
    });
    app.deps.registry.addAccount({ id: "local-acc", name: "Local Ollama" });
    app.deps.registry.addEngine({
      id: "qwen",
      harness: "opencode",
      model: "qwen3:8b",
      accountId: "local-acc",
      local: true,
    });

    // 1. Straddling session on 5h boundary: started 5.5h ago, ended 4.5h ago
    // In 5h window: overlaps 4.5h ago to 5h ago = 30m active, 1 session
    // In 7d window: 60m active, 1 session
    app.deps.db.run(
      "INSERT INTO ticket_sessions (ticket_id, stage, employee_id, engine_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
      "t1",
      "build",
      "ada",
      "gemini",
      now - Math.round(5.5 * 3_600_000),
      now - Math.round(4.5 * 3_600_000),
    );

    // 2. Overlapping sessions: 3 sessions occurring during the same 10-minute interval (-30m to -20m)
    // Should merge to 10 minutes, not 30 minutes!
    for (let i = 0; i < 3; i++) {
      app.deps.db.run(
        "INSERT INTO ticket_sessions (ticket_id, stage, employee_id, engine_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
        `t-overlap-${i}`,
        "build",
        "ada",
        "gemini",
        now - 30 * 60_000,
        now - 20 * 60_000,
      );
    }

    // 3. Orphan running session: started 6 days ago with null ended_at
    // Must be capped at 2 hours, so 0m in 5h window, 120m in 7d window!
    app.deps.db.run(
      "INSERT INTO ticket_sessions (ticket_id, stage, employee_id, engine_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
      "t-orphan",
      "build",
      "ada",
      "gemini",
      now - 6 * 24 * 3_600_000,
      null,
    );

    // 4. Future start session: started in future (now + 1h), must be ignored!
    app.deps.db.run(
      "INSERT INTO ticket_sessions (ticket_id, stage, employee_id, engine_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
      "t-future",
      "build",
      "ada",
      "gemini",
      now + 3_600_000,
      now + 2 * 3_600_000,
    );

    // 5. Negative duration session: ended before start, must be ignored!
    app.deps.db.run(
      "INSERT INTO ticket_sessions (ticket_id, stage, employee_id, engine_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
      "t-negative",
      "build",
      "ada",
      "gemini",
      now - 10 * 60_000,
      now - 20 * 60_000,
    );

    const res = await app.call("GET", "/api/accounts");
    expect(res.status).toBe(200);
    const google = res.body.accounts.find((a: { id: string }) => a.id === "google-pro");
    expect(google).toBeDefined();
    expect(google.models).toEqual(["gemini-2.5-pro"]);
    expect(google.harnesses).toEqual(["antigravity"]);
    // 5h window: straddling session (1) + 3 overlapping sessions (3) = 4 sessions
    // Active minutes: 30m (straddling) + 10m (merged overlapping) = 40m
    expect(google.fiveHourSessions).toBe(4);
    expect(google.fiveHourMinutes).toBe(40);

    // 7d window: straddling (1) + 3 overlapping (3) + 1 orphan (1) = 5 sessions
    // Active minutes: 60m (straddling) + 10m (merged overlapping) + 120m (capped orphan) = 190m
    expect(google.sevenDaySessions).toBe(5);
    expect(google.sevenDayMinutes).toBe(190);

    const local = res.body.accounts.find((a: { id: string }) => a.id === "local-acc");
    expect(local).toBeDefined();
    expect(local.models).toEqual(["qwen3:8b"]);
    expect(local.harnesses).toEqual(["opencode"]);
    expect(local.fiveHourSessions).toBe(0);
    expect(local.fiveHourMinutes).toBe(0);
  });

  it("expires rejected limits past resetsAt and prevents downgrade of active unexpired rejected status", async () => {
    const app = await testApp();
    const now = app.clock.now();

    // 1. Expired rejected limit: resetsAt is in the past
    app.deps.registry.setAccountRateLimit("expired-acc", {
      status: "rejected",
      resetsAt: now - 60_000,
      fiveHourUtilization: 1.0,
      updatedAt: now - 120_000,
    });

    // 2. Active unexpired rejected limit
    app.deps.registry.setAccountRateLimit("active-rejected", {
      status: "rejected",
      resetsAt: now + 3_600_000,
      fiveHourUtilization: 0.95,
      updatedAt: now,
    });

    // Attempt to downgrade active-rejected with an unexpired status
    app.deps.registry.setAccountRateLimit("active-rejected", {
      status: "allowed",
      updatedAt: now + 1000,
    });

    const res = await app.call("GET", "/api/accounts");
    expect(res.status).toBe(200);

    // Expired account should no longer have status: "rejected"
    expect(res.body.rateLimits["expired-acc"]?.status).toBeUndefined();
    expect(res.body.rateLimits["expired-acc"]?.fiveHourUtilization).toBe(1.0);

    // Active unexpired account must still have status: "rejected" (downgrade rejected)
    expect(res.body.rateLimits["active-rejected"]?.status).toBe("rejected");
    expect(res.body.rateLimits["active-rejected"]?.resetsAt).toBe(now + 3_600_000);
    expect(res.body.rateLimits["active-rejected"]?.fiveHourUtilization).toBe(0.95);
  });
});

describe("releases API and one-click releases", () => {
  it("rejects invalid autoRelease on PUT /api/projects/:id", async () => {
    const app = await testApp();
    const bad = await app.call("PUT", "/api/projects/Duet", {
      repo: "firstprateek/duet",
      checks: ["pnpm test"],
      autoRelease: "yes",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("autoRelease must be a boolean");
  });

  it("returns pending releases, handles validation and records project releases", async () => {
    const app = await testApp();

    const initial = await app.call("GET", "/api/releases");
    expect(initial.status).toBe(200);
    expect(initial.body.releases).toEqual([]);
    const duetInitial = initial.body.pending.find((p: { project: string }) => p.project === "Duet");
    expect(duetInitial.pendingTickets).toEqual([]);

    const emptyCut = await app.call("POST", "/api/projects/Duet/release", {});
    expect(emptyCut.status).toBe(400);
    expect(emptyCut.body.error).toBe("no unreleased merged tickets");

    const noProject = await app.call("POST", "/api/projects/Nonexistent/release", {});
    expect(noProject.status).toBe(404);

    const t1 = app.clock.now();
    await app.deps.store.append("1", [
      { type: "ticket-created", at: t1, ticketId: "1" },
      { type: "pushed", at: t1 + 50, sha: "sha123" },
      { type: "closed", at: t1 + 100, outcome: "merged" },
    ]);
    app.deps.tickets.create({ ...refunds, type: "fix", effort: "medium", title: "Fix refunds" }, t1);

    const pendingRes = await app.call("GET", "/api/releases");
    const duetPending = pendingRes.body.pending.find((p: { project: string }) => p.project === "Duet");
    expect(duetPending?.pendingTickets).toEqual([{ id: "1", title: "Fix refunds", pushed: "sha123" }]);

    app.clock.advance(10);
    const cutRes = await app.call("POST", "/api/projects/Duet/release", {});
    expect(cutRes.status).toBe(201);
    const expectedDate = new Date(app.clock.now()).toISOString().slice(0, 10);
    expect(cutRes.body.release).toEqual({
      project: "Duet",
      tag: `v${expectedDate}.1`,
      at: app.clock.now(),
      ticketIds: ["1"],
      commits: ["sha123"],
    });

    const afterCut = await app.call("GET", "/api/releases");
    expect(afterCut.body.releases).toHaveLength(1);
    expect(afterCut.body.releases[0].tag).toBe(`v${expectedDate}.1`);
    const duetAfter = afterCut.body.pending.find((p: { project: string }) => p.project === "Duet");
    expect(duetAfter?.pendingTickets).toEqual([]);

    const cutAgain = await app.call("POST", "/api/projects/Duet/release", {});
    expect(cutAgain.status).toBe(400);

    app.clock.advance(5);
    const t2 = app.clock.now();
    await app.deps.store.append("2", [
      { type: "ticket-created", at: t2, ticketId: "2" },
      { type: "pushed", at: t2 + 50, sha: "sha456" },
      { type: "closed", at: t2 + 100, outcome: "merged" },
    ]);
    app.deps.tickets.create({ ...refunds, type: "fix", effort: "medium", title: "Feature X" }, t2);

    const customCut = await app.call("POST", "/api/projects/Duet/release", { tag: "v2.0.0" });
    expect(customCut.status).toBe(201);
    expect(customCut.body.release.tag).toBe("v2.0.0");
    expect(customCut.body.release.ticketIds).toEqual(["2"]);

    const deskRes = await app.call("GET", "/api/desk");
    expect(deskRes.status).toBe(200);
    expect(deskRes.body.releases).toHaveLength(2);
    expect(deskRes.body.pendingReleases).toBeDefined();
  });
});

describe("autoRelease policy and automatic releases", () => {
  it("automatically cuts a release during tick when autoRelease is enabled on project", async () => {
    const app = await testApp();
    const putRes = await app.call("PUT", "/api/projects/Duet", {
      repo: "firstprateek/duet",
      checks: ["pnpm test"],
      autoRelease: true,
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body.policy.autoRelease).toBe(true);

    const t0 = app.clock.now();
    await app.deps.store.append("1", [
      { type: "ticket-created", at: t0, ticketId: "1" },
      { type: "pushed", at: t0 + 50, sha: "sha-auto-1" },
      { type: "closed", at: t0 + 100, outcome: "merged" },
    ]);
    app.deps.tickets.create({ ...refunds, type: "fix", effort: "medium", title: "Auto release ticket" }, t0);

    expect(app.deps.registry.releases()).toEqual([]);

    await app.daemon.tick();

    const releases = app.deps.registry.releases();
    expect(releases).toHaveLength(1);
    expect(releases[0]?.project).toBe("Duet");
    expect(releases[0]?.ticketIds).toEqual(["1"]);
    expect(releases[0]?.commits).toEqual(["sha-auto-1"]);

    await app.daemon.tick();
    expect(app.deps.registry.releases()).toHaveLength(1);
  });
});

describe("GET /api/sandboxes (contract C1)", () => {
  it("returns empty sandboxes when no teams are registered", async () => {
    const app = await testApp();
    const res = await app.call("GET", "/api/sandboxes");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sandboxes: [] });
  });

  it("returns sandbox status for each team with default and custom sizes", async () => {
    const app = await testApp();
    await app.call("PUT", "/api/teams/devs", { name: "Devs", members: ["ada"] });
    await app.call("PUT", "/api/teams/infra", {
      name: "Infra",
      members: [],
      sandbox: { cpus: 8, memory: "16G" },
    });

    const res = await app.call("GET", "/api/sandboxes");
    expect(res.status).toBe(200);
    expect(res.body.sandboxes).toHaveLength(2);
    expect(res.body.sandboxes).toEqual([
      {
        team: "devs",
        machine: "inc-devs",
        state: "stopped",
        cpus: 6,
        memory: "12G",
        signedIn: { claude: true, antigravity: false, codex: false, github: true },
      },
      {
        team: "infra",
        machine: "inc-infra",
        state: "stopped",
        cpus: 8,
        memory: "16G",
        signedIn: { claude: true, antigravity: false, codex: false, github: true },
      },
    ]);
  });

  it("reflects running state and custom sign-ins from FakeMachines", async () => {
    const app = await testApp();
    await app.call("PUT", "/api/teams/devs", { name: "Devs", members: ["ada"] });

    const machines = app.deps.machines as FakeMachines;
    machines.sandboxSignIns = {
      devs: { claude: true, antigravity: true, codex: true, github: true },
    };
    await machines.ensureUp("inc-devs");

    const res = await app.call("GET", "/api/sandboxes");
    expect(res.status).toBe(200);
    expect(res.body.sandboxes).toEqual([
      {
        team: "devs",
        machine: "inc-devs",
        state: "running",
        cpus: 6,
        memory: "12G",
        signedIn: { claude: true, antigravity: true, codex: true, github: true },
      },
    ]);
  });

  it("reports state: error when machines does not implement inspectSandbox", async () => {
    const app = await testApp();
    await app.call("PUT", "/api/teams/devs", { name: "Devs", members: ["ada"] });

    (app.deps.machines as { inspectSandbox?: unknown }).inspectSandbox = undefined;

    const res = await app.call("GET", "/api/sandboxes");
    expect(res.status).toBe(200);
    expect(res.body.sandboxes).toEqual([
      {
        team: "devs",
        machine: "inc-devs",
        state: "error",
        cpus: 6,
        memory: "12G",
        signedIn: { claude: false, antigravity: false, codex: false, github: false },
      },
    ]);
  });

  it("reports state: error per-team when inspectSandbox throws, without breaking other teams", async () => {
    const app = await testApp();
    await app.call("PUT", "/api/teams/devs", { name: "Devs", members: ["ada"] });
    await app.call("PUT", "/api/teams/broken", { name: "Broken", members: [] });

    const machines = app.deps.machines as FakeMachines;
    const orig = machines.inspectSandbox.bind(machines);
    machines.inspectSandbox = async (team, size) => {
      if (team === "broken") throw new Error("container CLI exploded");
      return orig(team, size);
    };

    const res = await app.call("GET", "/api/sandboxes");
    expect(res.status).toBe(200);
    expect(res.body.sandboxes).toHaveLength(2);
    expect(res.body.sandboxes[0]?.team).toBe("devs");
    expect(res.body.sandboxes[0]?.state).toBe("stopped");
    expect(res.body.sandboxes[1]).toEqual({
      team: "broken",
      machine: "inc-broken",
      state: "error",
      cpus: 6,
      memory: "12G",
      signedIn: { claude: false, antigravity: false, codex: false, github: false },
    });
  });
});

describe("TicketView Contract C10 fields (createdBy, finishedAt, pushed)", () => {
  it("populates createdBy, finishedAt, and pushed properly", async () => {
    const app = await testApp();
    const t0 = app.deps.clock.now();

    // 1. Ticket created by owner
    const ownerTicket = app.deps.tickets.create(
      { ...refunds, type: "fix", effort: "medium", createdBy: "owner" },
      t0,
    );
    // 2. Ticket created by employee 'ada'
    const adaTicket = app.deps.tickets.create(
      { ...refunds, type: "feat", effort: "low", title: "Ada feat", createdBy: "ada" },
      t0,
    );

    await app.deps.store.append(adaTicket.id, [
      { type: "pushed", at: t0 + 10, sha: "abc1234" },
      { type: "closed", at: t0 + 20, outcome: "merged" },
    ]);

    const res = await app.call("GET", "/api/board");
    expect(res.status).toBe(200);
    const tickets = res.body.tickets as Array<{
      id: string;
      createdBy: { id: string; name: string; tint: number; role?: string } | null;
      finishedAt: number | null;
      pushed: boolean;
    }>;

    const v1 = tickets.find((t) => t.id === ownerTicket.id);
    expect(v1).toBeDefined();
    expect(v1?.createdBy).toBeNull();
    expect(v1?.finishedAt).toBeNull();
    expect(v1?.pushed).toBe(false);

    const v2 = tickets.find((t) => t.id === adaTicket.id);
    expect(v2).toBeDefined();
    expect(v2?.createdBy).toEqual({
      id: "ada",
      name: "Ada",
      tint: expect.any(Number),
      role: expect.any(String),
    });
    expect(v2?.finishedAt).toBe(t0 + 20);
    expect(v2?.pushed).toBe(true);
  });
});

describe("Web Push backend API (contract C2)", () => {
  it("GET /api/push/key returns public key", async () => {
    const app = await testApp();
    const res = await app.call("GET", "/api/push/key");
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe("string");
    expect(res.body.publicKey.length).toBeGreaterThan(0);
  });

  it("POST /api/push/subscribe validates endpoint and stores subscription", async () => {
    const app = await testApp();
    const bad = await app.call("POST", "/api/push/subscribe", {});
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("endpoint is required");

    const nonHttps = await app.call("POST", "/api/push/subscribe", {
      endpoint: "http://push.example.com/client-1",
    });
    expect(nonHttps.status).toBe(400);
    expect(nonHttps.body.error).toBe("endpoint must be https");

    const invalidUrl = await app.call("POST", "/api/push/subscribe", {
      endpoint: "not-a-url",
    });
    expect(invalidUrl.status).toBe(400);
    expect(invalidUrl.body.error).toBe("endpoint must be a valid URL");

    const sub = {
      endpoint: "https://push.example.com/client-1",
      keys: { p256dh: "key-p256", auth: "key-auth" },
    };
    const res = await app.call("POST", "/api/push/subscribe", sub);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(app.deps.registry.pushSubscriptions()).toContainEqual(sub);
  });

  it("POST /api/push/unsubscribe validates endpoint and removes subscription", async () => {
    const app = await testApp();
    await app.call("POST", "/api/push/subscribe", {
      endpoint: "https://push.example.com/client-1",
    });
    expect(app.deps.registry.pushSubscriptions()).toHaveLength(1);

    const bad = await app.call("POST", "/api/push/unsubscribe", {});
    expect(bad.status).toBe(400);

    const res = await app.call("POST", "/api/push/unsubscribe", {
      endpoint: "https://push.example.com/client-1",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(app.deps.registry.pushSubscriptions()).toHaveLength(0);
  });

  it("sends push notifications for needs-you, report-ready, and main-red events without duplicate sends", async () => {
    const app = await testApp();
    const { FakePushService } = await import("../src/push.ts");
    const fakePush = new FakePushService(app.deps.registry);
    app.deps.push = fakePush;

    const t0 = app.clock.now();
    app.deps.tickets.create({ ...refunds, type: "fix", effort: "medium", title: "Test Ticket 1" }, t0);

    // 1. needs-you event
    await app.deps.store.append("1", [
      {
        type: "needs-you",
        at: t0,
        stage: "plan",
        ask: { kind: "plan-gate", plan: "Approve plan?" },
      },
    ]);

    await app.daemon.tick();

    expect(fakePush.sent).toEqual([
      {
        title: "Needs you · #1",
        body: "Test Ticket 1",
        url: "#/ticket/1",
      },
    ]);

    // Subsequent tick does not re-send
    await app.daemon.tick();
    expect(fakePush.sent).toHaveLength(1);

    // 2. report-ready event
    await app.deps.store.append("1", [
      {
        type: "report-ready",
        at: t0 + 10,
        summary: "Work completed",
      },
    ]);

    await app.daemon.tick();
    expect(fakePush.sent).toHaveLength(2);
    expect(fakePush.sent[1]).toEqual({
      title: "Report ready · #1",
      body: "Test Ticket 1",
      url: "#/ticket/1",
    });

    // 3. main-red event
    await app.deps.store.append("1", [
      {
        type: "main-red",
        at: t0 + 20,
        sha: "abc1234",
        reason: "CI failed on test suite",
      },
    ]);

    await app.daemon.tick();
    expect(fakePush.sent).toHaveLength(3);
    expect(fakePush.sent[2]).toEqual({
      title: "Main is red · #1",
      body: "CI failed on test suite",
      url: "#/ticket/1",
    });
  });

  it("does not re-notify historical events when starting against an existing database (baseline)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { FakePushService } = await import("../src/push.ts");

    const dbFile = join(mkdtempSync(join(tmpdir(), "i-inc-db-")), "test.db");
    const app1 = await testApp(dbFile);
    const t0 = app1.clock.now();
    app1.deps.tickets.create({ ...refunds, type: "fix", effort: "medium", title: "Historical Ticket" }, t0);
    await app1.deps.store.append("1", [
      { type: "needs-you", stage: "plan", at: t0, ask: { kind: "stuck", reason: "stuck" } },
    ]);
    // Simulate pre-T7 database with existing tickets/events but no push_sent table data:
    app1.db.run("DELETE FROM push_sent");
    app1.db.close();

    // Reopen daemon against the existing database
    const app2 = await testApp(dbFile);
    const fakePush = new FakePushService(app2.deps.registry);
    app2.deps.push = fakePush;

    await app2.daemon.tick();
    expect(fakePush.sent).toHaveLength(0);

    // Newly appended event DOES notify:
    await app2.deps.store.append("1", [{ type: "report-ready", at: t0 + 10, summary: "Done" }]);
    await app2.daemon.tick();
    expect(fakePush.sent).toHaveLength(1);
    expect(fakePush.sent[0]?.title).toBe("Report ready · #1");
    app2.db.close();
  });
});

describe("engine edit and deletion routes (Contract C11)", () => {
  it("accepts Codex engines, persists them, and rejects local data routing at both boundaries", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dbFile = join(mkdtempSync(join(tmpdir(), "i-inc-codex-engine-")), "test.db");
    const app = await testApp(dbFile);

    const created = await app.call("PUT", "/api/engines/openai-codex", {
      harness: "codex",
      model: "gpt-5-codex",
      accountId: "claude-pro",
      local: false,
    });
    expect(created.status).toBe(200);
    expect(created.body.engine).toEqual({
      id: "openai-codex",
      harness: "codex",
      model: "gpt-5-codex",
      accountId: "claude-pro",
      local: false,
    });
    expect(
      await app.call("PUT", "/api/engines/openai-codex", {
        local: true,
      }),
    ).toMatchObject({ status: 400, body: { error: expect.stringContaining("cloud harness") } });
    expect(() =>
      app.deps.registry.addEngine({
        id: "forged-local-codex",
        harness: "codex",
        model: "gpt-5-codex",
        accountId: "claude-pro",
        local: true,
      }),
    ).toThrow("Codex is a cloud harness and cannot be marked local");
    expect(app.deps.registry.engine("openai-codex")).toMatchObject({ harness: "codex", local: false });
    app.db.close();

    const reopened = await testApp(dbFile);
    expect(reopened.deps.registry.engine("openai-codex")).toEqual(created.body.engine);
    expect((await reopened.call("DELETE", "/api/engines/openai-codex")).status).toBe(200);
    expect(reopened.deps.registry.engines().some((engine) => engine.id === "openai-codex")).toBe(false);
    reopened.db.close();
  });

  it("validates the model id for every harness", async () => {
    const app = await testApp();
    const put = (harness: string, model: unknown) =>
      app.call("PUT", "/api/engines/model-check", { harness, model, accountId: "claude-pro" });
    for (const harness of ["claude-code", "antigravity", "opencode", "codex"]) {
      for (const bad of [
        "",
        "   ",
        "x".repeat(101),
        "gpt\n5",
        "gpt\u0000",
        "gpt\t5",
        "a;rm -rf",
        "gpt`5`",
        7,
      ]) {
        const res = await put(harness, bad);
        expect(res.status, `${harness} ${JSON.stringify(bad)}`).toBe(400);
        expect(res.body.error).toEqual(expect.stringContaining("model"));
      }
      for (const good of [
        "gpt-5-codex",
        "Gemini 3.1 Pro",
        "qwen3:8b",
        "openai/gpt-5.5@2026+x_1.0",
        "x".repeat(100),
      ]) {
        expect((await put(harness, good)).status, `${harness} ${good}`).toBe(200);
      }
    }
    app.db.close();
  });

  it("explains why an existing local engine can't switch to Codex", async () => {
    const app = await testApp();
    expect(
      (
        await app.call("PUT", "/api/engines/local-eng", {
          harness: "opencode",
          model: "qwen3:8b",
          accountId: "claude-pro",
          local: true,
        })
      ).status,
    ).toBe(200);
    const res = await app.call("PUT", "/api/engines/local-eng", { harness: "codex" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Codex runs in the cloud and cannot be local; turn off Local first");
    expect(app.deps.registry.engine("local-eng")).toMatchObject({ harness: "opencode", local: true });
    const ok = await app.call("PUT", "/api/engines/local-eng", { harness: "codex", local: false });
    expect(ok.status).toBe(200);
    expect(ok.body.engine).toMatchObject({ harness: "codex", local: false });
    app.db.close();
  });

  it("edits an existing engine partially without re-specifying harness and account", async () => {
    const app = await testApp();

    // Create an engine
    const create = await app.call("PUT", "/api/engines/test-eng", {
      harness: "claude-code",
      model: "claude-3-5-sonnet",
      accountId: "claude-pro",
    });
    expect(create.status).toBe(200);
    expect(create.body.engine).toMatchObject({
      id: "test-eng",
      harness: "claude-code",
      model: "claude-3-5-sonnet",
      accountId: "claude-pro",
      local: false,
    });

    // Edit only model and local flag
    const edit = await app.call("PUT", "/api/engines/test-eng", {
      model: "claude-3-7-sonnet",
      local: true,
    });
    expect(edit.status).toBe(200);
    expect(edit.body.engine).toMatchObject({
      id: "test-eng",
      harness: "claude-code", // preserved
      model: "claude-3-7-sonnet", // updated
      accountId: "claude-pro", // preserved
      local: true, // updated
    });
  });

  it("deletes engines, accounts, teams, and projects", async () => {
    const app = await testApp();

    // 1. Engine deletion
    await app.call("PUT", "/api/engines/temp-eng", {
      harness: "opencode",
      model: "qwen",
      accountId: "claude-pro",
    });
    expect(app.deps.registry.engines().some((e) => e.id === "temp-eng")).toBe(true);
    const delEng = await app.call("DELETE", "/api/engines/temp-eng");
    expect(delEng.status).toBe(200);
    expect(delEng.body).toEqual({ ok: true });
    expect(app.deps.registry.engines().some((e) => e.id === "temp-eng")).toBe(false);
    expect((await app.call("DELETE", "/api/engines/temp-eng")).status).toBe(404);

    // 2. Account deletion
    await app.call("PUT", "/api/accounts/temp-acc", { name: "Temp Acc" });
    expect(app.deps.registry.accounts().some((a) => a.id === "temp-acc")).toBe(true);
    const delAcc = await app.call("DELETE", "/api/accounts/temp-acc");
    expect(delAcc.status).toBe(200);
    expect(delAcc.body).toEqual({ ok: true });
    expect(app.deps.registry.accounts().some((a) => a.id === "temp-acc")).toBe(false);
    expect((await app.call("DELETE", "/api/accounts/temp-acc")).status).toBe(404);

    // 3. Team deletion
    await app.call("PUT", "/api/teams/temp-team", { name: "Temp Team", members: [] });
    expect(app.deps.registry.teams().some((t) => t.id === "temp-team")).toBe(true);
    const delTeam = await app.call("DELETE", "/api/teams/temp-team");
    expect(delTeam.status).toBe(200);
    expect(delTeam.body).toEqual({ ok: true });
    expect(app.deps.registry.teams().some((t) => t.id === "temp-team")).toBe(false);
    expect((await app.call("DELETE", "/api/teams/temp-team")).status).toBe(404);

    // 4. Project deletion
    await app.call("PUT", "/api/projects/temp-proj", {
      repo: "org/temp-repo",
      checks: ["npm test"],
    });
    expect(app.deps.registry.projects().some((p) => p.id === "temp-proj")).toBe(true);
    const delProj = await app.call("DELETE", "/api/projects/temp-proj");
    expect(delProj.status).toBe(200);
    expect(delProj.body).toEqual({ ok: true });
    expect(app.deps.registry.projects().some((p) => p.id === "temp-proj")).toBe(false);
    expect((await app.call("DELETE", "/api/projects/temp-proj")).status).toBe(404);
  });
});
