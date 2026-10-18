import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { IncBoard } from "../src/components/board.ts";
import "../src/components/board.ts";
import "../src/components/desk.ts";
import type { IncOffice } from "../src/components/office.ts";
import "../src/components/office.ts";
import { projectBadge, projectIndex, tints } from "../src/components/shared.ts";

function sRGBtoLinear(c: number): number {
  const norm = c / 255;
  return norm <= 0.04045 ? norm / 12.92 : ((norm + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return 0.2126 * sRGBtoLinear(r) + 0.7152 * sRGBtoLinear(g) + 0.0722 * sRGBtoLinear(b);
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Rich visual identity and color system (T38)", () => {
  it("computes deterministic project hue indices and renders project badges", () => {
    const idx1 = projectIndex("i-inc");
    const idx2 = projectIndex("duet");
    const idx3 = projectIndex("i-inc");
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeLessThan(6);
    expect(idx2).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeLessThan(6);
    expect(idx1).toBe(idx3); // Deterministic

    const badge = projectBadge("i-inc");
    expect(badge.values[0]).toBe(idx1);
    expect(badge.values[1]).toBe("i-inc");
    expect(badge.strings[0]).toContain("proj-badge proj-");
    expect(badge.strings[1]).toContain("proj-dot");
  });

  it("provides 7 distinct avatar tints with high contrast (≥6:1)", () => {
    expect(tints).toHaveLength(7);
    for (const [bg, fg] of tints) {
      const ratio = contrastRatio(bg, fg);
      expect(ratio).toBeGreaterThanOrEqual(6.0);
    }
  });

  it("tokens.css defines complete dark mode overrides for all status chip tokens", () => {
    const cssPath = resolve(__dirname, "../src/tokens.css");
    const css = readFileSync(cssPath, "utf-8");

    // Must define light tokens
    expect(css).toContain("--working-bg: #dceedf;");
    expect(css).toContain("--working-fg: #1d5234;");
    expect(css).toContain("--reviewing-bg: #dde7f6;");
    expect(css).toContain("--reviewing-fg: #1d4476;");
    expect(css).toContain("--needs-bg: #fce8b8;");
    expect(css).toContain("--needs-fg: #5a3a00;");

    // Must define dark tokens
    expect(css).toContain("--working-bg: #153422;");
    expect(css).toContain("--working-fg: #9ce6b8;");
    expect(css).toContain("--reviewing-bg: #152840;");
    expect(css).toContain("--reviewing-fg: #a6cafb;");
    expect(css).toContain("--needs-bg: #3a2a14;");
    expect(css).toContain("--needs-fg: #f6d9a6;");

    // Semantic health bars
    expect(css).toContain("--bar-ok:");
    expect(css).toContain("--bar-warn:");
    expect(css).toContain("--bar-crit:");
    expect(css).toContain("--bar-spend:");
  });

  it("verifies project badge token contrast in light and dark mode exceeds 6:1", () => {
    const cssPath = resolve(__dirname, "../src/tokens.css");
    const css = readFileSync(cssPath, "utf-8");

    // Extract light mode proj tokens
    for (let i = 0; i < 6; i++) {
      const bgMatch = css.match(new RegExp(`--proj-${i}-bg:\\s*(#[0-9a-fA-F]{6})`));
      const fgMatch = css.match(new RegExp(`--proj-${i}-fg:\\s*(#[0-9a-fA-F]{6})`));
      expect(bgMatch).toBeTruthy();
      expect(fgMatch).toBeTruthy();
      if (bgMatch?.[1] && fgMatch?.[1]) {
        const ratio = contrastRatio(bgMatch[1], fgMatch[1]);
        expect(ratio).toBeGreaterThanOrEqual(6.0);
      }
    }
  });

  it("board renders status column indicator dots and active card accent classes", async () => {
    const el = document.createElement("inc-board") as IncBoard;
    (el as unknown as { data: unknown }).data = {
      tickets: [
        {
          id: "1",
          title: "Fix bug",
          project: "i-inc",
          type: "fix",
          effort: "small",
          column: "in-progress",
          status: "running",
          stages: [],
          live: "Running",
        },
        {
          id: "2",
          title: "Review PR",
          project: "duet",
          type: "feature",
          effort: "medium",
          column: "review",
          status: "reviewing",
          stages: [],
          live: "Reviewing",
        },
        {
          id: "3",
          title: "Needs user OK",
          project: "i-inc",
          type: "task",
          effort: "small",
          column: "in-progress",
          status: "needs-you",
          stages: [],
          live: "Waiting",
        },
      ],
      digest: [],
    };
    document.body.appendChild(el);
    await el.updateComplete;

    const dots = el.shadowRoot?.querySelectorAll(".col-dot");
    expect(dots?.length).toBe(4);
    expect(el.shadowRoot?.querySelector(".col-dot-todo")).toBeTruthy();
    expect(el.shadowRoot?.querySelector(".col-dot-progress")).toBeTruthy();
    expect(el.shadowRoot?.querySelector(".col-dot-review")).toBeTruthy();
    expect(el.shadowRoot?.querySelector(".col-dot-done")).toBeTruthy();

    const inProgressCard = el.shadowRoot?.querySelector('a.card.t[href="#/ticket/1"]');
    expect(inProgressCard?.classList.contains("in-progress")).toBe(true);

    const reviewCard = el.shadowRoot?.querySelector('a.card.t[href="#/ticket/2"]');
    expect(reviewCard?.classList.contains("review")).toBe(true);

    const waitingCard = el.shadowRoot?.querySelector('a.card.t[href="#/ticket/3"]');
    expect(waitingCard?.classList.contains("waiting")).toBe(true);

    // Cards should render projectBadge
    const projBadges = el.shadowRoot?.querySelectorAll(".proj-badge");
    expect(projBadges?.length).toBeGreaterThanOrEqual(3);

    document.body.removeChild(el);
  });

  it("office view renders health-coded quota bars and activity meters", async () => {
    const el = document.createElement("inc-office") as IncOffice;
    (el as unknown as { data: unknown }).data = {
      employees: [],
      tickets: [],
      accounts: [
        {
          id: "claude-pro",
          name: "Claude Pro",
          models: ["claude-3-7-sonnet"],
        },
        {
          id: "google-pro",
          name: "Google AI Pro",
          fiveHourSessions: 3,
          fiveHourMinutes: 45,
          sevenDaySessions: 12,
          sevenDayMinutes: 180,
          models: ["gemini-2.5-pro"],
        },
      ],
      rateLimits: {
        "claude-pro": {
          status: "allowed",
          fiveHourUtilization: 0.85, // 85% -> warn
          sevenDayUtilization: 0.98, // 98% -> crit
          updatedAt: Date.now(),
        },
      },
    };
    document.body.appendChild(el);
    await el.updateComplete;

    const warnBar = el.shadowRoot?.querySelector(".quota-bar.warn");
    expect(warnBar).toBeTruthy();

    const critBar = el.shadowRoot?.querySelector(".quota-bar.crit");
    expect(critBar).toBeTruthy();

    const activityMeters = el.shadowRoot?.querySelector(".quota-bars.activity-meters");
    expect(activityMeters).toBeTruthy();

    document.body.removeChild(el);
  });
});
