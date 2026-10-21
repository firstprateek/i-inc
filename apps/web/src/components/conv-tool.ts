// One tool call in a conversation: a compact one-line card (Read, Edit, Run, Search... with its status) that
// opens to the input and output; edits show a diff; a call waiting for the owner shows what it will do and the
// agent's own options (Allow once, Always allow, Deny). Plans render as a checklist.
import type {
  ConfirmationOption,
  ToolCallPendingConfirmationState,
  ToolCallState,
} from "@microsoft/agent-host-protocol";
import { css, html, LitElement, nothing, type SVGTemplateResult, svg, type TemplateResult } from "lit";
import { ahp } from "../ahp/hub.ts";
import { ToolCallStatus } from "../ahp/wire.ts";
import { renderMarkdown } from "../conversations/markdown.ts";
import {
  CATEGORY_LABEL,
  isPlanCall,
  optionKind,
  planEntries,
  sortedOptions,
  toolCategory,
  toolDetail,
  toolEdits,
  toolError,
  toolFailed,
  toolInputText,
  toolOutputRefs,
  toolOutputText,
  toolTitle,
  visible,
} from "../conversations/model.ts";
import { cardStyles, markdownStyles } from "../conversations/styles.ts";
import "./conv-diff.ts";

export interface ConfirmDetail {
  turnId: string;
  toolCallId: string;
  option?: ConfirmationOption;
  approve?: boolean;
}

const ICONS: Record<string, SVGTemplateResult> = {
  read: svg`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>`,
  edit: svg`<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>`,
  delete: svg`<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>`,
  move: svg`<path d="M5 12h14M13 6l6 6-6 6"/>`,
  search: svg`<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>`,
  run: svg`<path d="M4 17l6-6-6-6M12 19h8"/>`,
  fetch: svg`<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>`,
  think: svg`<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>`,
  plan: svg`<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>`,
  other: svg`<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/>`,
};

const OUTPUT_LINES = 20;
const OUTPUT_CHARS = 3000;

export class IncConvTool extends LitElement {
  static override properties = {
    call: { attribute: false },
    turnId: { type: String },
    chat: { type: String },
    turnActive: { type: Boolean },
    open: { state: true },
    showAll: { state: true },
    sending: { state: true },
    images: { state: true },
  };
  declare call: ToolCallState | undefined;
  declare turnId: string;
  /** The chat this call is in (answers are remembered per chat). */
  declare chat: string;
  declare turnActive: boolean;
  declare open: boolean | undefined;
  declare showAll: boolean;
  declare sending: string | null;
  declare images: Record<string, string>;

  constructor() {
    super();
    this.turnId = "";
    this.chat = "";
    this.turnActive = false;
    this.showAll = false;
    this.sending = null;
    this.images = {};
  }

  static override styles = [
    cardStyles,
    markdownStyles,
    css`
      :host { display: block; min-width: 0; }
      .tool { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); min-width: 0; }
      .tool.pending { border: 2px solid var(--needs-edge); background: var(--needs-surface); }
      .head { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 4px 10px; cursor: pointer; min-width: 0; }
      .head:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; border-radius: 12px; }
      @media (pointer: coarse) { .head { min-height: 44px; } }
      .ico { flex: none; width: 18px; height: 18px; color: var(--ink-2); display: inline-flex; }
      .ico svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .cat { font-weight: 700; font-size: 13px; flex: none; }
      .detail { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12.5px var(--mono); color: var(--ink-2); }
      .stat { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--ink-2); white-space: nowrap; }
      .stat.ok { color: var(--working-fg); } .stat.bad { color: var(--alarm-fg); } .stat.wait { color: var(--needs-fg); }
      .stat svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
      .spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--ink); animation: spin 0.8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .chev { flex: none; width: 14px; height: 14px; color: var(--ink-2); transition: transform 0.12s; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
      [aria-expanded="true"] .chev { transform: rotate(90deg); }
      .stats { flex: none; display: inline-flex; gap: 4px; font: 700 11.5px var(--mono); }
      .plus { color: var(--diff-add-fg); background: var(--diff-add-bg); border-radius: 4px; padding: 0 5px; }
      .minus { color: var(--diff-del-fg); background: var(--diff-del-bg); border-radius: 4px; padding: 0 5px; }
      .body { padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--line); min-width: 0; }
      .label { margin: 6px 0 0; font: 700 11.5px var(--body); text-transform: uppercase; letter-spacing: 0.4px; color: var(--ink-2); }
      pre { margin: 0; padding: 10px 12px; background: var(--code-bg); border: 1px solid var(--line); border-radius: 10px; font: 12.5px/1.5 var(--mono); font-variant-ligatures: none;
        white-space: pre-wrap; overflow-wrap: anywhere; max-height: 50vh; overflow: auto; }
      pre:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .msg { margin: 0; font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
      .err { color: var(--alarm-fg); font-weight: 600; }
      .perm { padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
      .perm .what { margin: 6px 0 0; font-weight: 700; font-size: 15px; line-height: 1.35; overflow-wrap: anywhere; }
      .perm .what p { margin: 0; } .perm .what .md-h { font-size: 15px; margin: 0; }
      .opts { display: flex; flex-wrap: wrap; gap: 8px; }
      .outcome { margin: 0; padding: 0 12px 10px; font-size: 13px; color: var(--ink-2); }
      .plan { padding: 8px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
      .plan-head { display: flex; justify-content: space-between; font-weight: 700; font-size: 13px; }
      .plan ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .plan li { display: flex; gap: 8px; align-items: flex-start; font-size: 14px; line-height: 1.4; }
      .plan li .dot { flex: none; width: 16px; height: 16px; margin-top: 2px; border-radius: 50%; border: 2px solid var(--line-strong); display: inline-grid; place-items: center; }
      .plan li.completed .dot { background: var(--working-fg); border-color: var(--working-fg); color: var(--ground); }
      .plan li.in_progress .dot { border-color: var(--reviewing-mark); }
      .plan li.in_progress .dot::after { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--reviewing-mark); }
      .plan li.completed span.t { color: var(--ink-2); text-decoration: line-through; }
      .plan svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 3.4; stroke-linecap: round; stroke-linejoin: round; }
      .img { max-width: 100%; max-height: 320px; border-radius: 10px; border: 1px solid var(--line); }
    `,
  ];

  private offInfo: (() => void) | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    // An answer sent into a socket that then dropped never gets its echo: let the buttons be used again.
    this.offInfo = ahp().onInfo((i) => {
      if (i.status !== "open") this.sending = null;
    });
  }

  override disconnectedCallback(): void {
    this.offInfo?.();
    super.disconnectedCallback();
  }

  override willUpdate(): void {
    // The answer went out and the call moved on (from here or another device): the buttons are done with.
    if (this.sending && this.call?.status !== ToolCallStatus.PendingConfirmation) this.sending = null;
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("open") && this.open) void this.loadImages();
  }

  private async loadImages(): Promise<void> {
    const call = this.call;
    if (!call) return;
    for (const r of toolOutputRefs(call)) {
      if (this.images[r.uri] || !(r.contentType ?? "").startsWith("image/")) continue;
      try {
        const c = await ahp().readContent(r.uri);
        if (c.dataUrl) this.images = { ...this.images, [r.uri]: c.dataUrl };
      } catch {
        // the image stays a note
      }
    }
  }

  private toggle = () => {
    this.open = !this.isOpen();
  };

  private isOpen(): boolean {
    return this.open ?? this.call?.status === ToolCallStatus.PendingConfirmation;
  }

  private confirm(option: ConfirmationOption | undefined, approve: boolean) {
    const call = this.call;
    if (!call || this.sending) return;
    this.sending = option?.id ?? (approve ? "allow" : "deny");
    const detail: ConfirmDetail = {
      turnId: this.turnId,
      toolCallId: call.toolCallId,
      ...(option ? { option } : { approve }),
    };
    this.dispatchEvent(
      new CustomEvent<ConfirmDetail>("conv-confirm", { detail, bubbles: true, composed: true }),
    );
  }

  /** The confirmation's outcome in words, when the owner (here or elsewhere) answered it. */
  private outcome(call: ToolCallState): string {
    const who = ahp().confirmation(this.chat, call.toolCallId);
    const elsewhere = who && !who.byMe ? " on another device" : "";
    if (call.status === ToolCallStatus.Cancelled) {
      if (call.reason === ("denied" as never)) {
        const label = call.selectedOption?.label;
        return `${label && !/^deny$/i.test(label) ? label : "Denied"}${elsewhere}`;
      }
      return call.reason === ("skipped" as never) ? "Cancelled" : "";
    }
    if (
      (call.status === ToolCallStatus.Running || call.status === ToolCallStatus.Completed) &&
      call.confirmed === ("user-action" as never)
    ) {
      const label = call.selectedOption?.label;
      return `${label && !/^allow once$/i.test(label) ? label : "Allowed"}${elsewhere}`;
    }
    if (
      (call.status === ToolCallStatus.Running || call.status === ToolCallStatus.Completed) &&
      call.confirmed === ("setting" as never)
    )
      return "Allowed by a setting";
    return "";
  }

  private status(call: ToolCallState): TemplateResult {
    switch (call.status) {
      case ToolCallStatus.Streaming:
        return html`<span class="stat"><span class="spin" aria-hidden="true"></span>Preparing</span>`;
      case ToolCallStatus.PendingConfirmation:
        return html`<span class="stat wait">Waiting for you</span>`;
      case ToolCallStatus.Running:
        return html`<span class="stat"><span class="spin" aria-hidden="true"></span>Running</span>`;
      case ToolCallStatus.Completed:
        return toolFailed(call)
          ? html`<span class="stat bad"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>Failed</span>`
          : html`<span class="stat ok"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg><span class="sr-only">Done</span></span>`;
      default:
        return html`<span class="stat">${this.outcome(call) || "Cancelled"}</span>`;
    }
  }

  private plan(call: ToolCallState): TemplateResult {
    const entries = planEntries(call) ?? [];
    const done = entries.filter((e) => e.status === "completed").length;
    return html`<div class="tool" id="tool-${call.toolCallId}"><div class="plan" role="group" aria-label="Plan">
      <div class="plan-head"><span>Plan</span><span class="stat">${done} of ${entries.length} done</span></div>
      <ul>${entries.map(
        (
          e,
        ) => html`<li class=${e.status}><span class="dot" aria-hidden="true">${e.status === "completed" ? html`<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>` : nothing}</span>
          <span class="t">${e.content}</span><span class="sr-only">${e.status === "completed" ? "done" : e.status === "in_progress" ? "in progress" : "to do"}</span></li>`,
      )}</ul></div></div>`;
  }

  private permission(call: ToolCallPendingConfirmationState): TemplateResult {
    // The title may be markdown; it goes through the safe renderer, never in as HTML.
    const raw =
      typeof call.confirmationTitle === "string"
        ? call.confirmationTitle
        : (call.confirmationTitle?.markdown ?? toolTitle(call));
    const title = visible(raw);
    const edits = toolEdits(call);
    const input = toolInputText(call);
    const cat = toolCategory(call);
    const options = sortedOptions(call.options);
    return html`<div class="perm" role="group" aria-label="Permission needed: ${title.replace(/[`*_#>]/g, "")}">
      <div class="what md">${renderMarkdown(title)}</div>
      ${edits.length ? edits.map((e) => html`<inc-conv-diff .edit=${e}></inc-conv-diff>`) : input ? html`<pre tabindex="0" aria-label=${cat === "run" ? "Command" : "Input"}>${input}</pre>` : nothing}
      <div class="opts">
        ${
          options.length
            ? options.map((o) => {
                const k = optionKind(o);
                return html`<button class="cbtn ${k === "once" ? "primary" : k === "deny" || k === "deny-always" ? "danger" : ""}" type="button"
                  ?disabled=${this.sending !== null} data-option=${o.id} @click=${() => this.confirm(o, o.kind === ("approve" as never))}>${this.sending === o.id ? "Sending…" : o.label}</button>`;
              })
            : html`<button class="cbtn primary" type="button" ?disabled=${this.sending !== null} @click=${() => this.confirm(undefined, true)}>Allow</button>
                <button class="cbtn danger" type="button" ?disabled=${this.sending !== null} @click=${() => this.confirm(undefined, false)}>Deny</button>`
        }
      </div>
    </div>`;
  }

  private body(call: ToolCallState): TemplateResult {
    const input = toolInputText(call);
    const out = toolOutputText(call);
    const edits = toolEdits(call);
    const lines = out.split("\n");
    const cut = !this.showAll && (lines.length > OUTPUT_LINES || out.length > OUTPUT_CHARS);
    const shown = cut ? lines.slice(0, OUTPUT_LINES).join("\n").slice(0, OUTPUT_CHARS) : out;
    const err = toolError(call);
    const refs = toolOutputRefs(call);
    return html`<div class="body" id="body-${call.toolCallId}">
      ${edits.map((e) => html`<inc-conv-diff .edit=${e}></inc-conv-diff>`)}
      ${input && !edits.length ? html`<p class="label">${toolCategory(call) === "run" ? "Command" : "Input"}</p><pre tabindex="0">${input}</pre>` : nothing}
      ${
        out
          ? html`<p class="label">Output</p><pre tabindex="0">${shown}${cut ? "\n…" : ""}</pre>
        ${
          cut
            ? html`<div><button class="link-btn" type="button" @click=${() => {
                this.showAll = true;
              }}>Show all (${lines.length} lines)</button></div>`
            : nothing
        }`
          : nothing
      }
      ${refs.map((r) => (this.images[r.uri] ? html`<img class="img" src=${this.images[r.uri] ?? ""} alt="Tool output" />` : nothing))}
      ${toolFailed(call) ? html`<p class="msg err">${err || "The step failed."}</p>` : nothing}
      ${toolFailed(call) && !this.turnActive ? html`<div><button class="cbtn" type="button" @click=${() => this.retry(call)}>Retry</button></div>` : nothing}
      ${!input && !out && !edits.length && !err ? html`<p class="msg muted">${call.status === ToolCallStatus.Completed ? "No output." : "Nothing yet."}</p>` : nothing}
    </div>`;
  }

  private retry(call: ToolCallState) {
    this.dispatchEvent(
      new CustomEvent("conv-retry", {
        detail: { text: `That step failed: ${toolTitle(call)}. Please try it again.` },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const call = this.call;
    if (!call) return nothing;
    if (isPlanCall(call)) return this.plan(call);
    const cat = toolCategory(call);
    const pending = call.status === ToolCallStatus.PendingConfirmation;
    const open = this.isOpen();
    const edits = !pending && call.status === ToolCallStatus.Completed ? toolEdits(call) : [];
    const added = edits.reduce((n, e) => n + (e.diff?.added ?? 0), 0);
    const removed = edits.reduce((n, e) => n + (e.diff?.removed ?? 0), 0);
    const outcome = this.outcome(call);
    const detail = toolDetail(call) || toolTitle(call);
    return html`<div class="tool ${pending ? "pending" : ""}" id="tool-${call.toolCallId}" data-status=${call.status}>
      <button class="head" type="button" aria-expanded=${open ? "true" : "false"} aria-controls="body-${call.toolCallId}" @click=${this.toggle}>
        <span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[cat]}</svg></span>
        <span class="cat">${CATEGORY_LABEL[cat]}</span>
        <span class="detail" title=${detail}>${detail}</span>
        ${edits.length ? html`<span class="stats"><span class="plus">+${added}</span><span class="minus">−${removed}</span></span>` : nothing}
        ${this.status(call)}
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      ${pending ? this.permission(call) : open ? this.body(call) : nothing}
      ${outcome && call.status !== ToolCallStatus.Cancelled ? html`<p class="outcome">${outcome}</p>` : nothing}
    </div>`;
  }
}

customElements.define("inc-conv-tool", IncConvTool);
