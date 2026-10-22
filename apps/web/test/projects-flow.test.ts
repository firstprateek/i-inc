// The GitHub projects flow (T62): the list with status lines, adding a repo, starting a new project (the bot
// creates it, or the owner does), a reload in the middle, and one project's page. Against a fake daemon that
// remembers what it was told, so a step changes what the next screen sees.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/app.ts";
import "../src/components/project-flow.ts";
import "../src/components/project-page.ts";
import "../src/components/setup-projects.ts";
import {
  conversationHref,
  type GitHubStatus,
  newRepoLink,
  type ProjectStatus,
  projectIdFromRepo,
  repoNameProblem,
} from "../src/github-projects.ts";
import { GITHUB_MANAGE_URL } from "../src/setup-api.ts";

interface Repo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  empty: boolean;
  pushedAt: string | null;
  alreadyRegistered: boolean;
}

const repo = (name: string, o: Partial<Repo> = {}): Repo => ({
  fullName: `acme/${name}`,
  name,
  owner: "acme",
  private: true,
  defaultBranch: "main",
  description: null,
  language: "TypeScript",
  empty: false,
  pushedAt: "2026-10-20T00:00:00Z",
  alreadyRegistered: false,
  ...o,
});

const orgStatus = (over: Partial<GitHubStatus> = {}): GitHubStatus => ({
  configured: true,
  installation: { account: "acme", accountType: "Organization", repositorySelection: "selected" },
  create: { possible: true, reason: null, detail: "The bot can create the repo in acme for you." },
  links: {
    install: "https://github.com/apps/i-inc-bot/installations/new",
    manage: "https://github.com/organizations/acme/settings/installations/4242",
    appPermissions: "https://github.com/settings/apps/i-inc-bot/permissions",
  },
  ...over,
});
const personalStatus = (): GitHubStatus =>
  orgStatus({
    installation: { account: "someone", accountType: "User", repositorySelection: "selected" },
    create: {
      possible: false,
      reason: "personal-account",
      detail: "GitHub doesn't let a bot create repos in a personal account, only in an organization.",
    },
    links: { install: "x", manage: "https://github.com/settings/installations/4242", appPermissions: null },
  });

const duet: ProjectStatus = {
  id: "Duet",
  repo: "acme/duet",
  repoUrl: "https://github.com/acme/duet",
  mode: "owner-merges",
  checks: ["pnpm install", "pnpm check", "pnpm typecheck", "pnpm test"],
  lastTicket: { id: "12", title: "Fix refunds", at: Date.now() - 2 * 86_400_000, status: "merged" },
  openTickets: 2,
  openPrs: [{ ticketId: "13", number: 41, url: "https://github.com/acme/duet/pull/41" }],
};
const listy: ProjectStatus = {
  id: "listy",
  repo: "acme/listy",
  repoUrl: "https://github.com/acme/listy",
  mode: "direct",
  checks: ["make"],
  lastTicket: null,
  openTickets: 0,
  openPrs: [],
};

interface World {
  status: GitHubStatus | "fail";
  projects: ProjectStatus[];
  repos: Repo[];
  /** Extra fields on the repo list: a `warning` (GitHub failing) or `throttled` (a Refresh held back). */
  reposExtra: Record<string, unknown> | null;
  /** Fail the repo list with this problem. */
  reposFail: { status: number; body: Record<string, unknown> } | null;
  inspect: "ok" | "fail" | "empty";
  bootstrap: { status: number; body: Record<string, unknown> } | null;
  createRepo: { status: number; body: Record<string, unknown> } | null;
  /** The bootstrap leaves some files, so the repo is not empty any more. */
  detail: unknown;
}

let world: World;
let calls: { method: string; url: string; body: unknown }[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function serve(w: Partial<World> = {}) {
  world = {
    status: orgStatus(),
    projects: [duet, listy],
    repos: [
      repo("duet", { alreadyRegistered: true }),
      repo("listy", { alreadyRegistered: true }),
      repo("notes"),
      repo("blank", { empty: true, pushedAt: null }),
    ],
    reposFail: null,
    reposExtra: null,
    inspect: "ok",
    bootstrap: null,
    createRepo: null,
    detail: null,
    ...w,
  };
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.split("?")[0] as string;
    if (path === "/api/github/status")
      return world.status === "fail"
        ? json(
            { error: "GitHub is having trouble right now. Try again in a few minutes.", code: "unavailable" },
            424,
          )
        : json(world.status);
    if (path === "/api/github/repos" && method === "GET") {
      if (world.reposFail) return json({ ...world.reposFail.body, repos: [] }, world.reposFail.status);
      const registered = new Set(world.projects.map((p) => p.repo.toLowerCase()));
      return json({
        configured: world.status === "fail" || world.status.configured,
        ...world.reposExtra,
        repos: world.repos.map((r) => ({
          ...r,
          alreadyRegistered: r.alreadyRegistered || registered.has(r.fullName.toLowerCase()),
        })),
      });
    }
    if (path === "/api/github/repos" && method === "POST") {
      if (world.createRepo) return json(world.createRepo.body, world.createRepo.status);
      const b = body as { name: string };
      world.repos.push(repo(b.name, { empty: true, pushedAt: null }));
      return json({ repo: { fullName: `acme/${b.name}`, defaultBranch: "main", private: true } }, 201);
    }
    if (path === "/api/project-overview") return json({ projects: world.projects });
    if (/^\/api\/github\/repos\/[^/]+\/[^/]+\/inspect$/.test(path)) {
      if (world.inspect === "fail")
        return json(
          { error: "GitHub didn't answer in time. Wait a minute and try again.", code: "timeout" },
          424,
        );
      return json({
        id: "notes",
        repo: "acme/notes",
        defaultBranch: "trunk",
        empty: world.inspect === "empty",
        checks: ["pnpm install --frozen-lockfile", "pnpm test"],
        protectedPaths: ["package.json", "pnpm-lock.yaml"],
        detected: world.inspect === "empty" ? "empty" : "node",
      });
    }
    if (/^\/api\/projects\/[^/]+\/bootstrap$/.test(path)) {
      if (world.bootstrap) return json(world.bootstrap.body, world.bootstrap.status);
      const id = decodeURIComponent(path.split("/")[3] as string);
      const b = body as { repo: string; mode?: "direct" | "owner-merges"; checks?: string[] };
      world.projects.push({
        ...listy,
        id,
        repo: b.repo,
        repoUrl: `https://github.com/${b.repo}`,
        mode: b.mode ?? "direct",
        checks: b.checks ?? [],
      });
      const r = world.repos.find((x) => x.fullName === b.repo);
      if (r) r.empty = false;
      return json({ project: { id, repo: b.repo }, bootstrapped: true, commits: 5 }, 201);
    }
    if (path === "/api/employees")
      return json({ employees: [{ id: "ada", name: "Ada", role: "Engineer", duties: ["build"] }] });
    if (path === "/api/projects" && method === "GET")
      return json({ projects: world.projects.map((p) => ({ id: p.id })) });
    if (/^\/api\/projects\/[^/]+$/.test(path) && method === "GET") {
      const id = decodeURIComponent(path.split("/")[3] as string);
      const p = world.projects.find((x) => x.id === id);
      if (!p) return json({ error: "no such project" }, 404);
      return json(
        world.detail ?? {
          ...p,
          project: { id: p.id, repo: p.repo, checks: p.checks, mode: p.mode, defaultBranch: "main" },
          policy: { mode: p.mode, protectedPaths: [".github/"], followUpsPerDay: 3, autoRelease: false },
          tickets: [
            { id: "12", title: "Fix refunds", type: "fix", at: Date.now() - 3_600_000, status: "merged" },
          ],
          releases: [
            { project: p.id, tag: "v1.0", at: Date.now() - 86_400_000, ticketIds: ["12"], commits: [] },
          ],
        },
      );
    }
    if (/^\/api\/projects\/[^/]+$/.test(path) && (method === "PUT" || method === "DELETE"))
      return json({ ok: true });
    if (path === "/api/board") return json({ tickets: [] });
    return json({});
  });
}

async function settle(el: Element, rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
}

async function mount<T extends HTMLElement>(
  tag: string,
  props: Record<string, unknown> = {},
): Promise<{ el: T; root: ShadowRoot }> {
  const el = document.createElement(tag) as T;
  Object.assign(el, props);
  document.body.append(el);
  await settle(el);
  return { el, root: el.shadowRoot as ShadowRoot };
}

const text = (e: ParentNode | null | undefined) => e?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const button = (root: ParentNode, label: string | RegExp) =>
  [...root.querySelectorAll("button, a.btn")].find((b) =>
    typeof label === "string" ? text(b) === label : label.test(text(b)),
  ) as HTMLElement;
const link = (root: ParentNode, label: string | RegExp) =>
  [...root.querySelectorAll("a")].find((a) =>
    typeof label === "string" ? text(a).startsWith(label) : label.test(text(a)),
  ) as HTMLAnchorElement;

async function type(el: Element, input: Element, value: string) {
  (input as HTMLInputElement).value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle(el);
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the names and links", () => {
  it("builds the GitHub link with the name and visibility encoded", () => {
    expect(newRepoLink("my-app", "private")).toBe("https://github.com/new?name=my-app&visibility=private");
    expect(newRepoLink("a b&c", "public")).toBe("https://github.com/new?name=a%20b%26c&visibility=public");
  });

  it("checks a repository name the way GitHub does", () => {
    expect(repoNameProblem("my-app_2.js")).toBeNull();
    for (const bad of ["", "has space", "x/y", "..", "ends.git", ".hidden", "a".repeat(101), "emoji🙂"]) {
      expect(repoNameProblem(bad), bad).not.toBeNull();
    }
  });

  it("makes a project name from a repo name", () => {
    expect(projectIdFromRepo("My_App.v2")).toBe("my-app-v2");
    expect(projectIdFromRepo("--x--")).toBe("x");
  });

  it("points Start a conversation at the Conversations screen with the project encoded", () => {
    expect(conversationHref("Duet")).toBe("#/conversations?new=1&project=Duet");
    expect(conversationHref("New API")).toBe("#/conversations?new=1&project=New%20API");
  });
});

describe("Company → Projects", () => {
  it("shows each project's status line, and the repos the bot sees that aren't projects", async () => {
    serve();
    const { root } = await mount("inc-setup-projects");
    const cards = [...root.querySelectorAll("article.project")];
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Duet", "listy"]);
    const d = text(cards[0]);
    expect(d).toContain("Owner merges");
    expect(d).toContain("pnpm install");
    expect(d).toContain("+1 more");
    expect(d).toContain("#12 Fix refunds");
    expect(d).toContain("merged");
    expect(d).toContain("#41");
    expect((cards[0]?.querySelector("h3 a") as HTMLAnchorElement | null)?.getAttribute("href")).toBe(
      "#/company/projects/Duet",
    );
    expect((cards[0]?.querySelector("a.repo") as HTMLAnchorElement | null)?.getAttribute("href")).toBe(
      "https://github.com/acme/duet",
    );
    expect(text(cards[1])).toContain("Direct");
    expect(text(cards[1])).toContain("No tickets yet");
    expect(cards[1]?.textContent).not.toContain("Open PRs");

    const rows = [...root.querySelectorAll(".repo-row")];
    expect(rows.map((r) => text(r.querySelector(".name")))).toEqual(["acme/notes", "acme/blank"]);
    expect(rows[1]?.textContent).toContain("Empty");
    expect(link(rows[0] as Element, "Add")?.getAttribute("href")).toBe(
      "#/company/projects/add?repo=acme%2Fnotes",
    );
  });

  it("links to the installation's settings to give the bot more repos", async () => {
    serve();
    const { root } = await mount("inc-setup-projects");
    const a = link(root, "Give i.inc access to more repos");
    expect(a.getAttribute("href")).toBe("https://github.com/organizations/acme/settings/installations/4242");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(text(root.querySelector(".conn"))).toContain("installed on acme (an organization)");
  });

  it("falls back to GitHub's list of installed apps when the installation isn't known", async () => {
    serve({ status: "fail" });
    const { root } = await mount("inc-setup-projects");
    expect(link(root, "Give i.inc access to more repos").getAttribute("href")).toBe(GITHUB_MANAGE_URL);
    expect(root.textContent).toContain("having trouble");
  });

  it("teaches what a project is when there are none", async () => {
    serve({ projects: [] });
    const { root } = await mount("inc-setup-projects");
    const teach = root.querySelector(".teach");
    expect(text(teach)).toContain("A project is a GitHub repository that i.inc employees work on");
    expect(text(teach)).toContain("Checks");
    expect(text(teach)).toContain("Owner merges");
    expect(link(teach as Element, "New project")?.getAttribute("href")).toBe("#/company/projects/new");
    expect(link(teach as Element, "Add a repo")?.getAttribute("href")).toBe("#/company/projects/add");
  });

  it("says the GitHub App isn't set up", async () => {
    serve({ projects: [], status: orgStatus({ configured: false, installation: null }), repos: [] });
    const { root } = await mount("inc-setup-projects");
    // One compact notice and one button, above the list: not the long paragraph and several links
    const notice = root.querySelector(".notice");
    expect(text(notice)).toBe("Connect GitHub to add repos Connect GitHub");
    expect(link(root, "Connect GitHub")?.getAttribute("href")).toBe(
      "https://github.com/apps/i-inc-bot/installations/new",
    );
    expect(root.querySelectorAll("a[href^='https://github.com']").length).toBe(1);
    expect(root.querySelector(".conn")).toBeNull();
    expect(root.textContent).not.toContain("docs/github-app.md");
    expect(root.textContent).not.toContain("Repos you can add");
    expect(button(root, "Refresh repos")).toBeUndefined();
    const list = root.querySelector('[aria-label="Your projects"]') as Element;
    expect((notice as Element).compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no notice once the GitHub App is set up", async () => {
    serve({ projects: [], status: orgStatus(), repos: [] });
    const { root } = await mount("inc-setup-projects");
    expect(root.querySelector(".notice")).toBeNull();
    expect(root.querySelector(".conn")).not.toBeNull();
  });

  it("explains a GitHub failure in words and offers another try, never a raw status", async () => {
    serve({
      reposFail: {
        status: 424,
        body: {
          error: "GitHub is asking i.inc to slow down. Try again in about 30 seconds.",
          code: "rate-limited",
          retryAfter: 30,
        },
      },
    });
    const { root } = await mount("inc-setup-projects");
    const alert = root.querySelector('.conn [role="alert"]');
    expect(text(alert)).toContain("slow down");
    expect(text(alert)).not.toMatch(/\b(424|429|502|500)\b/);
    expect(button(root.querySelector(".conn") as Element, "Try again")).toBeTruthy();
    // The projects are still there.
    expect(root.querySelectorAll("article.project").length).toBe(2);
  });

  it("is not the offline panel when GitHub fails", async () => {
    const { isOffline } = await import("../src/connection.ts");
    serve({
      reposFail: { status: 424, body: { error: "GitHub is having trouble right now.", code: "unavailable" } },
    });
    await mount("inc-setup-projects");
    expect(isOffline()).toBe(false);
  });

  it("Refresh asks for a fresh list and says how many repos can be added", async () => {
    serve();
    const { el, root } = await mount("inc-setup-projects");
    world.repos.push(repo("extra"));
    button(root, "Refresh repos").click();
    await settle(el);
    expect(calls.some((c) => c.url === "/api/github/repos?refresh=1")).toBe(true);
    expect(text(root.querySelector('.conn [role="status"]'))).toBe("Updated: 3 repos to add.");
    expect(root.querySelectorAll(".repo-row").length).toBe(3);
  });

  it("filters a long list of repos", async () => {
    serve({
      repos: Array.from({ length: 10 }, (_, i) => repo(i === 3 ? "needle" : `hay-${i}`)),
      projects: [],
    });
    const { el, root } = await mount("inc-setup-projects");
    await type(el, root.querySelector('input[type="search"]') as Element, "needle");
    expect([...root.querySelectorAll(".repo-row .name")].map(text)).toEqual(["acme/needle"]);
    await type(el, root.querySelector('input[type="search"]') as Element, "zzz");
    expect(root.textContent).toContain("No repo matches");
  });

  it("warns about a project whose repo the bot can't see any more", async () => {
    serve({ repos: [repo("duet")], projects: [duet, listy] });
    const { root } = await mount("inc-setup-projects");
    const cards = [...root.querySelectorAll("article.project")];
    expect(text(cards[0])).not.toContain("can't see this repo");
    expect(text(cards[1])).toContain("The bot can't see this repo any more");
  });

  it("offers to carry on a new project that was started", async () => {
    serve();
    localStorage.setItem(
      "inc.new-project",
      JSON.stringify({
        name: "halfway",
        visibility: "private",
        template: "web",
        mode: "owner-merges",
        description: "",
        via: "manual",
      }),
    );
    const { root } = await mount("inc-setup-projects");
    expect(text(root)).toContain("halfway is half way through being started");
    expect(link(root, "Carry on").getAttribute("href")).toBe("#/company/projects/new");
  });

  it("opens from the Company tab, with the two ways in as header actions", async () => {
    serve();
    location.hash = "#/company/projects";
    const app = document.createElement("inc-app");
    document.body.append(app);
    await settle(app);
    const root = app.shadowRoot as ShadowRoot;
    expect(root.querySelector("inc-setup-projects")).not.toBeNull();
    const actions = [...root.querySelectorAll('[slot="actions"]')].map(
      (a) => `${text(a)} ${a.getAttribute("href")}`,
    );
    expect(actions).toEqual(["Add a repo #/company/projects/add", "New project #/company/projects/new"]);
    location.hash = "#/company/projects/add?repo=acme%2Fnotes";
    await settle(app);
    expect(root.querySelector("inc-project-flow")).not.toBeNull();
    expect((root.querySelector("inc-project-flow") as unknown as { repo: string }).repo).toBe("acme/notes");
    location.hash = "#/company/projects/Duet";
    await settle(app);
    expect((root.querySelector("inc-project-page") as unknown as { projectId: string }).projectId).toBe(
      "Duet",
    );
    location.hash = "";
  });
});

describe("add a repo", () => {
  type Flow = HTMLElement & { updateComplete: Promise<unknown> };

  it("lists the repos to pick from when none is chosen", async () => {
    serve();
    const { root } = await mount<Flow>("inc-project-flow", { flow: "add" });
    expect(text(root)).toContain("Which repo?");
    expect(link(root, "Add")?.getAttribute("href")).toBe("#/company/projects/add?repo=acme%2Fnotes");
  });

  it("detects the checks, lets you edit the recipe and choose a mode, and adds the project", async () => {
    serve();
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "add", repo: "acme/notes" });
    expect(text(root)).toContain("Found a Node project");
    expect(calls.some((c) => c.url === "/api/github/repos/acme/notes/inspect")).toBe(true);
    const checks = [...root.querySelectorAll('input.mono[aria-label^="command"]')].map(
      (i) => (i as HTMLInputElement).value,
    );
    expect(checks).toEqual(["pnpm install --frozen-lockfile", "pnpm test"]);

    // Each mode comes with one plain sentence, and direct is the preselected one (the daemon's own default).
    const radios = [...root.querySelectorAll('input[type="radio"][name="mode"]')] as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["direct", "owner-merges"]);
    expect(radios[0]?.checked).toBe(true);
    expect(text(root)).toContain("Finished work waits as a pull request, and only you merge it.");
    expect(text(root)).toContain(
      "After i.inc's own review, finished work is pushed straight to the main branch.",
    );

    button(root, "Add command").click();
    await settle(el);
    await type(el, root.querySelector('input[aria-label="command 3"]') as Element, "pnpm build");
    radios[1]?.click();
    radios[1]?.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(el);
    button(root, "Add project").click();
    await settle(el);

    const post = calls.find((c) => c.method === "POST" && c.url === "/api/projects/notes/bootstrap");
    expect(post?.body).toMatchObject({
      repo: "acme/notes",
      mode: "owner-merges",
      checks: ["pnpm install --frozen-lockfile", "pnpm test", "pnpm build"],
      protectedPaths: ["package.json", "pnpm-lock.yaml"],
      defaultBranch: "trunk",
    });
    expect(text(root)).toContain("Added notes");
    expect(link(root, "Start a conversation").getAttribute("href")).toBe(
      "#/conversations?new=1&project=notes",
    );
    expect(link(root, "Open the project").getAttribute("href")).toBe("#/company/projects/notes");
  });

  it("shows the inspection while it runs", async () => {
    serve();
    let release: (r: Response) => void = () => {};
    const held = new Promise<Response>((r) => {
      release = r;
    });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      url.endsWith("/inspect") ? held : (real as typeof fetch)(url, init),
    );
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "add", repo: "acme/notes" });
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Looking at acme/notes");
    release(
      json({
        id: "notes",
        repo: "acme/notes",
        defaultBranch: "main",
        empty: false,
        checks: ["make"],
        protectedPaths: [],
        detected: "other",
      }),
    );
    await settle(el);
    expect(root.querySelector("form")).not.toBeNull();
  });

  it("says what to do when the inspection fails, and still lets the owner type the recipe", async () => {
    serve({ inspect: "fail" });
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "add", repo: "acme/notes" });
    const alert = root.querySelector('[role="alert"]');
    expect(text(alert)).toContain("GitHub didn't answer in time");
    expect(text(alert)).not.toMatch(/\b(424|500|502)\b/);
    expect(button(root, "Try again")).toBeTruthy();
    expect(button(root, "Add project")).toBeTruthy();
    button(root, "Add project").click();
    await settle(el);
    expect(calls.some((c) => c.url === "/api/projects/notes/bootstrap")).toBe(true);
  });

  it("explains an empty repo", async () => {
    serve({ inspect: "empty" });
    const { root } = await mount<Flow>("inc-project-flow", { flow: "add", repo: "acme/blank" });
    expect(text(root)).toContain("This repo is empty");
  });

  it("shows a failed add as words and keeps the form", async () => {
    serve({
      bootstrap: {
        status: 424,
        body: {
          error: "GitHub is having trouble right now. Try again in a few minutes.",
          code: "unavailable",
        },
      },
    });
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "add", repo: "acme/notes" });
    button(root, "Add project").click();
    await settle(el);
    expect(text(root.querySelector('[role="alert"]'))).toContain("having trouble");
    expect(button(root, "Add project")).toBeTruthy();
    expect(text(root)).not.toContain("Added notes");
  });

  it("refuses a name that is taken or kept, before calling the daemon", async () => {
    serve();
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "add", repo: "acme/notes" });
    const name = root.querySelector('label input[type="text"]') as Element;
    for (const [value, words] of [
      ["duet", "There is already a project called duet"],
      ["New", "kept for the app's own pages"],
      ["", "up to 40 letters"],
    ] as const) {
      await type(el, name, value);
      button(root, "Add project").click();
      await settle(el);
      expect(root.textContent).toContain(words);
    }
    expect(calls.some((c) => c.url.endsWith("/bootstrap"))).toBe(false);
  });

  it("tells the owner when the bot can't see the repo, with the link and a Refresh that finds it", async () => {
    serve();
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "add", repo: "acme/later" });
    expect(text(root)).toContain("i.inc can't see acme/later");
    expect(link(root, "Give i.inc access").getAttribute("href")).toBe(
      "https://github.com/organizations/acme/settings/installations/4242",
    );
    world.repos.push(repo("later"));
    button(root, "Refresh").click();
    await settle(el, 14);
    expect(root.querySelector("form")).not.toBeNull();
  });

  it("says a repo is a project already", async () => {
    serve();
    const { root } = await mount<Flow>("inc-project-flow", { flow: "add", repo: "acme/duet" });
    expect(text(root)).toContain("acme/duet is a project already");
    expect(link(root, "Open Duet").getAttribute("href")).toBe("#/company/projects/Duet");
  });
});

describe("start a new project", () => {
  type Flow = HTMLElement & { updateComplete: Promise<unknown> };
  const fill = async (el: Element, root: ShadowRoot, name: string) =>
    type(el, root.querySelector('input[name="name"]') as Element, name);
  const draft = () => JSON.parse(localStorage.getItem("inc.new-project") ?? "null");

  it("checks the name as you type", async () => {
    serve();
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new" });
    await fill(el, root, "has space");
    expect(text(root.querySelector('[role="alert"]'))).toContain("no spaces");
    await fill(el, root, "duet");
    expect(text(root.querySelector('[role="alert"]'))).toContain("There is already a project called duet");
    await fill(el, root, "fresh");
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(text(root)).toContain("under acme");
  });

  it("has the starters, private or public, and a mode with its sentence", async () => {
    serve();
    const { root } = await mount<Flow>("inc-project-flow", { flow: "new" });
    expect(
      [...root.querySelectorAll('input[name="template"]')].map((i) => (i as HTMLInputElement).value),
    ).toEqual(["ts-node", "web", "python", "minimal"]);
    expect(
      [...root.querySelectorAll('input[name="visibility"]')].map((i) => (i as HTMLInputElement).value),
    ).toEqual(["private", "public"]);
    expect((root.querySelector('input[name="visibility"]') as HTMLInputElement).checked).toBe(true);
    expect(text(root)).toContain("only you merge it");
  });

  it("creates the repo through the bot where GitHub allows it, then fills it and adds the project", async () => {
    serve();
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    expect(text(root)).toContain("The bot can create the repo in acme for you");
    await fill(el, root, "fresh");
    (root.querySelector('input[name="template"][value="web"]') as HTMLInputElement).click();
    (root.querySelector('input[name="template"][value="web"]') as HTMLInputElement).dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    await settle(el);
    button(root, "Create and fill").click();
    await settle(el, 20);

    const order = calls.filter((c) => c.method === "POST").map((c) => c.url);
    expect(order).toEqual(["/api/github/repos", "/api/projects/fresh/bootstrap"]);
    expect(calls.find((c) => c.url === "/api/github/repos" && c.method === "POST")?.body).toMatchObject({
      name: "fresh",
      visibility: "private",
    });
    expect(calls.find((c) => c.url.endsWith("/bootstrap"))?.body).toMatchObject({
      repo: "acme/fresh",
      template: "web",
      mode: "direct",
      checks: ["pnpm install", "pnpm check", "pnpm test", "pnpm build"],
    });
    expect(text(root)).toContain("Started fresh");
    expect(link(root, "Start a conversation").getAttribute("href")).toBe(
      "#/conversations?new=1&project=fresh",
    );
    expect(draft()).toBeNull();
  });

  it("in a personal account, sends the owner to GitHub with the filled-in link, then notices the repo and fills it", async () => {
    serve({
      status: personalStatus(),
      repos: [repo("old", { owner: "someone", fullName: "someone/old", alreadyRegistered: false })],
    });
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 40 });
    expect(text(root)).toContain("You create the repo; i.inc fills it");
    await fill(el, root, "fresh");
    (root.querySelector('input[name="visibility"][value="public"]') as HTMLInputElement).click();
    (root.querySelector('input[name="visibility"][value="public"]') as HTMLInputElement).dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    await settle(el);
    button(root, "Next: create it on GitHub").click();
    await settle(el, 12);

    // The steps are visible, and nothing was created by the bot.
    const gh = link(root, "Open GitHub to create fresh");
    expect(gh.getAttribute("href")).toBe("https://github.com/new?name=fresh&visibility=public");
    expect(gh.getAttribute("rel")).toContain("noopener");
    expect(text(root)).toContain("Create it empty");
    expect(text(root)).toContain("Waiting for you");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(draft()).toMatchObject({ name: "fresh", via: "manual", visibility: "public" });

    // The owner creates it on GitHub (empty); the page notices and fills it.
    world.repos.push(
      repo("fresh", { owner: "someone", fullName: "someone/fresh", empty: true, pushedAt: null }),
    );
    await new Promise((r) => setTimeout(r, 200));
    await settle(el, 20);
    expect(calls.find((c) => c.url === "/api/projects/fresh/bootstrap")?.body).toMatchObject({
      repo: "someone/fresh",
      template: "ts-node",
    });
    expect(text(root)).toContain("Started fresh");
    expect(draft()).toBeNull();
  });

  it("looks again when Refresh is pressed, and says it hasn't found it yet", async () => {
    serve({ status: personalStatus() });
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    await fill(el, root, "fresh");
    button(root, /^Next/).click();
    await settle(el);
    const before = calls.filter((c) => c.url.startsWith("/api/github/repos?refresh=1")).length;
    button(root, "Refresh now").click();
    await settle(el, 12);
    expect(calls.filter((c) => c.url.startsWith("/api/github/repos?refresh=1")).length).toBe(before + 1);
    expect(text(root)).toContain("Not there yet");
  });

  it("carries on after a reload: the draft and GitHub say where the steps stand", async () => {
    serve({ status: personalStatus() });
    const first = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    await fill(first.el, first.root, "fresh");
    button(first.root, /^Next/).click();
    await settle(first.el);
    first.el.remove();

    // The repo was created while the page was closed. A fresh page opens on the steps, not the form.
    world.repos.push(
      repo("fresh", { owner: "someone", fullName: "someone/fresh", empty: true, pushedAt: null }),
    );
    document.body.innerHTML = "";
    const second = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    await settle(second.el, 20);
    expect(calls.find((c) => c.url === "/api/projects/fresh/bootstrap")).toBeTruthy();
    expect(text(second.root)).toContain("Started fresh");
  });

  it("shows the steps again after a reload while the repo still isn't there", async () => {
    serve({ status: personalStatus() });
    localStorage.setItem(
      "inc.new-project",
      JSON.stringify({
        name: "fresh",
        visibility: "private",
        template: "python",
        mode: "direct",
        description: "",
        via: "manual",
      }),
    );
    const { root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    expect(root.querySelector("ol.steps")).not.toBeNull();
    expect(text(root)).toContain("Python");
    expect(text(root)).toContain("Waiting for you");
    expect(root.querySelector('input[name="name"]')).toBeNull();
  });

  it("falls back to the owner creating it when the bot is refused, and says why", async () => {
    serve({
      createRepo: {
        status: 409,
        body: {
          error:
            "The bot isn't allowed to create repos in this organization (it lacks the Administration permission).",
          code: "cannot-create",
          reason: "missing-permission",
        },
      },
    });
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    await fill(el, root, "fresh");
    button(root, "Create and fill").click();
    await settle(el, 14);
    expect(text(root.querySelector(".callout.needs"))).toContain("lacks the Administration permission");
    expect(link(root, "Open GitHub to create fresh").getAttribute("href")).toBe(
      "https://github.com/new?name=fresh&visibility=private",
    );
    expect(draft().via).toBe("manual");
  });

  it("explains a failed creation and retries it", async () => {
    serve({
      createRepo: {
        status: 424,
        body: {
          error:
            "GitHub refused it. A repository with that name may already exist: pick another name, or refresh to see it.",
          code: "refused",
        },
      },
    });
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    await fill(el, root, "fresh");
    button(root, "Create and fill").click();
    await settle(el, 14);
    expect(text(root.querySelector('[role="alert"]'))).toContain("pick another name");
    world.createRepo = null;
    button(root, "Try again").click();
    await settle(el, 20);
    expect(text(root)).toContain("Started fresh");
  });

  it("won't write a starter over a repo that already has files", async () => {
    serve({
      status: personalStatus(),
      repos: [repo("fresh", { owner: "someone", fullName: "someone/fresh" })],
    });
    localStorage.setItem(
      "inc.new-project",
      JSON.stringify({
        name: "fresh",
        visibility: "private",
        template: "web",
        mode: "direct",
        description: "",
        via: "manual",
      }),
    );
    const { root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    expect(text(root)).toContain("someone/fresh already has files");
    expect(link(root, "Add it as an existing repo").getAttribute("href")).toBe(
      "#/company/projects/add?repo=someone%2Ffresh",
    );
    expect(calls.some((c) => c.url.endsWith("/bootstrap"))).toBe(false);
  });

  it("offers to carry on a starter that stopped half way, and only then replaces files", async () => {
    serve({
      status: personalStatus(),
      repos: [repo("fresh", { owner: "someone", fullName: "someone/fresh" })],
    });
    localStorage.setItem(
      "inc.new-project",
      JSON.stringify({
        name: "fresh",
        visibility: "private",
        template: "web",
        mode: "direct",
        description: "",
        via: "manual",
        fillStarted: true,
      }),
    );
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    expect(text(root)).toContain("Some starter files are in the repo already");
    expect(calls.some((c) => c.url.endsWith("/bootstrap"))).toBe(false);
    button(root, "Carry on filling it").click();
    await settle(el, 12);
    expect(calls.find((c) => c.url.endsWith("/bootstrap"))?.body).toMatchObject({ force: true });
    expect(text(root)).toContain("Started fresh");
  });

  const draftFor = (extra: Record<string, unknown> = {}) =>
    localStorage.setItem(
      "inc.new-project",
      JSON.stringify({
        name: "fresh",
        visibility: "private",
        template: "minimal",
        mode: "direct",
        description: "",
        via: "manual",
        ...extra,
      }),
    );
  const emptyFresh = () => [
    repo("fresh", { owner: "someone", fullName: "someone/fresh", empty: true, pushedAt: null }),
  ];

  it("shows a failed fill in words and tries again without force when nothing was written", async () => {
    serve({
      status: personalStatus(),
      repos: emptyFresh(),
      bootstrap: {
        status: 424,
        body: {
          error: "GitHub is having trouble right now. Try again in a few minutes.",
          code: "unavailable",
        },
      },
    });
    draftFor();
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    await settle(el, 12);
    expect(text(root.querySelector('[role="alert"]'))).toContain("having trouble");
    expect(draft().fillStarted).toBeUndefined();
    world.bootstrap = null;
    button(root, "Try again").click();
    await settle(el, 12);
    const posts = calls.filter((c) => c.url.endsWith("/bootstrap"));
    expect(posts.at(-1)?.body).not.toHaveProperty("force");
    expect(text(root)).toContain("Started fresh");
  });

  it("after a failure part way, asks before carrying on, and only then sends force", async () => {
    serve({
      status: personalStatus(),
      repos: emptyFresh(),
      bootstrap: {
        status: 424,
        body: { error: "GitHub is having trouble right now.", code: "unavailable", resumable: true },
      },
    });
    draftFor();
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    await settle(el, 12);
    expect(draft().fillStarted).toBe(true);
    expect(text(root)).toContain("it doesn't change the ones already there");
    expect(button(root, "Try again")).toBeUndefined();
    expect(calls.filter((c) => c.url.endsWith("/bootstrap")).length).toBe(1);
    world.bootstrap = null;
    button(root, "Carry on filling it").click();
    await settle(el, 12);
    expect(calls.filter((c) => c.url.endsWith("/bootstrap")).at(-1)?.body).toMatchObject({ force: true });
    expect(text(root)).toContain("Started fresh");
  });

  it("never offers to retry, or force, a repo the daemon says has files of its own", async () => {
    // GitHub's size lags, so the list calls a README-only repo empty: the daemon is the one that knows.
    serve({
      status: personalStatus(),
      repos: emptyFresh(),
      bootstrap: {
        status: 409,
        body: {
          error: "This repository already has files, so i.inc won't write a starter into it.",
          code: "not-empty",
        },
      },
    });
    draftFor();
    const first = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    await settle(first.el, 12);
    expect(text(first.root)).toContain("someone/fresh already has files");
    expect(button(first.root, "Try again")).toBeUndefined();
    expect(button(first.root, "Carry on filling it")).toBeUndefined();
    expect(link(first.root, "Add it as an existing repo")).toBeTruthy();
    expect(button(first.root, "Choose another name")).toBeTruthy();
    // It was never marked as this page's own, so a reload says the same thing.
    expect(draft().fillStarted).toBeFalsy();
    first.el.remove();
    const second = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    await settle(second.el, 12);
    expect(text(second.root)).toContain("already has files");
    expect(text(second.root)).not.toContain("earlier try");
    expect(calls.some((c) => c.url.endsWith("/bootstrap") && (c.body as { force?: boolean }).force)).toBe(
      false,
    );
  });

  it("stops polling when the page is left, even after GitHub asked it to wait", async () => {
    serve({
      status: personalStatus(),
      reposFail: { status: 429, body: { error: "slow down", code: "rate-limited", retryAfter: 1 } },
    });
    draftFor();
    const { el } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 30 });
    await new Promise((r) => setTimeout(r, 120));
    el.remove();
    const refreshes = () => calls.filter((c) => c.url.startsWith("/api/github/repos?refresh=1")).length;
    const seen = refreshes();
    expect(seen).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1300));
    expect(refreshes()).toBe(seen);
  });

  it("says GitHub isn't answering, instead of 'Not there yet', when only an old list came back", async () => {
    serve({
      status: personalStatus(),
      reposExtra: {
        fetchedAt: Date.UTC(2026, 9, 21, 10, 5),
        warning: { code: "unavailable", error: "GitHub is having trouble right now." },
      },
    });
    draftFor();
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    button(root, "Refresh now").click();
    await settle(el, 12);
    expect(text(root)).toContain("GitHub isn't answering");
    expect(text(root)).toContain("Showing the list from");
    expect(text(root)).not.toContain("Not there yet");
    expect(text(root)).toContain("Waiting for the repo");
  });

  it("says when a Refresh was held back", async () => {
    serve({ status: personalStatus(), reposExtra: { throttled: true } });
    draftFor();
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    button(root, "Refresh now").click();
    await settle(el, 12);
    expect(text(root)).toContain("only a moment old");
    expect(text(root)).not.toContain("Not there yet");
  });

  it("clears the draft when started over", async () => {
    serve({ status: personalStatus() });
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new", pollMs: 0 });
    await fill(el, root, "fresh");
    button(root, /^Next/).click();
    await settle(el);
    expect(draft()).not.toBeNull();
    button(root, "Cancel and start over").click();
    await settle(el);
    expect(draft()).toBeNull();
    expect(root.querySelector('input[name="name"]')).not.toBeNull();
  });

  it("doesn't start when the GitHub App isn't set up", async () => {
    serve({
      status: orgStatus({
        configured: false,
        installation: null,
        create: { possible: false, reason: "not-configured", detail: "The GitHub App isn't set up yet." },
      }),
    });
    const { el, root } = await mount<Flow>("inc-project-flow", { flow: "new" });
    await fill(el, root, "fresh");
    expect((button(root, /^Next/) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("a project's page", () => {
  type Page = HTMLElement & { updateComplete: Promise<unknown> };

  it("shows the repo, mode, recent tickets and releases, and the two ways to start work", async () => {
    serve();
    const { root } = await mount<Page>("inc-project-page", { projectId: "Duet" });
    expect(text(root.querySelector("h2"))).toBe("Duet");
    expect(root.querySelector("a.repo")?.getAttribute("href")).toBe("https://github.com/acme/duet");
    expect(text(root.querySelector(".facts"))).toContain("Owner merges");
    expect(text(root.querySelector(".facts"))).toContain("PR #41");
    expect(link(root, "Start a conversation").getAttribute("href")).toBe(
      "#/conversations?new=1&project=Duet",
    );
    expect(text(root.querySelector('[aria-label="Recent tickets"]'))).toContain("#12 Fix refunds");
    expect(text(root.querySelector('[aria-label="Releases"]'))).toContain("v1.0");
    const checks = [...root.querySelectorAll('input[aria-label^="command"]')].map(
      (i) => (i as HTMLInputElement).value,
    );
    expect(checks).toEqual(["pnpm install", "pnpm check", "pnpm typecheck", "pnpm test"]);
  });

  it("opens the new-ticket form with this project chosen", async () => {
    serve();
    const { el, root } = await mount<Page>("inc-project-page", { projectId: "listy" });
    expect(root.querySelector("inc-new-ticket")).toBeNull();
    button(root, "New ticket").click();
    await settle(el, 14);
    const form = root.querySelector("inc-new-ticket") as HTMLElement & { project: string; open: boolean };
    expect(form).not.toBeNull();
    expect(form.open).toBe(true);
    expect(form.project).toBe("listy");
  });

  it("saves an edited recipe and mode as one PUT", async () => {
    serve();
    const { el, root } = await mount<Page>("inc-project-page", { projectId: "Duet" });
    expect((button(root, "Save") as HTMLButtonElement).disabled).toBe(true);
    (root.querySelector('[aria-label="Remove command 1"]') as HTMLElement).click();
    await settle(el);
    const direct = root.querySelector('input[type="radio"][value="direct"]') as HTMLInputElement;
    direct.click();
    direct.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(el);
    expect(text(root)).toContain("Unsaved changes");
    button(root, "Save").click();
    await settle(el);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/projects/Duet");
    expect(put?.body).toMatchObject({
      repo: "acme/duet",
      checks: ["pnpm check", "pnpm typecheck", "pnpm test"],
      mode: "direct",
      defaultBranch: "main",
    });
    expect(text(root)).toContain("Saved");
  });

  it("refuses an empty recipe", async () => {
    serve({ projects: [listy] });
    const { el, root } = await mount<Page>("inc-project-page", { projectId: "listy" });
    (root.querySelector('[aria-label="Remove command 1"]') as HTMLElement).click();
    await settle(el);
    button(root, "Save").click();
    await settle(el);
    expect(text(root.querySelector('[role="alert"]'))).toContain("at least one command");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("removes a project only when confirmed", async () => {
    serve();
    const { el, root } = await mount<Page>("inc-project-page", { projectId: "Duet" });
    window.confirm = vi.fn().mockReturnValue(false);
    button(root, "Remove this project").click();
    await settle(el);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    window.confirm = vi.fn().mockReturnValue(true);
    button(root, "Remove this project").click();
    await settle(el);
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/projects/Duet");
    location.hash = "";
  });

  it("says when there is no such project", async () => {
    serve();
    const { root } = await mount<Page>("inc-project-page", { projectId: "ghost" });
    expect(text(root)).toContain("There is no project called ghost");
    expect(link(root, "Back to projects").getAttribute("href")).toBe("#/company/projects");
  });
});

describe("the new-ticket form preset", () => {
  it("chooses the preset project and starts open", async () => {
    serve({ projects: [duet, listy] });
    const { el, root } = await mount<HTMLElement & { project: string; open: boolean }>("inc-new-ticket", {
      presetProject: "listy",
      startOpen: true,
    });
    await settle(el);
    expect(el.open).toBe(true);
    expect((root.querySelector('select[name="project"]') as HTMLSelectElement).value).toBe("listy");
  });
});

describe("a daemon 401 signs the owner out, a GitHub problem doesn't", () => {
  it("shows the sign-in when the daemon says 401", async () => {
    vi.stubGlobal("fetch", async () => json({ error: "unauthorized" }, 401));
    const { projectsApi } = await import("../src/github-projects.ts");
    await expect(projectsApi.status()).rejects.toThrow("unauthorized");
    expect(document.querySelector("inc-login")).not.toBeNull();
  });

  it("does not, for a GitHub problem", async () => {
    vi.stubGlobal("fetch", async () =>
      json({ error: "GitHub didn't accept i.inc's sign-in as the bot.", code: "auth" }, 424),
    );
    const { projectsApi } = await import("../src/github-projects.ts");
    await expect(projectsApi.status()).rejects.toThrow("sign-in as the bot");
    expect(document.querySelector("inc-login")).toBeNull();
  });
});
