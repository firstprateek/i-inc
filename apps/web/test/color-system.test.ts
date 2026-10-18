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
  it("computes deterministic project hue indices across strings, emojis, CJK, and empty names", () => {
    expect(projectIndex("")).toBe(0);
    const i1 = projectIndex("i-inc");
    const i2 = projectIndex("i-inc");
    expect(i1).toBe(i2);
    expect(projectIndex("🚀 rocket")).toBe(projectIndex("🚀 rocket"));
    expect(projectIndex("中文项目")).toBe(projectIndex("中文项目"));
    expect(projectIndex("a")).toBeGreaterThanOrEqual(0);
    expect(projectIndex("a")).toBeLessThan(6);

    const badge = projectBadge("i-inc");
    expect(badge.values).toContain(i1);
    expect(badge.values).toContain("i-inc");
    const fullHtml = badge.strings.join("");
    expect(fullHtml).toContain("proj-badge proj-");
    expect(fullHtml).toContain("proj-dot");
    expect(fullHtml).toContain("proj-name");
  });

  it("provides 7 distinct avatar tints with high contrast (≥7:1) in light and dark mode", () => {
    const cssPath = resolve(__dirname, "../src/tokens.css");
    const css = readFileSync(cssPath, "utf-8");
    const [_lightSection = "", darkSection = ""] = css.split(/data-theme="dark"/);

    expect(tints).toHaveLength(7);
    for (const [bg, fg] of tints) {
      const ratio = contrastRatio(bg, fg);
      expect(ratio).toBeGreaterThanOrEqual(7.0);
    }

    for (let i = 0; i < 7; i++) {
      const bgMatch = darkSection.match(new RegExp(`--avatar-${i}-bg:\\s*(#[0-9a-fA-F]{6})`));
      const fgMatch = darkSection.match(new RegExp(`--avatar-${i}-fg:\\s*(#[0-9a-fA-F]{6})`));
      expect(bgMatch).toBeTruthy();
      expect(fgMatch).toBeTruthy();
      if (bgMatch?.[1] && fgMatch?.[1]) {
        expect(contrastRatio(bgMatch[1], fgMatch[1])).toBeGreaterThanOrEqual(7.0);
      }
    }
  });

  it("tokens.css defines status chips, dark mode overrides, and semantic bars", () => {
    const cssPath = resolve(__dirname, "../src/tokens.css");
    const css = readFileSync(cssPath, "utf-8");

    // Must define chip tokens
    expect(css).toMatch(/--working-bg:\s*#[0-9a-fA-F]{6}/);
    expect(css).toMatch(/--working-fg:\s*#[0-9a-fA-F]{6}/);
    expect(css).toMatch(/--working-edge:\s*#[0-9a-fA-F]{6}/);
    expect(css).toMatch(/--reviewing-bg:\s*#[0-9a-fA-F]{6}/);
    expect(css).toMatch(/--reviewing-fg:\s*#[0-9a-fA-F]{6}/);
    expect(css).toMatch(/--reviewing-edge:\s*#[0-9a-fA-F]{6}/);
    expect(css).toMatch(/--needs-bg:\s*#[0-9a-fA-F]{6}/);
    expect(css).toMatch(/--needs-fg:\s*#[0-9a-fA-F]{6}/);
    expect(css).toMatch(/--needs-edge:\s*#[0-9a-fA-F]{6}/);

    // Semantic health bars
    expect(css).toContain("--bar-ok:");
    expect(css).toContain("--bar-warn:");
    expect(css).toContain("--bar-crit:");
    expect(css).toContain("--bar-spend:");
    expect(css).toContain("--bar-track:");
  });

  it("verifies project badge token contrast in light and dark mode exceeds 7:1", () => {
    const cssPath = resolve(__dirname, "../src/tokens.css");
    const css = readFileSync(cssPath, "utf-8");
    const [lightSection = "", darkSection = ""] = css.split(/data-theme="dark"/);

    for (let i = 0; i < 6; i++) {
      // Light
      const lBg = lightSection.match(new RegExp(`--proj-${i}-bg:\\s*(#[0-9a-fA-F]{6})`));
      const lFg = lightSection.match(new RegExp(`--proj-${i}-fg:\\s*(#[0-9a-fA-F]{6})`));
      const lDot = lightSection.match(new RegExp(`--proj-${i}-dot:\\s*(#[0-9a-fA-F]{6})`));
      expect(lBg).toBeTruthy();
      expect(lFg).toBeTruthy();
      if (lBg?.[1] && lFg?.[1]) {
        expect(contrastRatio(lBg[1], lFg[1])).toBeGreaterThanOrEqual(7.0);
      }
      if (lBg?.[1] && lDot?.[1]) {
        expect(contrastRatio(lBg[1], lDot[1])).toBeGreaterThanOrEqual(4.0);
      }

      // Dark
      const dBg = darkSection.match(new RegExp(`--proj-${i}-bg:\\s*(#[0-9a-fA-F]{6})`));
      const dFg = darkSection.match(new RegExp(`--proj-${i}-fg:\\s*(#[0-9a-fA-F]{6})`));
      const dDot = darkSection.match(new RegExp(`--proj-${i}-dot:\\s*(#[0-9a-fA-F]{6})`));
      expect(dBg).toBeTruthy();
      expect(dFg).toBeTruthy();
      if (dBg?.[1] && dFg?.[1]) {
        expect(contrastRatio(dBg[1], dFg[1])).toBeGreaterThanOrEqual(7.0);
      }
      if (dBg?.[1] && dDot?.[1]) {
        expect(contrastRatio(dBg[1], dDot[1])).toBeGreaterThanOrEqual(4.0);
      }
    }
  });

  it("verifies bar pairs contrast against track exceeds 3:1 in both light and dark mode", () => {
    const cssPath = resolve(__dirname, "../src/tokens.css");
    const css = readFileSync(cssPath, "utf-8");
    const [lightSection = "", darkSection = ""] = css.split(/data-theme="dark"/);

    const lWarn = lightSection.match(/--bar-warn:\s*(#[0-9a-fA-F]{6})/)?.[1];
    const lLine = lightSection.match(/--line:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(lWarn && lLine).toBeTruthy();
    if (lWarn && lLine) {
      expect(contrastRatio(lWarn, lLine)).toBeGreaterThanOrEqual(3.0);
    }

    const dCrit = darkSection.match(/--bar-crit:\s*(#[0-9a-fA-F]{6})/)?.[1];
    const dTrack = darkSection.match(/--bar-track:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(dCrit && dTrack).toBeTruthy();
    if (dCrit && dTrack) {
      expect(contrastRatio(dCrit, dTrack)).toBeGreaterThanOrEqual(3.0);
    }
  });

  it("board renders status column indicator dots and active card accent classes (including paused)", async () => {
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
        {
          id: "4",
          title: "Paused out of tokens",
          project: "i-inc",
          type: "chore",
          effort: "small",
          column: "in-progress",
          status: "paused",
          waiting: "coffee break",
          stages: [],
          live: "Paused",
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

    const pausedCard = el.shadowRoot?.querySelector('a.card.t[href="#/ticket/4"]');
    expect(pausedCard?.classList.contains("paused")).toBe(true);
    expect(pausedCard?.classList.contains("in-progress")).toBe(false);

    // Cards should render projectBadge
    const projBadges = el.shadowRoot?.querySelectorAll(".proj-badge");
    expect(projBadges?.length).toBeGreaterThanOrEqual(4);

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
