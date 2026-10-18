import { describe, expect, it } from "vitest";
import { base } from "../src/components/shared.ts";

describe("shared selected-control styles", () => {
  it("lets helper copy inherit the foreground of selected toggles", () => {
    // Selected controls set a foreground that contrasts with their active background. Keep helper
    // copy in that same foreground instead of letting the generic .muted color override it.
    expect(base.cssText).toContain('[aria-pressed="true"] .muted');
    expect(base.cssText).toContain('[aria-checked="true"] .muted');
    expect(base.cssText).toMatch(
      /\[aria-(?:pressed|checked)="true"\] \.muted[^{}]*\{\s*color:\s*inherit\s*;/,
    );
  });
});
