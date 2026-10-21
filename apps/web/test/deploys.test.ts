import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/deploys.ts";
import type { IncDeploys } from "../src/components/deploys.ts";

const deploys = [
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

async function mount(status = 200, body: unknown = { deploys }) {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  const el = document.createElement("inc-deploys") as IncDeploys;
  document.body.append(el);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
  return el.shadowRoot as ShadowRoot;
}

describe("<inc-deploys>", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("lists the recent deploys, failures marked", async () => {
    const root = await mount();
    const rows = root.querySelectorAll(".deploy");
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain("Deployed");
    expect(rows[0]?.textContent).toContain("aaaaaaa");
    expect(rows[0]?.classList.contains("bad")).toBe(false);
    expect(rows[1]?.textContent).toContain("Rolled back");
    expect(rows[1]?.textContent).toContain("did not report version");
    expect(rows[1]?.classList.contains("bad")).toBe(true);
  });

  it("words the three kinds of rollback so each sha is unambiguous", async () => {
    const A = "a".repeat(40);
    const B = "b".repeat(40);
    const C = "c".repeat(40);
    const root = await mount(200, {
      deploys: [
        // By hand, written by this version: sha = now running, from = the one left.
        {
          at: 3,
          sha: A,
          from: B,
          outcome: "rolled-back",
          reason: "rolled back by hand to aaaaaaa",
          durationMs: 5000,
        },
        // Automatic: sha = the rejected commit, from = the release kept.
        {
          at: 2,
          sha: C,
          from: A,
          outcome: "rolled-back",
          reason: "the new daemon did not report version ccccccc",
          durationMs: 90_000,
        },
        // Written before the change: from = sha.
        {
          at: 1,
          sha: B,
          from: B,
          outcome: "rolled-back",
          reason: "rolled back by hand to aaaaaaa",
          durationMs: 5000,
        },
      ],
    });
    const rows = [...root.querySelectorAll(".deploy")];
    const text = (i: number) => (rows[i]?.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(text(0)).toContain("Rolled back by hand bbbbbbb → aaaaaaa");
    expect(text(0)).not.toContain("rolled back by hand to");
    expect(text(1)).toContain("Rolled back ccccccc → kept aaaaaaa");
    expect(text(1)).toContain("did not report version");
    expect(text(2)).toContain("Rolled back bbbbbbb");
    expect(text(2)).not.toContain("→");
    expect(text(2)).toContain("rolled back by hand to aaaaaaa");
  });

  it("shows an empty note, not an error, when the daemon is older", async () => {
    const root = await mount(404, { error: "not found" });
    expect(root.querySelectorAll(".deploy").length).toBe(0);
    expect(root.textContent).toContain("No deploys yet");
  });
});
