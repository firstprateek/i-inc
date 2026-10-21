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

  const deploysData = [
    {
      at: 1792300000000,
      sha: "a".repeat(40),
      from: "b".repeat(40),
      outcome: "deployed",
      reason: "",
      durationMs: 95_000,
    },
    {
      at: 1792290000000,
      sha: "c".repeat(40),
      from: "b".repeat(40),
      outcome: "rolled-back",
      reason: "the new daemon did not report version ccccccc on /api/health within 90 s",
      durationMs: 130_000,
    },
  ];

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
    onRelease?: (url: string) => Promise<void>;
    // Give i-inc a pending ticket too, so both projects can be cut.
    bothPending?: boolean;
    // Fail only for this project's release (the others succeed).
    failFor?: string;
    // An older daemon: no /api/deploys.
    noDeploys?: boolean;
  }) {
    const data = overrides?.bothPending
      ? {
          ...deskData,
          pendingReleases: deskData.pendingReleases.map((p) =>
            p.id === "i-inc"
              ? { ...p, pendingTickets: [{ id: "5", title: "Tidy", pushed: "sha5555555" }] }
              : p,
          ),
        }
      : deskData;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      if (url === "/api/desk") {
        return new Response(JSON.stringify(data), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/deploys") {
        if (overrides?.noDeploys)
          return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        return new Response(JSON.stringify({ deploys: deploysData }), {
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
          await overrides.onRelease(url);
        }
        const failing = overrides?.failFor ? url.includes(`/${overrides.failFor}/`) : true;
        if (failing && overrides?.releaseStatus && overrides.releaseStatus >= 400) {
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

  it("lists the deployer's recent deploys next to the releases, failures marked", async () => {
    serveDesk();
    const { root } = await mount();
    const rows = root.querySelectorAll(".deploy");
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain("Deployed");
    expect(rows[0]?.textContent).toContain("aaaaaaa");
    expect(rows[0]?.classList.contains("bad")).toBe(false);
    expect(rows[1]?.textContent).toContain("Rolled back");
    expect(rows[1]?.textContent).toContain("ccccccc");
    expect(rows[1]?.textContent).toContain("did not report version");
    expect(rows[1]?.classList.contains("bad")).toBe(true);
  });

  it("shows no deploy list, and still renders the desk, when the daemon is older", async () => {
    serveDesk({ noDeploys: true });
    const { root } = await mount();
    expect(root.querySelectorAll(".deploy").length).toBe(0);
    expect(root.textContent).toContain("No deploys yet");
    expect(root.textContent).toContain("Recent releases");
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

    expect(el.cutting.has("Duet")).toBe(true);
    expect(duetBtn.disabled).toBe(true);
    expect(duetBtn.textContent).toContain("Cutting…");
    expect(duetBtn.getAttribute("aria-busy")).toBe("true");

    // Wait for completion
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 10));
      await el.updateComplete;
    }

    expect(el.cutting.size).toBe(0);
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

  const settle = async (el: IncDesk) => {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await el.updateComplete;
    }
  };
  const posts = () => calls.filter((c) => c.method === "POST");
  const buttons = (root: ShadowRoot) => [
    ...root.querySelectorAll<HTMLButtonElement>(".release-project button.release-btn"),
  ];

  it("sends one POST when a project's Cut release is double-tapped", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    serveDesk({ onRelease: () => gate });
    const { el, root } = await mount();
    const [duet] = buttons(root);

    // Two clicks in the same task, before Lit can re-render the button as disabled.
    duet?.click();
    duet?.click();
    finish();
    await settle(el);

    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.url).toBe("/api/projects/Duet/release");
  });

  it("keeps both busy states when two projects are cut at once", async () => {
    const gates: Record<string, () => void> = {};
    serveDesk({
      bothPending: true,
      onRelease: (url) =>
        new Promise<void>((r) => {
          gates[url.split("/")[3] as string] = r;
        }),
    });
    const { el, root } = await mount();
    const [duet, iinc] = buttons(root);

    duet?.click();
    await el.updateComplete;
    iinc?.click();
    await el.updateComplete;

    for (const b of [duet, iinc]) {
      expect(b?.disabled).toBe(true);
      expect(b?.getAttribute("aria-busy")).toBe("true");
      expect(b?.textContent).toContain("Cutting…");
    }
    expect(posts().map((c) => c.url)).toEqual(["/api/projects/Duet/release", "/api/projects/i-inc/release"]);

    // Finishing the first leaves the second busy.
    gates.Duet?.();
    await settle(el);
    expect(duet?.getAttribute("aria-busy")).toBe("false");
    expect(duet?.textContent).toContain("Cut release");
    expect(iinc?.getAttribute("aria-busy")).toBe("true");
    expect(iinc?.disabled).toBe(true);

    gates["i-inc"]?.();
    await settle(el);
    expect(iinc?.getAttribute("aria-busy")).toBe("false");
    expect(el.cutting.size).toBe(0);
  });

  it("cuts a release on success: one POST, no error, button usable again", async () => {
    serveDesk();
    const { el, root } = await mount();
    const [duet] = buttons(root);

    duet?.click();
    await settle(el);

    expect(posts()).toEqual([{ method: "POST", url: "/api/projects/Duet/release", body: {} }]);
    expect(root.querySelector(".err")).toBeNull();
    expect(duet?.disabled).toBe(false);
    expect(duet?.getAttribute("aria-busy")).toBe("false");
  });

  it("clears the busy state after a failure, and the project can be retried", async () => {
    serveDesk({ releaseStatus: 500, releaseError: "boom" });
    const { el, root } = await mount();
    const [duet] = buttons(root);

    duet?.click();
    await settle(el);
    expect(duet?.disabled).toBe(false);
    expect(duet?.getAttribute("aria-busy")).toBe("false");
    expect(duet?.textContent).toContain("Cut release");
    expect(root.querySelector(".err")?.textContent).toContain("boom");

    duet?.click();
    await settle(el);
    expect(posts()).toHaveLength(2);
  });

  it("a failure on one project leaves the other's busy state alone", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    serveDesk({
      bothPending: true,
      releaseStatus: 500,
      releaseError: "nope",
      failFor: "Duet",
      onRelease: (url) => (url.includes("/i-inc/") ? gate : Promise.resolve()),
    });
    const { el, root } = await mount();
    const [duet, iinc] = buttons(root);

    iinc?.click();
    duet?.click();
    await settle(el);

    expect(duet?.getAttribute("aria-busy")).toBe("false");
    expect(iinc?.getAttribute("aria-busy")).toBe("true");
    finish();
    await settle(el);
    expect(iinc?.getAttribute("aria-busy")).toBe("false");
  });

  it("dismisses the error banner with a labelled 44px button", async () => {
    serveDesk({ releaseStatus: 500, releaseError: "boom" });
    const { el, root } = await mount();
    buttons(root)[0]?.click();
    await settle(el);

    const banner = root.querySelector(".releases .err[role=alert]");
    expect(banner).toBeTruthy();
    const dismiss = banner?.querySelector<HTMLButtonElement>("button");
    expect(dismiss?.getAttribute("aria-label")).toBe("Dismiss");
    expect(dismiss?.type).toBe("button");

    dismiss?.click();
    await el.updateComplete;
    expect(root.querySelector(".err")).toBeNull();
    expect(el.actionError).toBeNull();
  });
});
