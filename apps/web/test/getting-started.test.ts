// The first-run checklist on Conversations (T61): its state comes from the daemon, it is hidden once
// everything is done or the owner dismisses it, and the dismissal sticks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncApp } from "../src/components/app.ts";
import {
  checklist,
  DISMISS_KEY,
  GITHUB_INSTALL_URL,
  type IncGettingStarted,
  type Progress,
  STARTED_KEY,
} from "../src/components/getting-started.ts";

interface Daemon {
  repos?: unknown[] | "fail";
  projects?: unknown[];
  employees?: { id: string; name: string }[];
  /** Entries by employee; a thread with an owner entry means the owner has spoken. */
  chat?: Record<string, { from: string }[]>;
  /** The latest entry per thread, as /api/chat lists it. */
  last?: Record<string, { from: string } | null>;
}

let requests: string[] = [];

function serve(d: Daemon = {}) {
  requests = [];
  const employees = d.employees ?? [{ id: "ada", name: "Ada" }];
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(url);
    const ok = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/github/repos")
      return d.repos === "fail" ? ok({ error: "no github", repos: [] }, 502) : ok({ repos: d.repos ?? [] });
    if (url === "/api/projects") return ok({ projects: d.projects ?? [] });
    if (url === "/api/employees") return ok({ employees });
    if (url === "/api/chat")
      return ok({
        threads: employees.map((e) => ({ id: e.id, name: e.name, last: d.last?.[e.id] ?? null })),
      });
    if (url.startsWith("/api/chat/")) return ok({ entries: d.chat?.[url.slice("/api/chat/".length)] ?? [] });
    return ok({});
  });
}

async function mountList(): Promise<{ el: IncGettingStarted; root: ShadowRoot }> {
  const el = document.createElement("inc-getting-started") as IncGettingStarted;
  document.body.append(el);
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
  return { el, root: el.shadowRoot as ShadowRoot };
}

/** A step's title without its number badge or the screen-reader "(done)". */
const titleOf = (li: Element) => {
  const t = li.querySelector(".title")?.cloneNode(true) as HTMLElement;
  for (const x of t.querySelectorAll(".badge, .sr")) x.remove();
  return t.textContent?.trim();
};

const steps = (root: ShadowRoot) =>
  [...root.querySelectorAll("li.step")].map((li) => ({
    title: titleOf(li),
    done: li.classList.contains("complete"),
    next: li.classList.contains("next"),
    actions: [...li.querySelectorAll("a.btn")].map((a) =>
      a.textContent?.replace(/\s*\(opens GitHub\)/, "").trim(),
    ),
  }));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  location.hash = "";
});

describe("checklist()", () => {
  const none: Progress = { github: false, project: false, team: false, conversation: false };

  it("has the four steps, one sentence each, in order", () => {
    const list = checklist(none, "ada");
    expect(list.map((s) => s.title)).toEqual([
      "Connect GitHub",
      "Add a project",
      "Meet your team",
      "Start a conversation",
    ]);
    for (const s of list) expect(s.text.match(/[.!?](\s|$)/g)?.length, s.text).toBe(1);
  });

  it("links GitHub to the bot's install settings and Company → Projects, and the other steps to their places", () => {
    const [github, project, team, conversation] = checklist(none, "ada");
    expect(github?.actions.map((a) => a.href)).toEqual([GITHUB_INSTALL_URL, "#/company/projects"]);
    expect(github?.actions[0]?.external).toBe(true);
    expect(project?.actions.map((a) => a.href)).toEqual(["#/company/projects"]);
    expect(team?.actions.map((a) => a.href)).toEqual(["#/company/team", "#/company/team/hiring"]);
    expect(conversation?.actions.map((a) => a.href)).toEqual(["#/conversations/ada"]);
  });

  it("marks done steps, and drops their actions", () => {
    const list = checklist({ ...none, github: true, team: true }, "ada");
    expect(list.map((s) => s.done)).toEqual([true, false, true, false]);
    expect(list[0]?.actions).toEqual([]);
    expect(list[2]?.actions).toEqual([]);
    expect(list[1]?.actions.length).toBeGreaterThan(0);
  });
});

describe("the Getting started checklist", () => {
  it("is shown on a fresh install with the first undone step as the main one", async () => {
    serve({ repos: [], projects: [], employees: [{ id: "ada", name: "Ada" }] });
    const { el, root } = await mountList();
    expect(el.hidden).toBe(false);
    expect(root.querySelector("h2")?.textContent).toBe("Getting started");
    expect(root.querySelector('[role="status"]')?.textContent).toBe("1 of 4 done");
    expect(steps(root)).toEqual([
      {
        title: "Connect GitHub",
        done: false,
        next: true,
        actions: ["Open GitHub settings", "Company → Projects"],
      },
      { title: "Add a project", done: false, next: false, actions: ["Add a project"] },
      { title: "Meet your team", done: true, next: false, actions: [] },
      { title: "Start a conversation", done: false, next: false, actions: ["Start a conversation"] },
    ]);
    // the main action is filled, the others are ghost
    const first = root.querySelector("li.next a.btn") as HTMLAnchorElement;
    expect(first.classList.contains("ghost")).toBe(false);
    expect(first.getAttribute("href")).toBe(GITHUB_INSTALL_URL);
    expect(first.getAttribute("target")).toBe("_blank");
    expect(first.getAttribute("rel")).toBe("noopener noreferrer");
    expect(root.querySelector('li.step a[href="#/company/projects"]')).not.toBeNull();
  });

  it("marks GitHub done when the bot can see at least one repository", async () => {
    serve({ repos: [{ fullName: "me/duet" }] });
    const { root } = await mountList();
    expect(steps(root)[0]).toMatchObject({ title: "Connect GitHub", done: true });
    expect(steps(root)[1]).toMatchObject({ title: "Add a project", done: false, next: true });
  });

  it("treats a GitHub error as not connected yet", async () => {
    serve({ repos: "fail" });
    const { root } = await mountList();
    expect(steps(root)[0]).toMatchObject({ done: false });
  });

  it("marks Add a project done when there is a project", async () => {
    serve({ projects: [{ id: "Duet" }] });
    const { root } = await mountList();
    expect(steps(root)[1]).toMatchObject({ title: "Add a project", done: true });
  });

  it("marks Meet your team done with one employee, and not done with none", async () => {
    serve({ employees: [] });
    let { root } = await mountList();
    expect(steps(root)[2]).toMatchObject({ title: "Meet your team", done: false });
    document.body.innerHTML = "";
    serve({ employees: [{ id: "ada", name: "Ada" }] });
    ({ root } = await mountList());
    expect(steps(root)[2]).toMatchObject({ done: true });
  });

  it("marks Start a conversation done when any thread has an owner message", async () => {
    serve({
      employees: [
        { id: "ada", name: "Ada" },
        { id: "kit", name: "Kit" },
      ],
      chat: { ada: [{ from: "employee" }], kit: [{ from: "owner" }, { from: "employee" }] },
      last: { kit: { from: "employee" } },
    });
    const { root } = await mountList();
    expect(steps(root)[3]).toMatchObject({ title: "Start a conversation", done: true });
    expect(localStorage.getItem(STARTED_KEY)).toBe("1");
  });

  it("is not done when the employees have only written to the owner", async () => {
    serve({ chat: { ada: [{ from: "employee" }, { from: "system" }] } });
    const { root } = await mountList();
    expect(steps(root)[3]).toMatchObject({ done: false });
  });

  it("is done from the latest entry alone, without reading the threads", async () => {
    serve({ last: { ada: { from: "owner" } } });
    const { root } = await mountList();
    expect(steps(root)[3]).toMatchObject({ done: true });
    expect(requests).not.toContain("/api/chat/ada");
  });

  it("sends Start a conversation to the message field when the conversations are on screen", async () => {
    serve();
    const host = document.createElement("div");
    const chat = document.createElement("inc-chat");
    chat.attachShadow({ mode: "open" }).innerHTML = "<textarea></textarea>";
    const el = document.createElement("inc-getting-started") as IncGettingStarted;
    host.append(el, chat);
    document.body.append(host);
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const start = [...(el.shadowRoot?.querySelectorAll("a.btn") ?? [])].find((a) =>
      a.textContent?.includes("Start a conversation"),
    ) as HTMLAnchorElement;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    start.dispatchEvent(click);
    expect(focus).toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(true);
  });

  it("goes away once all four are done", async () => {
    serve({
      repos: [{ fullName: "me/duet" }],
      projects: [{ id: "Duet" }],
      last: { ada: { from: "owner" } },
    });
    const { el, root } = await mountList();
    expect(el.hidden).toBe(true);
    expect(root.querySelector(".gs")).toBeNull();
  });

  it("is dismissed with the Dismiss button, and stays dismissed", async () => {
    serve();
    let { el, root } = await mountList();
    expect(el.hidden).toBe(false);
    (root.querySelector("button.dismiss") as HTMLButtonElement).click();
    await el.updateComplete;
    expect(el.hidden).toBe(true);
    expect(root.querySelector(".gs")).toBeNull();
    expect(localStorage.getItem(DISMISS_KEY)).toBe("1");

    // a later visit finds it dismissed, and does not even ask the daemon
    document.body.innerHTML = "";
    serve();
    ({ el, root } = await mountList());
    expect(el.hidden).toBe(true);
    expect(requests).toEqual([]);
  });

  it("keeps a done step done for the visit, so a refresh does not ask GitHub again", async () => {
    serve({ repos: [{ fullName: "me/duet" }] });
    const { el } = await mountList();
    requests = [];
    await el.check();
    expect(requests).not.toContain("/api/github/repos");
  });

  it("shows one step on a phone and keeps the card short (CSS)", () => {
    const css = (
      customElements.get("inc-getting-started") as unknown as { styles: { cssText: string }[] }
    ).styles
      .map((s) => s.cssText)
      .join("\n");
    expect(css).toMatch(/\.step:not\(\.next\)\s*\{\s*display:\s*none/);
    expect(css).toMatch(/max-height:\s*44dvh/);
  });
});

describe("the checklist on Conversations", () => {
  it("is on the Conversations screen above the conversations, and nowhere else", async () => {
    serve();
    location.hash = "#/conversations";
    const app = new IncApp();
    document.body.append(app);
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    const host = app.shadowRoot?.querySelector(".conv-host");
    expect([...(host?.children ?? [])].map((c) => c.tagName.toLowerCase())).toEqual([
      "inc-getting-started",
      "inc-chat",
    ]);
    for (const hash of ["#/work/board", "#/company/team", "#/work/needs-you"]) {
      location.hash = hash;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await app.updateComplete;
      expect(app.shadowRoot?.querySelector("inc-getting-started"), hash).toBeNull();
    }
  });
});
