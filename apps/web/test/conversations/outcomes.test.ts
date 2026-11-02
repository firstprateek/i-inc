// What the shell says about a ticket or PR request the owner left behind: the sentences, and the banner itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/components/app.ts";
import "../../src/components/board.ts";
import { outcomeView, type ShipOutcome, shipOutcomes } from "../../src/conversations/outcomes.ts";
import { must, until } from "../ahp/fake-host.ts";

const of = (o: Partial<ShipOutcome>): ShipOutcome => ({
  id: 1,
  conversationId: "ab12cd34",
  title: "Greeting",
  kind: "ticket",
  ...o,
});

afterEach(() => {
  shipOutcomes.clear();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("what an outcome says", () => {
  const back = { href: "#/conversations/ab12cd34", label: "Open the conversation", external: false };

  it("gives a ticket's link", () => {
    expect(outcomeView(of({ done: { kind: "ticket", ticketId: "12" } }))).toEqual({
      text: 'Ticket #12 is made from "Greeting".',
      href: "#/ticket/12",
      label: "Open ticket #12",
      external: false,
    });
  });

  it("gives a pull request's link, and no link for an address that isn't one", () => {
    const pr = (url: string) => of({ kind: "pr", done: { kind: "pr", pr: { number: 7, url } } });
    expect(outcomeView(pr("https://github.com/o/r/pull/7"))).toEqual({
      text: 'Pull request #7 for "Greeting" is open as a draft.',
      href: "https://github.com/o/r/pull/7",
      label: "Open it on GitHub",
      external: true,
    });
    expect(outcomeView(pr("javascript:alert(1)")).href).toBeUndefined();
  });

  it("says what didn't happen and why, and leads back to the conversation", () => {
    for (const [kind, words] of [
      ["ticket", "Couldn't make a ticket from"],
      ["pr", "Couldn't open a pull request for"],
      ["takeback", "Couldn't take back the work on"],
    ] as const) {
      expect(outcomeView(of({ kind, failure: "It went wrong." }))).toEqual({
        text: `${words} "Greeting": It went wrong.`,
        ...back,
      });
    }
  });

  it("says when taking the work back left a pull request open", () => {
    const done = { kind: "takeback" as const, prState: "open" as const };
    expect(outcomeView(of({ kind: "takeback", done: { ...done, prState: "closed" } }))).toEqual({
      text: 'The work on "Greeting" is yours again.',
      ...back,
    });
    expect(outcomeView(of({ kind: "takeback", done })).text).toBe(
      'The work on "Greeting" is yours again. Its pull request is still open on GitHub.',
    );
  });
});

describe("the shell", () => {
  const banners = (app: HTMLElement) => [...(app.shadowRoot?.querySelectorAll(".outcome") ?? [])];
  const mount = async () => {
    location.hash = "#/work/board";
    const app = document.createElement("inc-app");
    document.body.append(app);
    await (app as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    return app;
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    );
  });

  it("shows how a request ended in the frame's notice slot, on whatever page is open, and takes it down", async () => {
    const app = await mount();
    shipOutcomes.add({
      conversationId: "ab12cd34",
      title: "Greeting",
      kind: "ticket",
      done: { kind: "ticket", ticketId: "12" },
    });
    await until(() => banners(app).length === 1);
    const banner = must(banners(app)[0]);
    expect(banner.getAttribute("slot")).toBe("notice");
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.querySelector("span")?.textContent).toBe('Ticket #12 is made from "Greeting".');
    expect(banner.querySelector("a")?.getAttribute("href")).toBe("#/ticket/12");
    must(banner.querySelector("button")).click();
    await until(() => banners(app).length === 0);
    expect(shipOutcomes.list()).toEqual([]);
  });

  it("calls a failure out, opens a pull request in a new tab, and following a link takes the banner down", async () => {
    const app = await mount();
    shipOutcomes.add({ conversationId: "ab12cd34", title: "Greeting", kind: "ticket", failure: "No." });
    shipOutcomes.add({
      conversationId: "ab12cd34",
      title: "Greeting",
      kind: "pr",
      done: { kind: "pr", pr: { number: 7, url: "https://github.com/o/r/pull/7" } },
    });
    await until(() => banners(app).length === 2);
    const [failed, pr] = [must(banners(app)[0]), must(banners(app)[1])];
    expect(failed.getAttribute("role")).toBe("alert");
    expect(failed.querySelector("a")?.getAttribute("href")).toBe("#/conversations/ab12cd34");
    const link = must(pr.querySelector("a"));
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
    link.addEventListener("click", (e) => e.preventDefault());
    link.click();
    await until(() => banners(app).length === 1);
  });
});
