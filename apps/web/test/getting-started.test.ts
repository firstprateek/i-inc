// The first-run checklist on Conversations (T61): its state comes from the daemon, it is hidden once
// everything is done or the owner dismisses it, and the dismissal sticks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncApp } from "../src/components/app.ts";
import {
  checklist,
  DISMISS_KEY,
  GITHUB_INSTALL_URL,
  GITHUB_MANAGE_URL,
  type IncGettingStarted,
  type Progress,
  STARTED_KEY,
} from "../src/components/getting-started.ts";
import { messageSent, showGettingStarted } from "../src/first-run.ts";

interface Daemon {
  repos?: unknown[] | "fail";
  projects?: unknown[];
  employees?: { id: string; name: string }[];
  /** Entries by employee; a thread with an owner entry means the owner has spoken. */
  chat?: Record<string, { from: string }[]>;
  /** The latest entry per thread, as /api/chat lists it. */
  last?: Record<string, { from: string } | null>;
  /** The conversations (the new ones, over AHP: /api/conversations). */
  conversations?: unknown[];
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
    if (url.startsWith("/api/conversations")) return ok({ conversations: d.conversations ?? [] });
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

const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, " ").trim();

/** The compact row: the count, the next step, and its main action. */
const bar = (root: ShadowRoot) => ({
  count: text(root.querySelector(".count")),
  next: text(root.querySelector(".next b")),
  note: text(root.querySelector(".next .err")),
  action: root.querySelector<HTMLAnchorElement>(".bar a.primary"),
});

/** Opens the remaining steps and lists them. */
async function steps(el: IncGettingStarted) {
  const root = el.shadowRoot as ShadowRoot;
  if (!root.querySelector(".more")) {
    (root.querySelector("button.toggle") as HTMLButtonElement).click();
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
    }
  }
  return [...root.querySelectorAll("li.step")].map((li) => ({
    title: text(li.querySelector("b")),
    text: text(li.querySelector("p")),
    next: li.classList.contains("next-step"),
    actions: [...li.querySelectorAll("a.btn")].map((a) => text(a)),
  }));
}

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
    for (const s of checklist({ github: "error", project: "error", team: "error", conversation: "error" }))
      expect(s.text.match(/[.!?](\s|$)/g)?.length, s.text).toBe(1);
  });

  it("sends the first install to the bot's install page, and repository access to GitHub's installed-apps settings", () => {
    const [github, project, team, conversation] = checklist(none, "ada");
    expect(github?.actions.map((a) => [a.label, a.href])).toEqual([
      ["Install the bot", "https://github.com/apps/i-inc-bot/installations/new"],
      ["Manage repository access", "https://github.com/settings/installations"],
      ["Company → Projects", "#/company/projects"],
    ]);
    expect(github?.actions.slice(0, 2).every((a) => a.external)).toBe(true);
    expect(project?.actions.map((a) => a.href)).toEqual(["#/company/projects"]);
    expect(team?.actions.map((a) => a.href)).toEqual(["#/company/team", "#/company/team/hiring"]);
    expect(conversation?.actions.map((a) => a.href)).toEqual(["#/conversations/new/ada"]);
    // with no employee known yet, the new-conversation form without one
    expect(
      checklist(none)
        .at(3)
        ?.actions.map((a) => a.href),
    ).toEqual(["#/conversations?new=1"]);
    expect(GITHUB_INSTALL_URL).not.toBe(GITHUB_MANAGE_URL);
  });

  it("marks done steps and drops their actions, and says so when a step could not be checked", () => {
    const list = checklist({ ...none, github: true, team: true, project: "error" }, "ada");
    expect(list.map((s) => s.done)).toEqual([true, false, true, false]);
    expect(list.map((s) => s.error)).toEqual([false, true, false, false]);
    expect(list[0]?.actions).toEqual([]);
    expect(list[1]?.text).toBe("Couldn't check this just now.");
    expect(list[1]?.actions.length).toBeGreaterThan(0);
  });
});

describe("the Getting started checklist", () => {
  it("is one compact row: the count, the next step, its action, Steps and Dismiss", async () => {
    serve({ repos: [], projects: [], employees: [{ id: "ada", name: "Ada" }] });
    const { el, root } = await mountList();
    expect(el.hidden).toBe(false);
    expect(root.querySelector("h2")?.textContent).toBe("Getting started");
    expect(bar(root)).toMatchObject({ count: "1/4", next: "Connect GitHub", note: undefined });
    const go = bar(root).action as HTMLAnchorElement;
    expect(text(go)).toBe("Install");
    expect(go.getAttribute("href")).toBe(GITHUB_INSTALL_URL);
    expect(go.getAttribute("target")).toBe("_blank");
    expect(go.getAttribute("rel")).toBe("noopener noreferrer");
    expect(go.getAttribute("aria-label")).toBe("Install the bot (opens GitHub)");
    expect(
      [...root.querySelectorAll(".bar button")].map((b) => b.getAttribute("aria-label") ?? text(b)),
    ).toEqual(["Steps", "Dismiss getting started"]);
    // nothing but the row until it is opened, and never a card for a finished step
    expect(root.querySelector(".more")).toBeNull();
  });

  it("shows only what remains when opened, as rows, and never the finished steps", async () => {
    serve({ repos: [], projects: [], employees: [{ id: "ada", name: "Ada" }] });
    const { el, root } = await mountList();
    const list = await steps(el);
    expect(root.querySelector("button.toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(list.map((s) => s.title)).toEqual(["Connect GitHub", "Add a project", "Start a conversation"]);
    expect(list[0]).toMatchObject({
      next: true,
      actions: ["Install the bot", "Manage repository access", "Company → Projects"],
    });
    expect(list[1]?.actions).toEqual(["Add a project"]);
    // the first action of the next step is the filled one
    const filled = root.querySelectorAll("li.next-step a.btn:not(.ghost)");
    expect(filled.length).toBe(1);
    (root.querySelector("button.toggle") as HTMLButtonElement).click();
    await el.updateComplete;
    expect(root.querySelector(".more")).toBeNull();
  });

  it("is short: the row is a 44px control row, with no cards (CSS)", () => {
    const css = (
      customElements.get("inc-getting-started") as unknown as { styles: { cssText: string }[] }
    ).styles
      .map((s) => s.cssText)
      .join("\n");
    expect(css).toMatch(/\.bar \{[^}]*min-height: 44px/);
    expect(css).not.toMatch(/max-height:\s*44dvh/);
    expect(css).toMatch(/grid-template-areas: "title toggle dismiss" "next next primary"/);
  });

  it("moves on to the next undone step when GitHub is connected", async () => {
    serve({ repos: [{ fullName: "me/duet" }] });
    const { root } = await mountList();
    expect(bar(root)).toMatchObject({ count: "2/4", next: "Add a project" });
    expect(bar(root).action?.getAttribute("href")).toBe("#/company/projects");
  });

  it('says "Couldn\'t check" when GitHub cannot be asked, rather than not done', async () => {
    serve({ repos: "fail" });
    const { el, root } = await mountList();
    expect(bar(root)).toMatchObject({ next: "Connect GitHub", note: "· Couldn't check" });
    expect((await steps(el))[0]?.text).toBe("Couldn't check this just now.");
  });

  it('says "Couldn\'t check" for the other steps when their reads fail', async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/github/repos") return new Response(JSON.stringify({ repos: [{ fullName: "a/b" }] }));
      return new Response("{}", { status: 500 });
    });
    const { el } = await mountList();
    const list = await steps(el);
    expect(list.map((s) => [s.title, s.text])).toEqual([
      ["Add a project", "Couldn't check this just now."],
      ["Meet your team", "Couldn't check this just now."],
      ["Start a conversation", "Couldn't check this just now."],
    ]);
  });

  it("marks Add a project done when there is a project", async () => {
    serve({ projects: [{ id: "Duet" }] });
    const { el } = await mountList();
    expect((await steps(el)).map((s) => s.title)).not.toContain("Add a project");
  });

  it("marks Meet your team done with one employee, and not done with none", async () => {
    serve({ employees: [] });
    let { el } = await mountList();
    expect((await steps(el)).map((s) => s.title)).toContain("Meet your team");
    document.body.innerHTML = "";
    serve({ employees: [{ id: "ada", name: "Ada" }] });
    ({ el } = await mountList());
    expect((await steps(el)).map((s) => s.title)).not.toContain("Meet your team");
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
    const { el } = await mountList();
    expect((await steps(el)).map((s) => s.title)).not.toContain("Start a conversation");
    expect(localStorage.getItem(STARTED_KEY)).toBe("1");
  });

  it("is not done when the employees have only written to the owner", async () => {
    serve({ chat: { ada: [{ from: "employee" }, { from: "system" }] } });
    const { el } = await mountList();
    expect((await steps(el)).map((s) => s.title)).toContain("Start a conversation");
  });

  it("is done from the latest entry alone, without reading the threads", async () => {
    serve({ last: { ada: { from: "owner" } } });
    const { el } = await mountList();
    expect((await steps(el)).map((s) => s.title)).not.toContain("Start a conversation");
    expect(requests).not.toContain("/api/chat/ada");
  });

  it("marks Start a conversation done at once when the chat reports a sent message", async () => {
    serve({ repos: [{ fullName: "a/b" }], projects: [{ id: "Duet" }] });
    const { el, root } = await mountList();
    expect(bar(root)).toMatchObject({ count: "3/4", next: "Start a conversation" });
    requests = [];
    messageSent();
    for (let i = 0; i < 4; i++) await el.updateComplete;
    expect(el.hidden).toBe(true);
    expect(requests).toEqual([]);
    expect(localStorage.getItem(STARTED_KEY)).toBe("1");
  });

  it("sends the Start action to the new conversation form, not to the old chat", async () => {
    serve({ repos: [{ fullName: "a/b" }], projects: [{ id: "Duet" }] });
    const { el } = await mountList();
    const start = bar(el.shadowRoot as ShadowRoot).action as HTMLAnchorElement;
    expect(text(start)).toBe("Start");
    expect(start.getAttribute("href")).toBe("#/conversations/new/ada");
    // and that address is the new form, where the old chat's addresses are redirected to #/conversations/old/...
    const { parse } = await import("../src/routes.ts");
    expect(parse(start.getAttribute("href") ?? "")).toMatchObject({
      view: "conversations",
      draft: { employee: "ada" },
    });
  });

  it("marks Start a conversation done when a conversation exists, though the old chat is empty", async () => {
    serve({ conversations: [{ id: "ab12cd34", employeeId: "ada", title: "Hello" }] });
    const { el } = await mountList();
    expect((await steps(el)).map((s) => s.title)).not.toContain("Start a conversation");
    expect(localStorage.getItem(STARTED_KEY)).toBe("1");
  });

  it("reaches 4/4 and hides itself once a conversation exists", async () => {
    serve({
      repos: [{ fullName: "a/b" }],
      projects: [{ id: "Duet" }],
      conversations: [{ id: "ab12cd34", employeeId: "ada", title: "Hello" }],
    });
    const { el } = await mountList();
    expect(el.hidden).toBe(true);
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

  it("comes back with showGettingStarted(), on screen or on the next visit", async () => {
    serve();
    const { el, root } = await mountList();
    (root.querySelector("button.dismiss") as HTMLButtonElement).click();
    await el.updateComplete;
    expect(el.hidden).toBe(true);
    showGettingStarted();
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
    }
    expect(el.hidden).toBe(false);
    expect(localStorage.getItem(DISMISS_KEY)).toBeNull();
    expect(bar(root).next).toBe("Connect GitHub");
  });

  it("keeps a done step done for the visit, so a refresh does not ask GitHub again", async () => {
    serve({ repos: [{ fullName: "me/duet" }] });
    const { el } = await mountList();
    requests = [];
    await el.check();
    expect(requests).not.toContain("/api/github/repos");
  });

  it("shows two small rows on a phone: the title with Steps and a dismiss icon, then the next step (CSS)", () => {
    const css = (
      customElements.get("inc-getting-started") as unknown as { styles: { cssText: string }[] }
    ).styles
      .map((s) => s.cssText)
      .join("\n");
    expect(css).toMatch(/\.dismiss \{ width: 44px/);
    // and on a short one, a single row
    expect(css).toMatch(
      /\(max-height: 640px\)[^@]*grid-template-areas: "next primary dismiss"[^}]*\}\s*\.bar \.title, \.bar \.toggle/,
    );
  });
});

describe("the checklist on Conversations", () => {
  it("is in the centre of the new conversation screen, under the composer, and nowhere else", async () => {
    serve();
    location.hash = "#/conversations";
    const app = new IncApp();
    document.body.append(app);
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    // not above the conversations (that pushed the page down once it had loaded)
    const host = app.shadowRoot?.querySelector(".conv-host");
    expect([...(host?.children ?? [])].map((c) => c.tagName.toLowerCase())).toEqual(["inc-conversations"]);
    const draft = host?.querySelector("inc-conversations")?.shadowRoot?.querySelector("inc-conv-draft");
    const box = draft?.shadowRoot?.querySelector(".draft");
    expect([...(box?.children ?? [])].at(-1)?.tagName.toLowerCase()).toBe("inc-getting-started");
    for (const hash of ["#/work/board", "#/company/team", "#/needs-you"]) {
      location.hash = hash;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await app.updateComplete;
      expect(app.shadowRoot?.querySelector("inc-getting-started"), hash).toBeNull();
    }
  });
});
