// Times in the owner's own zone, in plain words (T64): "2:14 AM", never "UTC" and never 24-hour clock arithmetic.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atTime, dayLabel, friendlyWhen, hourLabel, withResume } from "../src/time.ts";

// Local (the test machine's own zone), so the assertions hold in any zone.
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = at(2026, 10, 22, 12);

describe("friendlyWhen", () => {
  it("is just the time of day when it is today", () => {
    expect(friendlyWhen(at(2026, 10, 22, 2, 14), NOW)).toMatch(/^2:14\s?AM$/i);
    expect(friendlyWhen(at(2026, 10, 22, 23, 5), NOW)).toMatch(/^11:05\s?PM$/i);
  });

  it("says Tomorrow and Yesterday, and gives the date for anything else", () => {
    expect(friendlyWhen(at(2026, 10, 23, 2, 14), NOW)).toMatch(/^Tomorrow 2:14\s?AM$/i);
    expect(friendlyWhen(at(2026, 10, 21, 21, 5), NOW)).toMatch(/^Yesterday 9:05\s?PM$/i);
    expect(friendlyWhen(at(2026, 10, 30, 9, 0), NOW)).toMatch(/^Oct 30, 9:00\s?AM$/i);
  });

  it("never says UTC or GMT, and has no 24-hour hh:mm", () => {
    for (const ms of [at(2026, 10, 22, 14, 7), at(2026, 10, 25, 3, 30), at(2026, 1, 1, 0, 0)])
      expect(friendlyWhen(ms, NOW)).not.toMatch(/UTC|GMT|\b1[3-9]:|\b2[0-3]:/);
  });
});

describe("atTime", () => {
  it("reads right after at or until: the time alone today, its own 'at' on another day", () => {
    expect(atTime(at(2026, 10, 22, 2, 14), NOW)).toMatch(/^2:14\s?AM$/i);
    expect(atTime(at(2026, 10, 23, 2, 14), NOW)).toMatch(/^tomorrow at 2:14\s?AM$/i);
    expect(atTime(at(2026, 10, 21, 21, 5), NOW)).toMatch(/^yesterday at 9:05\s?PM$/i);
    expect(atTime(at(2026, 10, 30, 9, 0), NOW)).toMatch(/^Oct 30 at 9:00\s?AM$/i);
  });
});

describe("withResume", () => {
  it('turns "Waiting for tokens" into "Waiting for tokens until 2:14 AM"', () => {
    expect(withResume("Waiting for tokens", at(2026, 10, 22, 14, 14), NOW)).toMatch(
      /^Waiting for tokens until 2:14\s?PM$/i,
    );
    expect(withResume("Waiting for tokens", at(2026, 10, 23, 2, 14), NOW)).toMatch(
      /until tomorrow at 2:14\s?AM$/i,
    );
  });
  it("leaves a line with no resume time alone", () => {
    expect(withResume("Build", undefined, NOW)).toBe("Build");
    expect(withResume("Checks green", null, NOW)).toBe("Checks green");
  });
});

describe("hourLabel and dayLabel", () => {
  it("words a working-hours hour", () => {
    expect(hourLabel(22)).toMatch(/^10\s?PM$/i);
    expect(hourLabel(7)).toMatch(/^7\s?AM$/i);
  });
  it("words a date, with the year only when it is not this year", () => {
    expect(dayLabel(at(2026, 10, 22, 9), NOW)).toBe("Oct 22");
    expect(dayLabel(at(2025, 3, 4, 9), NOW)).toBe("Mar 4, 2025");
  });
});

describe("the app's words", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );

  it("has no whimsical status and no UTC clock left in the web app", () => {
    for (const f of files(join(import.meta.dirname, "../src"))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/coffee break/i);
      // times are formatted by time.ts in the owner's zone, never cut from an ISO (UTC) string
      expect(text, f).not.toMatch(/toISOString\(\)\.slice/);
      expect(text, f).not.toMatch(/toTimeString\(\)/);
      expect(text, f).not.toMatch(/hourCycle: "h23"/);
    }
  });
});
