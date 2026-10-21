// The projects flow's routes against a stand-in GitHub (T62, contract C14): status, the repo list and
// its cache, adding a repo, creating one (organization vs personal account, permission missing), rate
// limits and GitHub errors, and that neither the installation token nor GitHub's words reach the client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api.ts";
import { CALLS_PER_MINUTE, GitHubProjects, newRepoUrl, REFRESH_FLOOR_MS } from "../src/github-projects.ts";
import { createGitHubStub, STUB_TOKEN, type StubOptions, stubApp } from "./github-stub.ts";
import { refunds, testApp } from "./setup.ts";

const TOKEN = "owner-login-token";
const API = "https://stub.github";

async function setup(o: StubOptions = {}, configured = true) {
  const stub = createGitHubStub({
    repos: [
      {
        owner: "acme",
        name: "duet-web",
        files: { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "pnpm-lock.yaml": "" },
        language: "TypeScript",
        description: "The web app",
      },
      { owner: "acme", name: "empty-one", files: {} },
    ],
    ...o,
  });
  const app = await testApp();
  const handle = createApi(
    app.daemon,
    {
      ...app.deps,
      ...(configured ? { tokens: stubApp(stub, API), githubApi: API, githubFetch: stub.fetch } : {}),
    },
    { token: TOKEN, hosts: ["i.inc"] },
  );
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(
      new Request(`http://i.inc${path}`, {
        method,
        headers: {
          host: "i.inc",
          authorization: `Bearer ${TOKEN}`,
          ...(method === "GET" ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      }),
    );
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      text,
      // biome-ignore lint/suspicious/noExplicitAny: tests read the API's JSON loosely, the way a client would.
      body: JSON.parse(text || "{}") as Record<string, any>,
    };
  };
  const upstream = (path: RegExp) => stub.state.calls.filter((c) => path.test(c.path)).length;
  return { stub, app, call, handle, upstream };
}

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logged.push(a.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

const secrets = (s: string) =>
  [STUB_TOKEN, "Bad credentials", "Resource not accessible", "eyJ"].some((x) => s.includes(x));

describe("GET /api/github/status", () => {
  it("says an organization with Administration can create repos, and links to its installation", async () => {
    const { call } = await setup();
    const r = await call("GET", "/api/github/status");
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(true);
    expect(r.body.installation).toEqual({
      account: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
    });
    expect(r.body.create).toMatchObject({ possible: true, reason: null });
    expect(r.body.links.manage).toBe("https://github.com/organizations/acme/settings/installations/4242");
    expect(r.body.links.install).toBe("https://github.com/apps/i-inc-bot/installations/new");
    expect(secrets(r.text)).toBe(false);
  });

  it("says a personal account can't have repos created by the bot", async () => {
    const { call } = await setup({ account: "someone", accountType: "User" });
    const r = await call("GET", "/api/github/status");
    expect(r.body.create).toMatchObject({ possible: false, reason: "personal-account" });
    expect(r.body.create.detail).toContain("personal account");
    expect(r.body.links.manage).toBe("https://github.com/settings/installations/4242");
  });

  it("says an organization without Administration: write lacks the permission", async () => {
    const { call } = await setup({ permissions: { contents: "write", administration: "read" } });
    const r = await call("GET", "/api/github/status");
    expect(r.body.create).toMatchObject({ possible: false, reason: "missing-permission" });
    expect(r.body.links.appPermissions).toBe("https://github.com/settings/apps/i-inc-bot/permissions");
  });

  it("answers plainly when the GitHub App isn't set up", async () => {
    const { call } = await setup({}, false);
    const r = await call("GET", "/api/github/status");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      configured: false,
      installation: null,
      create: { possible: false, reason: "not-configured" },
    });
    expect(r.body.links.install).toBe("https://github.com/apps/i-inc-bot/installations/new");
    expect((await call("GET", "/api/github/repos")).body).toEqual({ repos: [], configured: false });
  });

  it("falls back to the manual steps when the installation can't be read", async () => {
    const { call, stub } = await setup();
    stub.state.failPath.push({ match: /^\/app\/installations\/\d+$/, status: 500 });
    const r = await call("GET", "/api/github/status");
    expect(r.status).toBe(200);
    expect(r.body.create).toMatchObject({ possible: false, reason: "unknown" });
    expect(r.body.problem.code).toBe("unavailable");
    expect(r.body.links.manage).toBe("https://github.com/settings/installations");
  });
});

describe("GET /api/github/repos", () => {
  it("lists what the bot can see and marks the repos that are projects", async () => {
    const { call, app } = await setup();
    app.deps.registry.addProject({ id: "Duet", repo: "acme/duet-web", checks: ["pnpm test"] });
    const r = await call("GET", "/api/github/repos");
    expect(r.status).toBe(200);
    const byName = Object.fromEntries((r.body.repos as { name: string }[]).map((x) => [x.name, x]));
    expect(byName["duet-web"]).toMatchObject({
      fullName: "acme/duet-web",
      alreadyRegistered: true,
      empty: false,
      language: "TypeScript",
    });
    expect(byName["empty-one"]).toMatchObject({ alreadyRegistered: false, empty: true });
    expect(secrets(r.text)).toBe(false);
  });

  it("reuses the list for 30 seconds, and Refresh asks again but not more than every few seconds", async () => {
    const { call, app, stub, upstream } = await setup();
    await call("GET", "/api/github/repos");
    await call("GET", "/api/github/repos");
    expect(upstream(/^\/installation\/repositories$/)).toBe(1);

    // A repo appears on GitHub. A refresh straight away is held back to the cached list.
    stub.state.repos.push({ owner: "acme", name: "fresh", files: {} });
    await call("GET", "/api/github/repos?refresh=1");
    expect(upstream(/^\/installation\/repositories$/)).toBe(1);

    app.clock.advance(0.1); // 6 seconds
    const again = await call("GET", "/api/github/repos?refresh=1");
    expect(upstream(/^\/installation\/repositories$/)).toBe(2);
    expect((again.body.repos as { name: string }[]).map((x) => x.name)).toContain("fresh");

    app.clock.advance(1); // past the 30 seconds
    await call("GET", "/api/github/repos");
    expect(upstream(/^\/installation\/repositories$/)).toBe(3);
  });

  it("asks GitHub for the installation's repos with the token the stub issued, once", async () => {
    const { call, stub } = await setup();
    await call("GET", "/api/github/repos");
    expect(
      stub.state.calls
        .filter((c) => c.path === "/installation/repositories")
        .every((c) => c.auth === "token"),
    ).toBe(true);
    expect(
      stub.state.calls.filter((c) => c.path.endsWith("/access_tokens")).every((c) => c.auth === "jwt"),
    ).toBe(true);
  });

  it("says what to do on each GitHub failure, never GitHub's own words, and never as the daemon being down", async () => {
    const { call, stub, app } = await setup();
    const cases: [number, Record<string, string> | undefined, string, number, string][] = [
      [401, undefined, "auth", 424, "key or ids"],
      [
        403,
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120) },
        "rate-limited",
        429,
        "slow down",
      ],
      [403, undefined, "forbidden", 424, "isn't allowed"],
      [429, { "retry-after": "30" }, "rate-limited", 429, "about 30 seconds"],
      [404, undefined, "not-found", 424, "can't find"],
      [500, undefined, "unavailable", 424, "having trouble"],
    ];
    for (const [status, headers, code, httpStatus, words] of cases) {
      stub.state.fail = {
        status,
        ...(headers ? { headers } : {}),
        message: "Bad credentials: secret detail",
      };
      app.clock.advance(1);
      // Drop the stub's issued token, so the failure is on the list call itself.
      const r = await call("GET", "/api/github/repos");
      expect(r.status, `${status}`).toBe(httpStatus);
      expect(r.body.code).toBe(code);
      expect(r.body.error).toContain(words);
      expect(r.body.repos).toEqual([]);
      expect([502, 503, 504, 401]).not.toContain(r.status);
      expect(secrets(r.text)).toBe(false);
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.some(secrets)).toBe(false);
  });

  it("sets Retry-After on a rate limit", async () => {
    const { call, stub } = await setup();
    stub.state.fail = { status: 429, headers: { "retry-after": "42" } };
    const r = await call("GET", "/api/github/repos");
    expect(r.headers.get("retry-after")).toBe("42");
    expect(r.body.retryAfter).toBe(42);
  });

  it("shows the last good list with a warning when GitHub fails after it worked", async () => {
    const { call, stub, app } = await setup();
    await call("GET", "/api/github/repos");
    app.clock.advance(1);
    stub.state.fail = { status: 500 };
    const r = await call("GET", "/api/github/repos");
    expect(r.status).toBe(200);
    expect(r.body.repos.length).toBe(2);
    expect(r.body.warning.code).toBe("unavailable");
  });

  it("answers a network failure as 'couldn't reach GitHub', not as the daemon being down", async () => {
    const { call, app } = await setup();
    const handle = createApi(
      app.daemon,
      {
        ...app.deps,
        tokens: { token: async () => "t" },
        githubApi: API,
        githubFetch: (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
      },
      { token: TOKEN, hosts: ["i.inc"] },
    );
    const res = await handle(
      new Request("http://i.inc/api/github/repos", {
        headers: { host: "i.inc", authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(res.status).toBe(424);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("unreachable");
    expect(body.error).toContain("couldn't reach GitHub");
    void call;
  });

  it("limits how many GitHub calls a minute of clicks can make, and says when to try again", async () => {
    const { call, upstream } = await setup();
    let last = { status: 0, body: {} as Record<string, unknown> };
    for (let i = 0; i < 30; i++) {
      last = await call("GET", "/api/github/repos/acme/duet-web/inspect");
      if (last.status === 429) break;
    }
    expect(last.status).toBe(429);
    expect(last.body.code).toBe("rate-limited");
    expect(String(last.body.error)).toContain("pausing");
    expect(upstream(/^\/repos\//)).toBeLessThanOrEqual(60);
  });
});

describe("inspect and add a repo", () => {
  it("detects the checks of a repo the bot can see", async () => {
    const { call } = await setup();
    const r = await call("GET", "/api/github/repos/acme/duet-web/inspect");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      repo: "acme/duet-web",
      detected: "node",
      empty: false,
      checks: ["pnpm install --frozen-lockfile", "pnpm test"],
    });
  });

  it("refuses a repo the bot can't see, with what to do", async () => {
    const { call } = await setup();
    const r = await call("GET", "/api/github/repos/acme/not-given/inspect");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("not-accessible");
    expect(r.body.error).toContain("Give i.inc access");
  });

  it("registers an imported repo with the chosen mode and the confirmed recipe", async () => {
    const { call, app } = await setup();
    const r = await call("POST", "/api/projects/duet-web/bootstrap", {
      repo: "acme/duet-web",
      mode: "owner-merges",
      checks: ["pnpm install", "pnpm test"],
      defaultBranch: "main",
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ bootstrapped: false, commits: 0 });
    expect(app.deps.registry.project("duet-web")).toMatchObject({
      repo: "acme/duet-web",
      mode: "owner-merges",
      checks: ["pnpm install", "pnpm test"],
    });
  });

  it("keeps the names the app's own pages use", async () => {
    const { call } = await setup();
    for (const id of ["add", "New"]) {
      const a = await call("POST", `/api/projects/${id}/bootstrap`, { repo: "acme/duet-web" });
      expect(a.status).toBe(400);
      expect(a.body.error).toContain("kept for the app's own pages");
      const b = await call("PUT", `/api/projects/${id}`, { repo: "acme/duet-web", checks: ["x"] });
      expect(b.status).toBe(400);
    }
  });
});

describe("POST /api/github/repos (create)", () => {
  it("creates an empty repo in the organization, then fills it with the existing bootstrap", async () => {
    const { call, stub, app } = await setup();
    const made = await call("POST", "/api/github/repos", {
      name: "fresh-start",
      visibility: "public",
      description: "Hello",
    });
    expect(made.status).toBe(201);
    expect(made.body.repo).toMatchObject({ fullName: "acme/fresh-start", private: false });
    expect(stub.state.calls.find((c) => c.method === "POST" && c.path === "/orgs/acme/repos")?.body).toEqual({
      name: "fresh-start",
      private: false,
      description: "Hello",
      auto_init: false,
    });
    expect(secrets(made.text)).toBe(false);

    // The cached list was dropped, so the new repo is visible straight away and is empty.
    const list = await call("GET", "/api/github/repos");
    expect(list.body.repos.find((x: { name: string }) => x.name === "fresh-start")).toMatchObject({
      empty: true,
      private: false,
    });

    const boot = await call("POST", "/api/projects/fresh-start/bootstrap", {
      repo: "acme/fresh-start",
      template: "web",
      mode: "direct",
    });
    expect(boot.status).toBe(201);
    expect(boot.body.bootstrapped).toBe(true);
    expect(Object.keys(stub.state.repos.find((r) => r.name === "fresh-start")?.files ?? {})).toContain(
      "index.html",
    );
    expect(app.deps.registry.project("fresh-start")?.repo).toBe("acme/fresh-start");
  });

  it("does not create in a personal account; it gives the owner the one-click link instead", async () => {
    const { call, stub } = await setup({ account: "someone", accountType: "User" });
    const r = await call("POST", "/api/github/repos", { name: "my.app_2", visibility: "private" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "cannot-create", reason: "personal-account" });
    expect(r.body.manualUrl).toBe("https://github.com/new?name=my.app_2&visibility=private");
    expect(stub.state.calls.some((c) => c.path.includes("/repos") && c.method === "POST")).toBe(false);
  });

  it("does not create without the Administration permission", async () => {
    const { call, stub } = await setup({ permissions: { contents: "write" } });
    const r = await call("POST", "/api/github/repos", { name: "x1" });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("missing-permission");
    expect(r.body.manualUrl).toBe("https://github.com/new?name=x1&visibility=private");
    expect(stub.state.calls.some((c) => c.method === "POST" && c.path === "/orgs/acme/repos")).toBe(false);
  });

  it("says a taken name is taken, in words", async () => {
    const { call } = await setup();
    const r = await call("POST", "/api/github/repos", { name: "duet-web" });
    expect(r.status).toBe(424);
    expect(r.body.code).toBe("refused");
    expect(r.body.error).toContain("pick another name");
    expect(secrets(r.text)).toBe(false);
  });

  it("validates the name, visibility and description before calling GitHub", async () => {
    const { call, stub } = await setup();
    const bad = [
      { name: "../etc" },
      { name: "a b" },
      { name: "x/y" },
      { name: "x.git" },
      { name: ".." },
      { name: "" },
      { name: 7 },
      { name: "ok", visibility: "internal" },
      { name: "ok", description: "x".repeat(351) },
    ];
    for (const body of bad) {
      const r = await call("POST", "/api/github/repos", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(stub.state.calls.length).toBe(0);
  });

  it("encodes the name in the link", () => {
    expect(newRepoUrl("a b&c", "public")).toBe("https://github.com/new?name=a%20b%26c&visibility=public");
  });

  it("is not created twice at once", async () => {
    const { call } = await setup();
    const [a, b] = await Promise.all([
      call("POST", "/api/github/repos", { name: "twice" }),
      call("POST", "/api/github/repos", { name: "twice" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });
});

describe("a bootstrap that goes wrong", () => {
  it("can be run again to carry on, and never overwrites a repo that has files unless confirmed", async () => {
    const { call, stub } = await setup();
    // The second file fails: some files are in, so the repo isn't empty any more.
    stub.state.failPath.push({ match: /contents\/src\/index\.ts$/, method: "PUT", status: 500 });
    const body = { repo: "acme/empty-one", template: "ts-node", mode: "direct" };
    const first = await call("POST", "/api/projects/empty-one/bootstrap", body);
    expect(first.status).toBe(424);
    expect(first.body).toMatchObject({ code: "unavailable", resumable: true });
    expect(secrets(first.text)).toBe(false);

    stub.state.failPath.length = 0;
    const refused = await call("POST", "/api/projects/empty-one/bootstrap", body);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("not-empty");
    // Nothing was written by that call, so there is nothing to carry on: no "resumable".
    expect(refused.body.resumable).toBeUndefined();

    const resumed = await call("POST", "/api/projects/empty-one/bootstrap", { ...body, force: true });
    expect(resumed.status).toBe(201);
    expect(Object.keys(stub.state.repos.find((r) => r.name === "empty-one")?.files ?? {})).toContain(
      "src/index.ts",
    );
  });

  it("never starts over a repo that already has files", async () => {
    const { call, stub } = await setup();
    const r = await call("POST", "/api/projects/duet-web/bootstrap", {
      repo: "acme/duet-web",
      template: "minimal",
    });
    expect(r.status).toBe(409);
    expect(stub.state.repos[0]?.files?.["README.md"]).toBeUndefined();
  });
});

describe("guards on the new routes", () => {
  it("need the login, a known Host, a same-site Origin and JSON", async () => {
    const { handle } = await setup();
    const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
      handle(new Request(`http://i.inc${path}`, init));
    const ok = { host: "i.inc", authorization: `Bearer ${TOKEN}` };
    for (const [method, path] of [
      ["GET", "/api/github/status"],
      ["GET", "/api/github/repos"],
      ["POST", "/api/github/repos"],
      ["GET", "/api/project-overview"],
      ["GET", "/api/projects/Duet"],
    ] as const) {
      expect(
        (await req(path, { method, headers: { host: "i.inc" } })).status,
        `${method} ${path} unauthenticated`,
      ).toBe(401);
      expect(
        (await req(path, { method, headers: { ...ok, host: "evil.example" } })).status,
        `${method} ${path} host`,
      ).toBe(421);
    }
    const cross = await req("/api/github/repos", {
      method: "POST",
      headers: { ...ok, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(cross.status).toBe(403);
    const form = await req("/api/github/repos", {
      method: "POST",
      headers: { ...ok, "content-type": "text/plain" },
      body: "name=x",
    });
    expect(form.status).toBe(415);
  });
});

describe("project status and detail", () => {
  it("gives each project a status line: mode, checks, last ticket and open pull requests", async () => {
    const { call, app } = await setup();
    const filed = await call("POST", "/api/tickets", { ...refunds, project: "Duet" });
    expect(filed.status).toBe(201);
    await app.daemon.tick();
    const r = await call("GET", "/api/project-overview");
    expect(r.status).toBe(200);
    const duet = (r.body.projects as { id: string }[]).find((p) => p.id === "Duet") as Record<
      string,
      unknown
    >;
    expect(duet).toMatchObject({
      repo: "demo/duet",
      repoUrl: "https://github.com/demo/duet",
      mode: "owner-merges",
      checks: ["pnpm test"],
      openTickets: 1,
      openPrs: [],
    });
    expect(duet.lastTicket).toMatchObject({ title: refunds.title });
    const quiet = (r.body.projects as { id: string; lastTicket: unknown }[]).find((p) => p.id === "listy");
    expect(quiet?.lastTicket).toBeNull();
  });

  it("gives one project's page its policy, recent tickets and releases", async () => {
    const { call, app } = await setup();
    await call("POST", "/api/tickets", { ...refunds, project: "Duet" });
    app.deps.registry.recordRelease({ project: "Duet", tag: "v1", at: 1, ticketIds: [], commits: [] });
    const r = await call("GET", "/api/projects/Duet");
    expect(r.status).toBe(200);
    expect(r.body.project).toMatchObject({ id: "Duet", repo: "demo/duet" });
    expect(r.body.policy).toMatchObject({ mode: "owner-merges" });
    expect(r.body.tickets).toHaveLength(1);
    expect(r.body.tickets[0]).toMatchObject({ title: refunds.title });
    expect(r.body.releases.map((x: { tag: string }) => x.tag)).toEqual(["v1"]);
    expect((await call("GET", "/api/projects/nope")).status).toBe(404);
  });
});

describe("a repo's files are never written over (review of #88)", () => {
  const readme = { owner: "acme", name: "notes", files: { "README.md": "# my own notes" }, sizeLag: true };

  it("reads a README-only repo whose size GitHub still reports as 0 as having files", async () => {
    const { call, stub } = await setup({ repos: [readme] });
    const list = await call("GET", "/api/github/repos");
    // The list can only go by size and push time: a hint.
    expect(list.body.repos[0].empty).toBe(true);
    const inspected = await call("GET", "/api/github/repos/acme/notes/inspect");
    expect(inspected.body.empty).toBe(false);

    for (const force of [undefined, true]) {
      const r = await call("POST", "/api/projects/notes/bootstrap", {
        repo: "acme/notes",
        template: "minimal",
        ...(force ? { force } : {}),
      });
      expect(r.status, `force ${force}`).toBe(409);
      expect(r.body.code).toBe("not-empty");
      expect(r.body.resumable).toBeUndefined();
    }
    expect(stub.state.repos[0]?.files?.["README.md"]).toBe("# my own notes");
    expect(stub.state.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("stops when a file appears between the check and the write, and writes nothing over it", async () => {
    const { call, stub } = await setup({ repos: [{ owner: "acme", name: "race", files: {} }] });
    // GitHub says the repo is empty, then the file is there when i.inc writes it.
    stub.state.failPath.push({ match: /contents\/README\.md$/, method: "PUT", status: 422 });
    const r = await call("POST", "/api/projects/race/bootstrap", { repo: "acme/race", template: "minimal" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("not-empty");
  });

  it("registers a repo once: concurrent bootstraps under different names write it once", async () => {
    const { call, stub, app } = await setup({ repos: [{ owner: "acme", name: "fresh", files: {} }] });
    const body = { repo: "acme/fresh", template: "minimal" };
    const [a, b] = await Promise.all([
      call("POST", "/api/projects/p1/bootstrap", body),
      call("POST", "/api/projects/p2/bootstrap", body),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe("in-use");
    expect(stub.state.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/README.md")).length).toBe(
      1,
    );
    expect(app.deps.registry.projects().filter((p) => p.repo === "acme/fresh").length).toBe(1);
  });

  it("refuses a second project on the same repo, however it is named or cased", async () => {
    const { call, app } = await setup();
    const first = await call("POST", "/api/projects/dup/bootstrap", {
      repo: "acme/duet-web",
      checks: ["make"],
    });
    expect(first.status).toBe(201);
    for (const [id, repo] of [
      ["dup2", "acme/duet-web"],
      ["Dup3", "ACME/Duet-Web"],
    ] as const) {
      const r = await call("POST", `/api/projects/${id}/bootstrap`, { repo, checks: ["make"] });
      expect(r.status, id).toBe(409);
      expect(r.body).toMatchObject({ code: "in-use", project: "dup" });
      expect(r.body.error).toContain('"dup"');
    }
    // Editing one project onto another's repo is refused too; its own repo is fine.
    app.deps.registry.addProject({ id: "other", repo: "acme/other", checks: ["x"] });
    const clash = await call("PUT", "/api/projects/other", { repo: "Acme/Duet-Web", checks: ["x"] });
    expect(clash.status).toBe(409);
    expect((await call("PUT", "/api/projects/dup", { repo: "acme/duet-web", checks: ["y"] })).status).toBe(
      200,
    );
  });

  it("does not let force replace files of a registered repo", async () => {
    const { call, stub } = await setup();
    await call("POST", "/api/projects/dup/bootstrap", { repo: "acme/duet-web", checks: ["make"] });
    const before = JSON.stringify(stub.state.repos[0]?.files);
    const r = await call("POST", "/api/projects/dup2/bootstrap", {
      repo: "acme/duet-web",
      template: "ts-node",
      force: true,
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("in-use");
    expect(JSON.stringify(stub.state.repos[0]?.files)).toBe(before);
    expect(stub.state.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("carries on only from its own commits, adding the missing files", async () => {
    const { call, stub } = await setup();
    stub.state.failPath.push({ match: /contents\/src\/index\.ts$/, method: "PUT", status: 500 });
    const body = { repo: "acme/empty-one", template: "ts-node" };
    const first = await call("POST", "/api/projects/empty-one/bootstrap", body);
    expect(first.body.resumable).toBe(true);
    stub.state.failPath.length = 0;
    const pkgBefore = stub.state.repos[1]?.files?.["package.json"];
    const resumed = await call("POST", "/api/projects/empty-one/bootstrap", { ...body, force: true });
    expect(resumed.status).toBe(201);
    expect(stub.state.repos[1]?.files?.["package.json"]).toBe(pkgBefore);
    // package.json was written once, in the first run, and never again.
    expect(
      stub.state.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/package.json")).length,
    ).toBe(1);
  });

  it("counts every GitHub call against the cap, token minting and the installation included", async () => {
    let t = 0;
    const calls: string[] = [];
    const base = (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ total_count: 0, repositories: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    // A token source that spends 4 calls minting, as the App does through the fetch it is given.
    const tokens = {
      token: async (_r: string, _a?: string, f?: typeof fetch) => {
        for (let i = 0; i < 4; i++) await (f as typeof fetch)("https://stub.github/mint");
        return "t";
      },
    };
    const gh = new GitHubProjects(tokens, { now: () => t, fetch: base, api: "https://stub.github" });
    let tripped = false;
    for (let i = 0; i < 30 && !tripped; i++) {
      t += REFRESH_FLOOR_MS + 1;
      // After a good list, a failure comes back as the last list with a warning.
      const r = await gh.repos(true).catch(() => ({ warning: { code: "rate-limited" } }) as never);
      tripped = r.warning?.code === "rate-limited";
    }
    expect(tripped).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(CALLS_PER_MINUTE);
  });

  it("says a refresh was held back", async () => {
    const { call } = await setup();
    await call("GET", "/api/github/repos");
    const r = await call("GET", "/api/github/repos?refresh=1");
    expect(r.body.throttled).toBe(true);
  });
});
