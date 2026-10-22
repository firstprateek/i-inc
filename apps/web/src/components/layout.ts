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
  /* The page header (title, subtitle, actions) and the area's tab row span the whole frame, whatever the
     template: they never move or change size from one tab or area to the next. */
  .page-header {
    width: 100%;
    max-width: var(--wide-width, 1400px);
    margin: 0 auto var(--layout-section-gap, 20px);
    padding: 0 0 var(--layout-header-gap, 12px);
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0 16px;
    box-sizing: border-box;
  }
  /* A heading block is never shorter than the 44px action beside it, so a route with an action and one
     without put the title in the same place. */
  .heading-copy { min-width: 0; flex: 1 1 auto; min-height: 44px; display: flex; flex-direction: column; justify-content: center; }
  /* The area's tab row (one per area): its own full-width line under the heading and actions. */
  .page-tabs { flex: 1 0 100%; min-width: 0; order: 3; }
  .page-header h1 { margin: 0; font: 700 30px/1.15 var(--display); letter-spacing: -0.5px; overflow-wrap: anywhere; }
  .page-header .subtitle { margin: 6px 0 0; color: var(--ink-2); font-size: 15px; line-height: 1.4; }
  .page-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex: 0 0 auto; align-self: flex-start; min-height: 44px; }

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
    /** A route with no tab row may use a short heading block (the Conversations screen needs the height). */
    dense: { type: Boolean, reflect: true },
    /** The heading stays for assistive technology but takes no room (a phone's thread view, which has its own title). */
    hideHeading: { type: Boolean, reflect: true, attribute: "hide-heading" },
  };
  declare kind: LayoutKind;
  declare compact: boolean;
  declare dense: boolean;
  declare hideHeading: boolean;

  constructor() {
    super();
    this.kind = "page";
    this.compact = false;
    this.dense = false;
    this.hideHeading = false;
  }

  static override styles = [
    layoutStyles,
    css`
      :host { display: block; min-width: 0; }
      :host([kind="split"]) { display: flex; flex: 1 1 0; flex-direction: column; min-height: 0; height: 100%; }
      /* One frame for every template: the header and tab row span it, and the content below follows its
         template (Page: a centred reading band; Wide and Split: the whole frame). */
      .frame { width: 100%; max-width: var(--wide-width, 1400px); margin-inline: auto; min-width: 0; box-sizing: border-box; }
      .frame.page .content { max-width: var(--page-width, 840px); margin-inline: auto; }
      .frame.page.compact { max-width: var(--compact-page-width, 24rem); }
      .frame.page.compact .page-header { max-width: var(--compact-page-width, 24rem); }
      .frame.split { display: flex; flex-direction: column; height: 100%; min-height: 0; }
      ::slotted([slot="heading"]) {
        display: block;
        margin: 0;
        font: 700 30px/1.15 var(--display);
        letter-spacing: -0.5px;
        overflow-wrap: anywhere;
      }
      ::slotted([slot="subtitle"]) { display: block; margin: 6px 0 0; color: var(--ink-2); font-size: 15px; line-height: 1.4; }
      :host([dense]) ::slotted([slot="heading"]) { font-size: 24px; line-height: 1.2; }
      :host([dense]) .page-header { margin-bottom: 8px; padding-bottom: 8px; }
      :host([hide-heading]) .page-header { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
        clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
      .content { width: 100%; min-width: 0; box-sizing: border-box; }
      /* A banner the shell puts above the view (the daemon can't be reached, a refresh failed): the view
         under it stays mounted. Empty, it takes no room. */
      .notice { width: 100%; min-width: 0; box-sizing: border-box; }
      .frame.page .notice { max-width: var(--page-width, 840px); margin-inline: auto; }
      .frame.wide .notice { max-width: var(--wide-width, 1400px); margin-inline: auto; }
      .frame.split .notice { flex: none; }
      ::slotted([slot="notice"]) { display: block; margin: 0 0 12px; }
      .frame.wide .content { max-width: var(--wide-width, 1400px); margin-inline: auto; }
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
        .frame.split .content,
        .frame.split .notice { padding-inline: var(--layout-mobile-gutter, 16px); }
        .frame.split .page-header { padding-top: 12px; }
      }
      @media (max-width: ${LAYOUT_BREAKPOINTS.phone}px) and (max-height: 640px) {
        .frame.split .page-header { margin-bottom: 8px; padding-bottom: 6px; }
        ::slotted([slot="heading"]) { font-size: 22px; }
      }
    `,
  ];

  override render() {
    return html`<section class="frame ${this.kind} ${this.compact ? "compact" : ""}" data-layout=${this.kind}>
      <header class="page-header">
        <div class="heading-copy"><slot name="heading"></slot><slot name="subtitle"></slot></div>
        <div class="page-actions"><slot name="actions"></slot></div>
        <div class="page-tabs"><slot name="tabs"></slot></div>
      </header>
      <div class="notice"><slot name="notice"></slot></div>
      <div class="content"><slot></slot></div>
    </section>`;
  }
}

if (!customElements.get("inc-layout")) customElements.define("inc-layout", IncLayout);
