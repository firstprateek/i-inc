// The hash router: every view the tab bar and the header link to must open that view, on a phone too,
// where an unknown hash falls back to the inbox. (Office once fell through to that fallback.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncApp, parse } from "../src/components/app.ts";

const phone = (matches: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));

afterEach(() => {
  vi.unstubAllGlobals();
  location.hash = "";
});

describe("parse", () => {
  it.each(["office", "board", "desk", "inbox", "handbook", "more", "hiring", "chat"])(
    "#/%s opens that view on a phone and on a desktop",
    (view) => {
      for (const onPhone of [true, false]) {
        phone(onPhone);
        expect(parse(`#/${view}`).view).toBe(view);
      }
    },
  );

  it("starts at the inbox on a phone and the office on a desktop", () => {
    phone(true);
    expect(parse("").view).toBe("inbox");
    phone(false);
    expect(parse("").view).toBe("office");
  });
});

describe("the tab bar", () => {
  it("every tab's link opens the view it names", async () => {
    phone(true);
    vi.stubGlobal("fetch", () => new Promise(() => {})); // the views just wait for data
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    const tabs = [...(app.shadowRoot?.querySelectorAll(".tabs a") ?? [])];
    expect(tabs.map((a) => a.textContent?.trim())).toEqual(["Inbox", "Office", "Board", "Chats", "More"]);
    const office = tabs[1] as HTMLAnchorElement;
    expect(office.getAttribute("href")).toBe("#/office");
    location.hash = office.getAttribute("href") ?? "";
    await new Promise((r) => setTimeout(r, 0));
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector("inc-office")).not.toBeNull();
    app.remove();
  });
});
