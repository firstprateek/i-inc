import { describe, expect, it } from "vitest";
import { IncLayout } from "../src/components/layout.ts";
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

describe("shared route headers", () => {
  it("lets Split headers span the sidebar and working-pane tracks", () => {
    const styles = IncLayout.styles.map((style) => style.cssText).join("\n");
    expect(styles).toMatch(/\.frame\.split\s+\.page-header\s*\{[^}]*max-width:\s*none;/);
    expect(styles).toMatch(/\.frame\.split\s+\.page-header\s*\{[^}]*margin-inline:\s*0;/);
    expect(styles).toMatch(/\.frame\.page\s*\{[^}]*max-width:\s*var\(--page-width,\s*840px\);/);
    expect(styles).toMatch(/\.frame\.wide\s*\{[^}]*max-width:\s*var\(--wide-width,\s*1400px\);/);
  });
});
