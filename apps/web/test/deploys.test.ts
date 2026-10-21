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

  it("shows an empty note, not an error, when the daemon is older", async () => {
    const root = await mount(404, { error: "not found" });
    expect(root.querySelectorAll(".deploy").length).toBe(0);
    expect(root.textContent).toContain("No deploys yet");
  });
});
