// Company → Settings: where the owner manages teams, engines and accounts, notifications, and checks the sandboxes.
// (Projects have their own tab.)
import { css, html, LitElement } from "lit";
import { type Section, sections } from "../routes.ts";
import { LAYOUT_BREAKPOINTS, layoutStyles } from "./layout.ts";
import { base } from "./shared.ts";
import "./setup-teams.ts";
import "./setup-engines.ts";
import "./setup-sandboxes.ts";
import "./setup-notifications.ts";

export { isSection, type Section, sections } from "../routes.ts";

export class IncSetup extends LitElement {
  static override properties = { section: { type: String } };
  declare section: Section;

  constructor() {
    super();
    this.section = "teams";
  }

  static override styles = [
    base,
    layoutStyles,
    css`
      :host { display: block; height: 100%; min-height: 0; }
      .sections-nav { padding: 10px; display: flex; flex-direction: column; gap: 6px; border-right: 1px solid var(--line); }
      .sections-nav a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; border-radius: 999px; box-sizing: border-box;
        border: 1px solid var(--line-strong); font-weight: 600; font-size: 15px; text-decoration: none; }
      .sections-nav a[aria-current="page"] { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
      .sections-nav a:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .work { min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 2px 20px; scrollbar-gutter: stable; }
      @media (max-width: ${LAYOUT_BREAKPOINTS.split - 1}px) {
        .sections-nav { flex-direction: row; overflow-x: auto; overflow-y: hidden; border-right: 0; border-bottom: 1px solid var(--line); padding: 4px 0 8px; scrollbar-width: none; }
        .sections-nav::-webkit-scrollbar { display: none; }
        .sections-nav a { flex: none; white-space: nowrap; }
        .work { padding: 0 0 12px; }
      }
    `,
  ];

  override render() {
    return html`<div class="layout-split">
      <nav class="sections-nav layout-split-sidebar" aria-label="Settings sections">
        ${sections.map(([id, name]) => html`<a href="#/company/settings/${id}" aria-current=${this.section === id ? "page" : "false"}>${name}</a>`)}
      </nav>
      <div class="work layout-split-work" aria-label="Settings section">
        ${this.body()}
      </div>
    </div>`;
  }

  private body() {
    switch (this.section) {
      case "teams":
        return html`<inc-setup-teams></inc-setup-teams>`;
      case "engines":
        return html`<inc-setup-engines></inc-setup-engines>`;
      case "sandboxes":
        return html`<inc-setup-sandboxes></inc-setup-sandboxes>`;
      case "notifications":
        return html`<inc-setup-notifications></inc-setup-notifications>`;
    }
  }
}

customElements.define("inc-setup", IncSetup);
