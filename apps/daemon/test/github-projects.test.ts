import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";
import {
  bootstrapRepo,
  inspectRepo,
  isValidRepo,
  listInstallationRepos,
  type TokenSource,
} from "../src/github.ts";
import { testApp } from "./setup.ts";

describe("GitHub project discovery, recipe inspection, and bootstrapping", () => {
  const fakeTokenSource: TokenSource = {
    async token(_repo, _access) {
      return "ghs_fake_installation_token";
    },
  };

  it("lists installation repositories and flags already registered ones", async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      expect(String(url)).toContain("/installation/repositories");
      return new Response(
        JSON.stringify({
          repositories: [
            {
              id: 1,
              name: "duet",
              full_name: "firstprateek/duet",
              owner: { login: "firstprateek" },
              private: true,
              default_branch: "main",
              description: "Duet project",
              language: "TypeScript",
              size: 1024,
              pushed_at: "2026-10-18T00:00:00Z",
            },
            {
              id: 2,
              name: "new-proj",
              full_name: "firstprateek/new-proj",
              owner: { login: "firstprateek" },
              private: false,
              default_branch: "main",
              description: null,
              language: null,
              size: 0,
              pushed_at: null,
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const repos = await listInstallationRepos(fakeTokenSource, ["firstprateek/duet"], {
      fetch: fakeFetch,
      api: "https://mock.github",
    });

    expect(repos).toHaveLength(2);
    expect(repos[0]).toEqual({
      fullName: "firstprateek/duet",
      name: "duet",
      owner: "firstprateek",
      private: true,
      defaultBranch: "main",
      description: "Duet project",
      language: "TypeScript",
      empty: false,
      pushedAt: "2026-10-18T00:00:00Z",
      alreadyRegistered: true,
    });
    expect(repos[1]?.alreadyRegistered).toBe(false);
    expect(repos[1]?.empty).toBe(true);
  });

  it("inspects node repositories and detects recipe from package.json and lockfile", async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/repos/org/node-app")) {
        return new Response(
          JSON.stringify({
            default_branch: "main",
            size: 500,
            language: "TypeScript",
            pushed_at: "2026-10-18T00:00:00Z",
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (u.endsWith("/repos/org/node-app/contents")) {
        return new Response(
          JSON.stringify([
            { name: "package.json", type: "file" },
            { name: "pnpm-lock.yaml", type: "file" },
            { name: "src", type: "dir" },
          ]),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (u.endsWith("/repos/org/node-app/contents/package.json")) {
        return new Response(
          JSON.stringify({
            content: Buffer.from(
              JSON.stringify({
                scripts: {
                  check: "biome check .",
                  test: "vitest run",
                },
              }),
            ).toString("base64"),
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const inspected = await inspectRepo(fakeTokenSource, "org", "node-app", {
      fetch: fakeFetch,
      api: "https://mock.github",
    });

    expect(inspected.id).toBe("node-app");
    expect(inspected.detected).toBe("node");
    expect(inspected.empty).toBe(false);
    expect(inspected.checks).toEqual(["pnpm install --frozen-lockfile", "pnpm check", "pnpm test"]);
    expect(inspected.protectedPaths).toEqual(["package.json", "pnpm-lock.yaml"]);
  });

  it("inspects python repositories and detects pytest", async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/repos/org/py-service")) {
        return new Response(
          JSON.stringify({
            default_branch: "main",
            size: 300,
            language: "Python",
            pushed_at: "2026-10-18T00:00:00Z",
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (u.endsWith("/repos/org/py-service/contents")) {
        return new Response(
          JSON.stringify([
            { name: "pyproject.toml", type: "file" },
            { name: "src", type: "dir" },
          ]),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const inspected = await inspectRepo(fakeTokenSource, "org", "py-service", {
      fetch: fakeFetch,
      api: "https://mock.github",
    });

    expect(inspected.id).toBe("py-service");
    expect(inspected.detected).toBe("python");
    expect(inspected.checks).toEqual(["pytest"]);
    expect(inspected.protectedPaths).toEqual(["pyproject.toml"]);
  });

  it("inspects empty repositories", async () => {
    const fakeFetch = (async () => {
      return new Response(JSON.stringify({ default_branch: "main", size: 0, language: null }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const inspected = await inspectRepo(fakeTokenSource, "org", "brand-new", {
      fetch: fakeFetch,
      api: "https://mock.github",
    });

    expect(inspected.empty).toBe(true);
    expect(inspected.detected).toBe("empty");
    expect(inspected.checks).toEqual(["pnpm install", "pnpm test"]);
  });

  it("bootstraps starter files via GitHub Contents API", async () => {
    const committedPaths: string[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      const match = String(url).match(/\/contents\/(.+)$/);
      if (match?.[1]) committedPaths.push(match[1]);
      return new Response(JSON.stringify({ content: { sha: "abc123" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await bootstrapRepo(
      fakeTokenSource,
      {
        repo: "org/scaffolded-ts",
        template: "ts-node",
        description: "A test project",
      },
      { fetch: fakeFetch, api: "https://mock.github" },
    );

    expect(res.bootstrapped).toBe(true);
    expect(res.commits).toBe(6);
    expect(committedPaths).toContain("package.json");
    expect(committedPaths).toContain("tsconfig.json");
    expect(committedPaths).toContain("src/index.ts");
    expect(committedPaths).toContain("test/index.test.ts");
    expect(committedPaths).toContain("README.md");
    expect(committedPaths).toContain(".gitignore");
  });

  it("supports GET /api/github/repos, inspect, and POST /api/projects/:id/bootstrap endpoints", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/installation/repositories")) {
        return new Response(
          JSON.stringify({
            repositories: [
              {
                id: 1,
                name: "new-test-proj",
                full_name: "firstprateek/new-test-proj",
                owner: { login: "firstprateek" },
                private: true,
                default_branch: "main",
                description: "Test repo",
                language: "TypeScript",
                size: 100,
                pushed_at: "2026-10-18T00:00:00Z",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    try {
      const app = await testApp();
      const token = "test-auth-token";
      const apiHandler = createApi(
        app.daemon,
        { ...app.deps, tokens: fakeTokenSource },
        { token, hosts: ["i.inc"] },
      );

      const call = async (method: string, path: string, body?: unknown) => {
        const res = await apiHandler(
          new Request(`http://i.inc${path}`, {
            method,
            headers: {
              host: "i.inc",
              authorization: `Bearer ${token}`,
              ...(body !== undefined ? { "content-type": "application/json" } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          }),
        );
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };

      // 1. Unauthenticated request to /api/github/repos returns 401
      const unauthed = await apiHandler(
        new Request("http://i.inc/api/github/repos", {
          method: "GET",
          headers: { host: "i.inc" },
        }),
      );
      expect(unauthed.status).toBe(401);

      // 1b. Unauthenticated request to bootstrap returns 401
      const unauthedBootstrap = await apiHandler(
        new Request("http://i.inc/api/projects/TestProj/bootstrap", {
          method: "POST",
          headers: { host: "i.inc", "content-type": "application/json" },
          body: JSON.stringify({ repo: "firstprateek/new-test-proj" }),
        }),
      );
      expect(unauthedBootstrap.status).toBe(401);

      // 2. Bad repository inspect returns 400
      const badInspect = await call("GET", "/api/github/repos/bad..owner/name/inspect");
      expect(badInspect.status).toBe(400);

      // 3. Invalid bootstrap request returns 400
      const badBootstrap = await call("POST", "/api/projects/TestProj/bootstrap", {
        repo: "not-a-repo",
      });
      expect(badBootstrap.status).toBe(400);
      expect(badBootstrap.body.error).toContain("repo must be valid owner/name");

      // 3b. Traversal repo in bootstrap returns 400
      const traversalBootstrap = await call("POST", "/api/projects/TestProj/bootstrap", {
        repo: "owner/..",
      });
      expect(traversalBootstrap.status).toBe(400);

      // 3c. Invalid mode in bootstrap returns 400
      const invalidModeBootstrap = await call("POST", "/api/projects/TestProj/bootstrap", {
        repo: "owner/valid-repo",
        mode: "invalid-mode",
      });
      expect(invalidModeBootstrap.status).toBe(400);

      // 3d. Repository not accessible in installation returns 403
      const inaccessibleBootstrap = await call("POST", "/api/projects/TestProj/bootstrap", {
        repo: "other-org/inaccessible-repo",
        mode: "direct",
      });
      expect(inaccessibleBootstrap.status).toBe(403);
      expect(inaccessibleBootstrap.body.error).toContain("not accessible");

      // 4. Valid bootstrap request registers project and assigns employees
      const employees = app.deps.registry.employees();
      expect(employees.length).toBeGreaterThan(0);
      const ada = employees[0];
      if (!ada) throw new Error("Expected at least one employee");

      const goodBootstrap = await call("POST", "/api/projects/NewTestProj/bootstrap", {
        repo: "firstprateek/new-test-proj",
        mode: "direct",
        checks: ["pnpm test"],
        employees: [ada.id],
      });

      expect(goodBootstrap.status).toBe(201);
      const project = goodBootstrap.body.project as Record<string, unknown>;
      expect(project).toBeDefined();
      expect(project.id).toBe("NewTestProj");
      expect(project.repo).toBe("firstprateek/new-test-proj");
      expect(project.mode).toBe("direct");
      expect(project.checks).toEqual(["pnpm test"]);

      // Verify Ada was assigned NewTestProj
      const updatedAda = app.deps.registry.employees().find((e) => e.id === ada.id);
      expect(updatedAda?.projects).toContain("NewTestProj");

      // 5. Duplicate project ID in bootstrap returns 409
      const dupBootstrap = await call("POST", "/api/projects/NewTestProj/bootstrap", {
        repo: "firstprateek/other-repo",
        mode: "direct",
      });
      expect(dupBootstrap.status).toBe(409);
      expect(dupBootstrap.body.error).toContain("already exists");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("strictly validates repository names, rejecting path traversals and invalid characters", () => {
    expect(isValidRepo("firstprateek/duet")).toBe(true);
    expect(isValidRepo("org-name/repo_123.js")).toBe(true);
    expect(isValidRepo("owner/..")).toBe(false);
    expect(isValidRepo("owner/.")).toBe(false);
    expect(isValidRepo("owner/...")).toBe(false);
    expect(isValidRepo("../repo")).toBe(false);
    expect(isValidRepo("owner/repo.git")).toBe(false);
    expect(isValidRepo("invalid")).toBe(false);
    expect(isValidRepo("owner/repo/sub")).toBe(false);
  });

  it("detects bun projects from bun.lock and configures bun test", async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/repos/org/bun-app")) {
        return new Response(
          JSON.stringify({
            default_branch: "main",
            size: 100,
            language: "TypeScript",
            pushed_at: "2026-10-18T00:00:00Z",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (u.endsWith("/repos/org/bun-app/contents")) {
        return new Response(
          JSON.stringify([
            { name: "package.json", type: "file" },
            { name: "bun.lock", type: "file" },
          ]),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (u.endsWith("/repos/org/bun-app/contents/package.json")) {
        return new Response(
          JSON.stringify({
            content: Buffer.from(
              JSON.stringify({
                scripts: { test: "vitest run" },
              }),
            ).toString("base64"),
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof fetch;

    const res = await inspectRepo(fakeTokenSource, "org", "bun-app", {
      fetch: fakeFetch,
      api: "https://mock.github",
    });

    expect(res.detected).toBe("bun");
    expect(res.checks).toEqual(["bun install --frozen-lockfile", "bun test"]);
    expect(res.protectedPaths).toContain("bun.lock");
  });

  it("handles malformed URI components like %zz without crashing", async () => {
    const app = await testApp();
    const token = "test-auth-token";
    const apiHandler = createApi(
      app.daemon,
      { ...app.deps, tokens: fakeTokenSource },
      { token, hosts: ["i.inc"] },
    );
    const res = await apiHandler(
      new Request("http://i.inc/api/projects/%zz", {
        method: "GET",
        headers: { host: "i.inc", authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects case-insensitive duplicate project IDs with 409", async () => {
    const app = await testApp();
    const token = "test-auth-token";
    const apiHandler = createApi(
      app.daemon,
      { ...app.deps, tokens: fakeTokenSource },
      { token, hosts: ["i.inc"] },
    );
    // Project 'duet' is seeded in testApp
    const res = await apiHandler(
      new Request("http://i.inc/api/projects/Duet/bootstrap", {
        method: "POST",
        headers: {
          host: "i.inc",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          repo: "firstprateek/duet",
          mode: "direct",
        }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("already exists");
  });

  it("maps upstream GitHub failures to 502/503/504 and never echoes upstream 401 to client", async () => {
    const originalFetch = globalThis.fetch;
    const app = await testApp();
    const token = "test-auth-token";
    const apiHandler = createApi(
      app.daemon,
      { ...app.deps, tokens: fakeTokenSource },
      { token, hosts: ["i.inc"] },
    );

    try {
      // 1. Upstream 401 mapped to 502 (NOT 401, so client does not sign owner out)
      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const res401 = await apiHandler(
        new Request("http://i.inc/api/github/repos", {
          method: "GET",
          headers: { host: "i.inc", authorization: `Bearer ${token}` },
        }),
      );
      expect(res401.status).toBe(502);
      const body401 = (await res401.json()) as { error: string };
      expect(body401.error).toBe("upstream GitHub service failure");

      // 2. Upstream 429 mapped to 503
      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const res429 = await apiHandler(
        new Request("http://i.inc/api/github/repos", {
          method: "GET",
          headers: { host: "i.inc", authorization: `Bearer ${token}` },
        }),
      );
      expect(res429.status).toBe(503);
      const body429 = (await res429.json()) as { error: string };
      expect(body429.error).toBe("upstream GitHub rate limit exceeded");

      // 3. Upstream timeout/abort mapped to 504
      globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }) as unknown as typeof fetch;

      const resTimeout = await apiHandler(
        new Request("http://i.inc/api/github/repos", {
          method: "GET",
          headers: { host: "i.inc", authorization: `Bearer ${token}` },
        }),
      );
      expect(resTimeout.status).toBe(504);
      const bodyTimeout = (await resTimeout.json()) as { error: string };
      expect(bodyTimeout.error).toBe("upstream GitHub service timed out");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("strictly validates boolean force on bootstrap and prevents string bypass on non-empty repo", async () => {
    const originalFetch = globalThis.fetch;
    const app = await testApp();
    const token = "test-auth-token";
    const apiHandler = createApi(
      app.daemon,
      { ...app.deps, tokens: fakeTokenSource },
      { token, hosts: ["i.inc"] },
    );

    try {
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("/installation/repositories")) {
          return new Response(
            JSON.stringify({
              repositories: [
                {
                  id: 1,
                  name: "non-empty-repo",
                  full_name: "firstprateek/non-empty-repo",
                  owner: { login: "firstprateek" },
                  private: true,
                  default_branch: "main",
                  description: "Non empty repo",
                  language: "TypeScript",
                  size: 2048,
                  pushed_at: "2026-10-18T00:00:00Z",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (u.endsWith("/repos/firstprateek/non-empty-repo")) {
          return new Response(
            JSON.stringify({
              default_branch: "main",
              size: 2048,
              language: "TypeScript",
              pushed_at: "2026-10-18T00:00:00Z",
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (u.endsWith("/repos/firstprateek/non-empty-repo/contents")) {
          return new Response(JSON.stringify([{ name: "existing.txt", type: "file" }]), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      }) as unknown as typeof fetch;

      // Passing force: "false" (string) must NOT bypass the guard
      const resStringForce = await apiHandler(
        new Request("http://i.inc/api/projects/NonEmptyProj/bootstrap", {
          method: "POST",
          headers: {
            host: "i.inc",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            repo: "firstprateek/non-empty-repo",
            template: "ts-node",
            force: "false",
          }),
        }),
      );
      expect(resStringForce.status).toBe(409);
      const bodyStringForce = (await resStringForce.json()) as { error: string; resumable: boolean };
      expect(bodyStringForce.error).toContain("repository is not empty");
      expect(bodyStringForce.resumable).toBe(true);

      // Passing force: true (boolean) permits bootstrapping and returns 201
      // Mock Contents PUT
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PUT") {
          return new Response(JSON.stringify({ content: { sha: "abc" } }), { status: 201 });
        }
        return origFetch(url, init);
      }) as unknown as typeof fetch;

      const resBoolForce = await apiHandler(
        new Request("http://i.inc/api/projects/NonEmptyProj2/bootstrap", {
          method: "POST",
          headers: {
            host: "i.inc",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            repo: "firstprateek/non-empty-repo",
            template: "ts-node",
            force: true,
          }),
        }),
      );
      expect(resBoolForce.status).toBe(201);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
