import { describe, expect, it } from "vitest";
import { IncLayout } from "../src/components/layout.ts";
import { base } from "../src/components/shared.ts";
import { IncLogin } from "../src/login.ts";

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
  });

  it("spans every template's header and tab row across one frame, and lets only the content follow its template", () => {
    const styles = IncLayout.styles.map((style) => style.cssText).join("\n");
    // one frame for Page, Wide and Split: the widest content
    expect(styles).toMatch(/\.frame\s*\{[^}]*max-width:\s*var\(--wide-width,\s*1400px\);/);
    expect(styles).not.toMatch(/\.frame\.page\s*\{[^}]*max-width:\s*var\(--page-width/);
    // the header (and with it the tab row) is as wide as the frame
    expect(styles).toMatch(/\.page-header\s*\{[^}]*max-width:\s*var\(--wide-width,\s*1400px\);/);
    expect(styles).not.toMatch(/\.page-header\s*\{[^}]*max-width:\s*var\(--page-width/);
    // Page content is the centred reading band inside that frame
    expect(styles).toMatch(
      /\.frame\.page\s+\.content\s*\{[^}]*max-width:\s*var\(--page-width,\s*840px\);[^}]*margin-inline:\s*auto;/,
    );
    // the heading block is never shorter than a 44px action, so the title does not move
    expect(styles).toMatch(/\.heading-copy\s*\{[^}]*min-height:\s*44px;/);
    // the compact login frame keeps its own narrow header
    expect(styles).toMatch(
      /\.frame\.page\.compact\s+\.page-header\s*\{[^}]*max-width:\s*var\(--compact-page-width/,
    );
  });
});

describe("standalone login frame spacing", () => {
  it("keeps a shared gutter and safe-area breathing room around its own scroller", () => {
    const styles = IncLogin.styles.map((style) => style.cssText).join("\n");
    expect(styles).toMatch(/:host\s*\{[^}]*height:\s*100dvh;[^}]*overflow-y:\s*auto;/);
    expect(styles).toContain("var(--layout-mobile-gutter, 16px)");
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(styles).toContain(`env(safe-area-inset-${edge})`);
    }
    expect(styles).toMatch(
      /padding:\s*max\(var\(--layout-mobile-gutter,\s*16px\),\s*env\(safe-area-inset-top\)\)/,
    );
  });
});
