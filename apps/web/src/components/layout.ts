import { css, html, LitElement } from "lit";

export type LayoutKind = "page" | "wide" | "split";

/** Layout cutoffs shared by route selection and the CSS templates below. */
export const LAYOUT_BREAKPOINTS = { phone: 900, split: 1100 } as const;

/** Reusable layout pieces for content inside a Lit component's own shadow root. */
export const layoutStyles = css`
  .layout-page-band {
    width: 100%;
    max-width: var(--page-width, 840px);
    margin-inline: auto;
    box-sizing: border-box;
  }
  .layout-wide-content {
    width: 100%;
    max-width: var(--wide-width, 1400px);
    margin-inline: auto;
    box-sizing: border-box;
  }
  .layout-split {
    display: grid;
    grid-template-columns: minmax(280px, var(--split-sidebar, 300px)) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    gap: var(--layout-gap, 24px);
    height: 100%;
    width: 100%;
    box-sizing: border-box;
    min-width: 0;
    min-height: 0;
  }
  .layout-split-sidebar,
  .layout-split-work {
    min-width: 0;
    min-height: 0;
    overscroll-behavior: contain;
  }
  .layout-split-sidebar { overflow-y: auto; }
  .layout-split-work { overflow: auto; }
  .layout-stack { display: flex; flex-direction: column; gap: var(--layout-section-gap, 20px); min-width: 0; }
  .page-header {
    width: 100%;
    max-width: var(--page-width, 840px);
    margin: 0 auto var(--layout-section-gap, 20px);
    padding: 0 0 var(--layout-header-gap, 12px);
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    box-sizing: border-box;
  }
  .heading-copy { min-width: 0; }
  .page-header h1 { margin: 0; font: 700 30px/1.15 var(--display); letter-spacing: -0.5px; overflow-wrap: anywhere; }
  .page-header .subtitle { margin: 6px 0 0; color: var(--ink-2); font-size: 15px; line-height: 1.4; }
  .page-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex: 0 0 auto; }

  @media (max-width: ${LAYOUT_BREAKPOINTS.split - 1}px) {
    .layout-split { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); gap: 0; }
    .layout-split-sidebar { overflow-x: auto; overflow-y: hidden; }
  }
`;

/**
 * The route frame. Its visible heading, Page/Wide/Split frame, and slot sizing are shared by every
 * route. Inner route components opt into `layoutStyles` for their own shadow-root structure.
 */
export class IncLayout extends LitElement {
  static override properties = {
    kind: { type: String, reflect: true },
    compact: { type: Boolean, reflect: true },
  };
  declare kind: LayoutKind;
  declare compact: boolean;

  constructor() {
    super();
    this.kind = "page";
    this.compact = false;
  }

  static override styles = [
    layoutStyles,
    css`
      :host { display: block; min-width: 0; }
      :host([kind="split"]) { display: flex; flex: 1 1 0; flex-direction: column; min-height: 0; height: 100%; }
      .frame { width: 100%; min-width: 0; box-sizing: border-box; }
      .frame.page { max-width: var(--page-width, 840px); margin-inline: auto; }
      .frame.page.compact { max-width: var(--compact-page-width, 24rem); }
      .frame.page.compact .page-header { max-width: var(--compact-page-width, 24rem); }
      .frame.wide { max-width: var(--wide-width, 1400px); margin-inline: auto; }
      .frame.split { max-width: var(--wide-width, 1400px); margin-inline: auto; display: flex; flex-direction: column; height: 100%; min-height: 0; }
      ::slotted([slot="heading"]) {
        display: block;
        margin: 0;
        font: 700 30px/1.15 var(--display);
        letter-spacing: -0.5px;
        overflow-wrap: anywhere;
      }
      ::slotted([slot="subtitle"]) { display: block; margin: 6px 0 0; color: var(--ink-2); font-size: 15px; line-height: 1.4; }
      .content { width: 100%; min-width: 0; box-sizing: border-box; }
      .frame.wide .content { max-width: var(--wide-width, 1400px); margin-inline: auto; }
      /* A Split heading tracks the full pane grid; the Page-width cap is for Page/Wide headers. */
      .frame.split .page-header { max-width: none; margin-inline: 0; flex: none; }
      .frame.split .content { display: flex; flex: 1 1 0; min-height: 0; overflow: hidden; }
      ::slotted(:not([slot])) { display: block; width: 100%; min-width: 0; max-width: none; box-sizing: border-box; }
      :host([kind="split"]) ::slotted(:not([slot])) { height: 100%; min-height: 0; }
      @media (max-width: 600px) {
        .page-header { align-items: flex-start; margin-bottom: 16px; }
        ::slotted([slot="heading"]) { font-size: 26px; }
        .page-actions { flex-wrap: wrap; }
      }
      @media (max-width: ${LAYOUT_BREAKPOINTS.phone}px) {
        .frame.split .page-header,
        .frame.split .content { padding-inline: var(--layout-mobile-gutter, 16px); }
      }
      @media (max-width: ${LAYOUT_BREAKPOINTS.phone}px) and (max-height: 520px) {
        .frame.split .page-header { margin-bottom: 8px; padding-bottom: 6px; }
        ::slotted([slot="heading"]) { font-size: 20px; }
      }
    `,
  ];

  override render() {
    return html`<section class="frame ${this.kind} ${this.compact ? "compact" : ""}" data-layout=${this.kind}>
      <header class="page-header">
        <div class="heading-copy"><slot name="heading"></slot><slot name="subtitle"></slot></div>
        <div class="page-actions"><slot name="actions"></slot></div>
      </header>
      <div class="content"><slot></slot></div>
    </section>`;
  }
}

if (!customElements.get("inc-layout")) customElements.define("inc-layout", IncLayout);
