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

function contrastRatio(hex1?: string, hex2?: string): number {
  if (!hex1 || !hex2) return 1;
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseTokens(cssBlock: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const line of cssBlock.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--") && trimmed.includes(":")) {
      const colonIdx = trimmed.indexOf(":");
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed
        .slice(colonIdx + 1)
        .replace(";", "")
        .trim();
      tokens[key] = val;
    }
  }
  return tokens;
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

  it("computes deterministic project hue indices regardless of array order or list position", () => {
    const listA = ["alpha", "beta", "gamma", "delta", "i-inc", "duet"];
    const listB = ["duet", "delta", "alpha", "i-inc", "gamma", "beta"];

    const badgesA = listA.map((p) => ({ p, idx: projectIndex(p), badge: projectBadge(p) }));
    const badgesB = listB.map((p) => ({ p, idx: projectIndex(p), badge: projectBadge(p) }));

    for (const itemA of badgesA) {
      const itemB = badgesB.find((b) => b.p === itemA.p);
      expect(itemB).toBeDefined();
      expect(itemA.idx).toBe(itemB?.idx);
      expect(itemA.badge.values).toEqual(itemB?.badge.values);
    }
  });

  it("provides 7 distinct avatar tints with high contrast (≥7:1) in light and dark mode", () => {
    const cssPath = resolve(__dirname, "../src/tokens.css");
    const css = readFileSync(cssPath, "utf-8");
    const [_lightSection = "", darkSection = ""] = css.split(/data-theme="dark"/);
    const darkTokens = parseTokens(darkSection);

    expect(tints).toHaveLength(7);
    for (const [bg, fg] of tints) {
      const ratio = contrastRatio(bg, fg);
      expect(ratio).toBeGreaterThanOrEqual(7.0);
    }

    for (let i = 0; i < 7; i++) {
      const bg = darkTokens[`--avatar-${i}-bg`];
      const fg = darkTokens[`--avatar-${i}-fg`];
      expect(bg).toBeDefined();
      expect(fg).toBeDefined();
      if (bg && fg) {
        expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(7.0);
      }
    }
  });

  it("synchronizes prefers-color-scheme: dark tokens with [data-theme='dark'] tokens", () => {
    const cssPath = resolve(__dirname, "../src/tokens.css");
    const css = readFileSync(cssPath, "utf-8");

    const mediaMatch = css.match(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\}\s*\}/,
    );
    const dataThemeMatch = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/);

    expect(mediaMatch).toBeTruthy();
    expect(dataThemeMatch).toBeTruthy();

    const mediaTokens = parseTokens(mediaMatch?.[1] ?? "");
    const dataThemeTokens = parseTokens(dataThemeMatch?.[1] ?? "");

    // Every token defined in [data-theme="dark"] must be present and identical in prefers-color-scheme
    for (const [key, val] of Object.entries(dataThemeTokens)) {
      expect(mediaTokens[key]).toBe(val);
    }
  });

  it("tokens.css defines status chips, dark mode overrides, and semantic bars with adequate contrast", () => {
    const cssPath = resolve(__dirname, "../src/tokens.css");
    const css = readFileSync(cssPath, "utf-8");
    const [lightSection = "", darkSection = ""] = css.split(/data-theme="dark"/);
    const lightTokens = parseTokens(lightSection);
    const darkTokens = parseTokens(darkSection);

    // Chip foreground vs background contrast ≥ 4.5:1
    expect(contrastRatio(lightTokens["--working-bg"], lightTokens["--working-fg"])).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      contrastRatio(lightTokens["--reviewing-bg"], lightTokens["--reviewing-fg"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(lightTokens["--needs-bg"], lightTokens["--needs-fg"])).toBeGreaterThanOrEqual(4.5);

    expect(contrastRatio(darkTokens["--working-bg"], darkTokens["--working-fg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkTokens["--reviewing-bg"], darkTokens["--reviewing-fg"])).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(darkTokens["--needs-bg"], darkTokens["--needs-fg"])).toBeGreaterThanOrEqual(4.5);

    // Semantic health bars defined
    expect(lightTokens["--bar-ok"]).toBeDefined();
    expect(lightTokens["--bar-warn"]).toBeDefined();
    expect(lightTokens["--bar-crit"]).toBeDefined();
    expect(lightTokens["--bar-spend"]).toBeDefined();
    expect(lightTokens["--bar-track"]).toBeDefined();

    expect(darkTokens["--bar-ok"]).toBeDefined();
    expect(darkTokens["--bar-warn"]).toBeDefined();
    expect(darkTokens["--bar-crit"]).toBeDefined();
    expect(darkTokens["--bar-spend"]).toBeDefined();
    expect(darkTokens["--bar-track"]).toBeDefined();
  });

  it("verifies project badge token contrast in light and dark mode exceeds 7:1", () => {
    const cssPath = resolve(__dirname, "../src/tokens.css");
    const css = readFileSync(cssPath, "utf-8");
    const [lightSection = "", darkSection = ""] = css.split(/data-theme="dark"/);
    const lightTokens = parseTokens(lightSection);
    const darkTokens = parseTokens(darkSection);

    for (let i = 0; i < 6; i++) {
      // Light
      const lBg = lightTokens[`--proj-${i}-bg`];
      const lFg = lightTokens[`--proj-${i}-fg`];
      const lDot = lightTokens[`--proj-${i}-dot`];
      expect(lBg).toBeDefined();
      expect(lFg).toBeDefined();
      expect(lDot).toBeDefined();
      if (lBg && lFg) {
        expect(contrastRatio(lBg, lFg)).toBeGreaterThanOrEqual(7.0);
      }
      if (lBg && lDot) {
        expect(contrastRatio(lBg, lDot)).toBeGreaterThanOrEqual(4.0);
      }

      // Dark
      const dBg = darkTokens[`--proj-${i}-bg`];
      const dFg = darkTokens[`--proj-${i}-fg`];
      const dDot = darkTokens[`--proj-${i}-dot`];
      expect(dBg).toBeDefined();
      expect(dFg).toBeDefined();
      expect(dDot).toBeDefined();
      if (dBg && dFg) {
        expect(contrastRatio(dBg, dFg)).toBeGreaterThanOrEqual(7.0);
      }
      if (dBg && dDot) {
        expect(contrastRatio(dBg, dDot)).toBeGreaterThanOrEqual(4.0);
      }
    }
  });

  it("verifies bar pairs contrast against track/line/surface exceeds 3:1 in both light and dark mode", () => {
    const cssPath = resolve(__dirname, "../src/tokens.css");
    const css = readFileSync(cssPath, "utf-8");
    const [lightSection = "", darkSection = ""] = css.split(/data-theme="dark"/);
    const lightTokens = parseTokens(lightSection);
    const darkTokens = parseTokens(darkSection);

    // Light mode bar contrast
    expect(contrastRatio(lightTokens["--bar-ok"], lightTokens["--line"])).toBeGreaterThanOrEqual(3.0);
    expect(contrastRatio(lightTokens["--bar-warn"], lightTokens["--line"])).toBeGreaterThanOrEqual(3.0);
    expect(contrastRatio(lightTokens["--bar-crit"], lightTokens["--line"])).toBeGreaterThanOrEqual(3.0);
    expect(contrastRatio(lightTokens["--bar-spend"], lightTokens["--surface"])).toBeGreaterThanOrEqual(3.0);

    // Dark mode bar contrast
    expect(contrastRatio(darkTokens["--bar-ok"], darkTokens["--bar-track"])).toBeGreaterThanOrEqual(3.0);
    expect(contrastRatio(darkTokens["--bar-warn"], darkTokens["--bar-track"])).toBeGreaterThanOrEqual(3.0);
    expect(contrastRatio(darkTokens["--bar-crit"], darkTokens["--bar-track"])).toBeGreaterThanOrEqual(3.0);
    expect(contrastRatio(darkTokens["--bar-spend"], darkTokens["--surface"])).toBeGreaterThanOrEqual(3.0);
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
