import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/desk.ts";
import type { IncDesk } from "../src/components/desk.ts";

describe("My desk view and releases (T33)", () => {
  let calls: { method: string; url: string; body: unknown }[] = [];

  const deskData = {
    spend: {
      total: 45.5,
      lines: [
        { name: "Hardware", kind: "depreciation", amount: 20, basis: "Mac mini / 36 mo" },
        { name: "Electricity", kind: "power", amount: 5.5, basis: "idle + busy watts" },
        { name: "Claude", kind: "api", amount: 20, basis: "tokens" },
      ],
      perMergedPR: 4.55,
    },
    waits: [
      { reason: "tokens", hours: 1.5, tickets: 2 },
      { reason: "owner-decision", hours: 0.5, tickets: 1 },
    ],
    bottleneck: { reason: "tokens", hours: 1.5, tickets: 2 },
    merged: 10,
    releases: [
      {
        project: "Duet",
        tag: "v2026-10-17.1",
        at: 1792200000000,
        ticketIds: ["1", "2"],
        commits: ["sha111", "sha222"],
      },
    ],
    pendingReleases: [
      {
        project: "Duet",
        id: "Duet",
        repo: "firstprateek/duet",
        pendingTickets: [
          { id: "3", title: "Add feature X", pushed: "sha3333333" },
          { id: "4", title: "Fix bug Y", pushed: "sha4444444" },
        ],
      },
      {
        project: "i-inc",
        id: "i-inc",
        repo: "firstprateek/i-inc",
        pendingTickets: [],
      },
    ],
  };

  const learnedData = {
    changes: [
      {
        at: 1792250000000,
        subject: "Saved memory in sessions",
        authorName: "Ada",
        repo: "handbook",
        reverted: false,
      },
    ],
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    calls = [];
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function serveDesk(overrides?: {
    releaseStatus?: number;
    releaseError?: string;
    onRelease?: () => Promise<void>;
  }) {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      if (url === "/api/desk") {
        return new Response(JSON.stringify(deskData), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/knowledge/recent") {
        return new Response(JSON.stringify(learnedData), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/projects/")) {
        if (overrides?.onRelease) {
          await overrides.onRelease();
        }
        if (overrides?.releaseStatus && overrides.releaseStatus >= 400) {
          return new Response(JSON.stringify({ error: overrides.releaseError ?? "server error" }), {
            status: overrides.releaseStatus,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            release: {
              project: "Duet",
              tag: "v2026-10-18.1",
              at: Date.now(),
              ticketIds: ["3", "4"],
              commits: ["sha3333333", "sha4444444"],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });
  }

  async function mount(): Promise<{ el: IncDesk; root: ShadowRoot }> {
    const el = document.createElement("inc-desk") as IncDesk;
    document.body.append(el);
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
    }
    return { el, root: el.shadowRoot as ShadowRoot };
  }

  it("renders bottleneck, spend, lessons learned, and releases", async () => {
    serveDesk();
    const { root } = await mount();

    expect(root.textContent).toContain("The bottleneck");
    expect(root.textContent).toContain("Tickets waited 1.5 h for tokens");
    expect(root.textContent).toContain("Spend");
    expect(root.textContent).toContain("$46");
    expect(root.textContent).toContain("What the team learned");
    expect(root.textContent).toContain("Saved memory in sessions");
    expect(root.textContent).toContain("Releases");
    expect(root.textContent).toContain("2 unreleased tickets");
    expect(root.textContent).toContain("v2026-10-17.1");
  });

  it("disables Cut release when a project has no pending tickets", async () => {
    serveDesk();
    const { root } = await mount();

    const projects = root.querySelectorAll(".release-project");
    expect(projects.length).toBe(2);

    // Duet has 2 pending tickets -> enabled
    const duetBtn = projects[0]?.querySelector("button.release-btn") as HTMLButtonElement;
    expect(duetBtn).toBeTruthy();
    expect(duetBtn.disabled).toBe(false);
    expect(duetBtn.textContent).toContain("Cut release");

    // i-inc has 0 pending tickets -> disabled with ghost class
    const iincBtn = projects[1]?.querySelector("button.release-btn") as HTMLButtonElement;
    expect(iincBtn).toBeTruthy();
    expect(iincBtn.disabled).toBe(true);
    expect(projects[1]?.textContent).toContain("Up to date");
  });

  it("handles cutting a release with in-flight loading state", async () => {
    let releaseStarted!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });

    serveDesk({
      onRelease: async () => {
        releaseStarted();
        await new Promise((r) => setTimeout(r, 20));
      },
    });

    const { el, root } = await mount();
    const duetBtn = root.querySelector(".release-project button.release-btn") as HTMLButtonElement;

    duetBtn.click();
    await releasePromise;
    await el.updateComplete;

    expect(el.cutting).toBe("Duet");
    expect(duetBtn.disabled).toBe(true);
    expect(duetBtn.textContent).toContain("Cutting…");
    expect(duetBtn.getAttribute("aria-busy")).toBe("true");

    // Wait for completion
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 10));
      await el.updateComplete;
    }

    expect(el.cutting).toBeNull();
    expect(calls).toContainEqual({
      method: "POST",
      url: "/api/projects/Duet/release",
      body: {},
    });
  });

  it("displays an inline accessible error alert when cutRelease fails", async () => {
    window.alert = vi.fn();
    const alertSpy = vi.spyOn(window, "alert");

    serveDesk({
      releaseStatus: 400,
      releaseError: "no unreleased merged tickets",
    });

    const { el, root } = await mount();
    const duetBtn = root.querySelector(".release-project button.release-btn") as HTMLButtonElement;

    duetBtn.click();
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await el.updateComplete;
    }

    expect(alertSpy).not.toHaveBeenCalled();
    const errBanner = root.querySelector(".releases .err[role=alert]");
    expect(errBanner).toBeTruthy();
    expect(errBanner?.textContent).toContain("Failed to cut release: no unreleased merged tickets");
    expect(el.actionError).toContain("no unreleased merged tickets");
  });

  it("clears the error banner on subsequent attempts", async () => {
    serveDesk({
      releaseStatus: 500,
      releaseError: "internal error",
    });

    const { el, root } = await mount();
    const duetBtn = root.querySelector(".release-project button.release-btn") as HTMLButtonElement;

    duetBtn.click();
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await el.updateComplete;
    }
    expect(root.querySelector(".releases .err")).toBeTruthy();

    // Now change to success
    serveDesk();
    duetBtn.click();
    await el.updateComplete;
    // As soon as clicked, actionError is reset
    expect(el.actionError).toBeNull();
  });

  it("ensures release-btn has min-height: 44px for touch targets", async () => {
    serveDesk();
    const { el } = await mount();
    const styles = (el.constructor as typeof IncDesk).styles;
    const allCss = Array.isArray(styles) ? styles.map((s) => s.cssText).join("\n") : "";

    expect(allCss).toContain(".release-btn { font-size: 13px; min-height: 44px;");
  });
});
