// Setup: where the owner manages teams, projects, engines and accounts, and checks the sandboxes.
import { css, html, LitElement } from "lit";
import { base } from "./shared.ts";
import "./setup-teams.ts";
import "./setup-projects.ts";
import "./setup-engines.ts";
import "./setup-sandboxes.ts";

export const sections = [
  ["teams", "Teams"],
  ["projects", "Projects"],
  ["engines", "Engines and accounts"],
  ["sandboxes", "Sandboxes"],
] as const;

export type Section = (typeof sections)[number][0];

export const isSection = (s: string | undefined): s is Section => sections.some(([id]) => id === s);

export class IncSetup extends LitElement {
  static override properties = { section: { type: String } };
  declare section: Section;

  constructor() {
    super();
    this.section = "teams";
  }

  static override styles = [
    base,
    css`
      h1 { font-size: 30px; margin: 4px 0 14px; }
      nav { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 18px; }
      nav a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; border-radius: 999px; box-sizing: border-box;
        border: 1px solid var(--line-strong); font-weight: 600; font-size: 15px; text-decoration: none; }
      nav a[aria-current="page"] { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
    `,
  ];

  override render() {
    return html`<h1>Setup</h1>
      <nav aria-label="Setup sections">
        ${sections.map(
          ([id, name]) =>
            html`<a href="#/setup/${id}" aria-current=${this.section === id ? "page" : "false"}>${name}</a>`,
        )}
      </nav>
      ${this.body()}`;
  }

  private body() {
    switch (this.section) {
      case "teams":
        return html`<inc-setup-teams></inc-setup-teams>`;
      case "projects":
        return html`<inc-setup-projects></inc-setup-projects>`;
      case "engines":
        return html`<inc-setup-engines></inc-setup-engines>`;
      case "sandboxes":
        return html`<inc-setup-sandboxes></inc-setup-sandboxes>`;
    }
  }
}

customElements.define("inc-setup", IncSetup);
