// One turn of a conversation: the owner's message and the agent's response as parts (markdown, "Thinking",
// tool calls, questions, errors), then the turn's usage. Completed turns are plain values that never change,
// so Lit only re-renders the turn that is streaming, and within it only the part that grew.
import type { ActiveTurn, Message, ResponsePart, Turn } from "@microsoft/agent-host-protocol";
import { css, html, LitElement, nothing } from "lit";
import { ahp } from "../ahp/hub.ts";
import { ResponsePartKind, TurnState } from "../ahp/wire.ts";
import { MarkdownCache } from "../conversations/markdown.ts";
import { durationText, usageLine, visible } from "../conversations/model.ts";
import { cardStyles, markdownStyles } from "../conversations/styles.ts";
import { atTime } from "../time.ts";
import "./conv-question.ts";
import "./conv-tool.ts";

type AnyTurn = Turn | ActiveTurn;

const MAX_CACHES = 80;

export class IncConvTurn extends LitElement {
  static override properties = {
    turn: { attribute: false },
    active: { type: Boolean },
    employee: { type: String },
    chat: { type: String },
    images: { state: true },
  };
  declare turn: AnyTurn | undefined;
  declare active: boolean;
  declare employee: string;
  declare chat: string;
  declare images: Record<string, string>;
  private readonly caches = new Map<string, MarkdownCache>();

  constructor() {
    super();
    this.active = false;
    this.employee = "";
    this.chat = "";
    this.images = {};
  }

  static override styles = [
    cardStyles,
    markdownStyles,
    css`
      :host { display: block; min-width: 0; }
      :host(:not([active])) { content-visibility: auto; contain-intrinsic-size: auto 220px; }
      .turn { display: flex; flex-direction: column; gap: 12px; padding: 14px 0; min-width: 0; }
      .user { align-self: flex-end; max-width: min(88%, 640px); background: var(--sunken); border: 1px solid var(--line); border-radius: 16px 16px 4px 16px;
        padding: 10px 14px; font-size: 15.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
      .atts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
      .atts img { max-width: 160px; max-height: 120px; border-radius: 8px; border: 1px solid var(--line); object-fit: cover; }
      .atts .file { font: 12px var(--mono); padding: 4px 8px; border-radius: 8px; background: var(--surface); border: 1px solid var(--line); }
      .agent { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
      details.think { border-left: 3px solid var(--line-strong); padding-left: 12px; color: var(--ink-2); }
      details.think summary { cursor: pointer; font: 600 13px var(--body); min-height: 32px; display: flex; align-items: center; gap: 8px; list-style: none; }
      details.think summary::-webkit-details-marker { display: none; }
      details.think summary::before { content: ""; width: 7px; height: 7px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(-45deg); transition: transform 0.12s; }
      details.think[open] summary::before { transform: rotate(45deg); }
      details.think .md { font-size: 14px; color: var(--ink-2); }
      .sys { margin: 0; font-size: 13px; color: var(--ink-2); font-style: italic; }
      .error { border: 2px solid var(--alarm); border-radius: 12px; padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; background: var(--surface); }
      .error p { margin: 0; color: var(--alarm-fg); font-weight: 600; overflow-wrap: anywhere; }
      .foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 12.5px; color: var(--ink-2); }
      .working { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
      .dots { display: inline-flex; gap: 3px; }
      .dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--ink-2); animation: blink 1.2s infinite ease-in-out; }
      .dots i:nth-child(2) { animation-delay: 0.15s; } .dots i:nth-child(3) { animation-delay: 0.3s; }
      @keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    this.toggleAttribute("active", this.active);
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("active")) this.toggleAttribute("active", this.active);
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("turn")) void this.loadImages();
  }

  override disconnectedCallback(): void {
    this.caches.clear();
    super.disconnectedCallback();
  }

  private async loadImages(): Promise<void> {
    for (const a of this.turn?.message.attachments ?? []) {
      if (a.type !== ("resource" as never)) continue;
      const uri = (a as { uri: string }).uri;
      if (this.images[uri] || !((a as { contentType?: string }).contentType ?? "").startsWith("image/"))
        continue;
      try {
        const c = await ahp().readContent(uri);
        if (c.dataUrl) this.images = { ...this.images, [uri]: c.dataUrl };
      } catch {
        // shown as a file chip
      }
    }
  }

  private cache(id: string): MarkdownCache {
    let c = this.caches.get(id);
    if (!c) {
      c = new MarkdownCache();
      this.caches.set(id, c);
      if (this.caches.size > MAX_CACHES) {
        const oldest = this.caches.keys().next().value;
        if (oldest !== undefined) this.caches.delete(oldest);
      }
    }
    return c;
  }

  private attachments(m: Message) {
    if (!m.attachments?.length) return nothing;
    return html`<div class="atts">${m.attachments.map((a) => {
      const x = a as { type: string; label: string; contentType?: string; data?: string; uri?: string };
      if (x.type === "embeddedResource" && x.contentType?.startsWith("image/") && x.data)
        return html`<img src="data:${x.contentType};base64,${x.data}" alt=${x.label} />`;
      if (x.type === "resource" && x.uri && this.images[x.uri])
        return html`<img src=${this.images[x.uri] ?? ""} alt=${x.label} />`;
      return html`<span class="file">${x.label}</span>`;
    })}</div>`;
  }

  /** A usage limit's reset, worded in the owner's time zone (the host sends the moment, not the words). */
  private resets(e: { message: string; _meta?: Record<string, unknown> | undefined }): string {
    const at = e._meta?.["iinc.resetsAt"];
    if (typeof at !== "number" || !Number.isFinite(at)) return "";
    return `${/[.!?]$/.test(e.message.trim()) ? "" : "."} It resets ${atTime(at)}.`;
  }

  private renderPart(p: ResponsePart, last: boolean, turn: AnyTurn) {
    switch (p.kind) {
      case ResponsePartKind.Markdown:
        return p.content
          ? html`<div class="md">${this.cache(p.id).render(p.content, this.active && last)}</div>`
          : nothing;
      case ResponsePartKind.Reasoning:
        return html`<details class="think"><summary>${this.active && last ? "Thinking…" : "Thinking"}</summary><div class="md">${this.cache(p.id).render(p.content, this.active && last)}</div></details>`;
      case ResponsePartKind.ToolCall:
        return html`<inc-conv-tool .call=${p.toolCall} .turnId=${turn.id} .chat=${this.chat} .turnActive=${this.active}></inc-conv-tool>`;
      case ResponsePartKind.InputRequest:
        return html`<inc-conv-question .request=${p.request} .response=${p.response} .chat=${this.chat}></inc-conv-question>`;
      case ResponsePartKind.SystemNotification:
        return html`<p class="sys">${visible(typeof p.content === "string" ? p.content : p.content.markdown, true)}</p>`;
      case ResponsePartKind.Error:
        return html`<div class="error" role="alert"><p>${visible(p.error.message, true)}${this.resets(p.error)}</p>
          ${!this.active ? html`<div><button class="cbtn" type="button" @click=${() => this.retry(turn.message.text)}>Retry</button></div>` : nothing}</div>`;
      default:
        return nothing;
    }
  }

  private retry(text: string) {
    this.dispatchEvent(new CustomEvent("conv-retry", { detail: { text }, bubbles: true, composed: true }));
  }

  override render() {
    const turn = this.turn;
    if (!turn) return nothing;
    const done = "state" in turn ? turn : undefined;
    const usage = usageLine(turn.usage);
    const parts = turn.responseParts;
    const waiting = parts.some(
      (p) => p.kind === ResponsePartKind.ToolCall && p.toolCall.status === ("pending-confirmation" as never),
    );
    return html`<article class="turn" aria-label="Turn">
      <div class="user">${visible(turn.message.text, true)}${this.attachments(turn.message)}</div>
      <div class="agent">
        ${parts.map((p, i) => this.renderPart(p, i === parts.length - 1, turn))}
        ${
          this.active
            ? html`<div class="foot"><span class="working" aria-hidden="true"><span class="dots"><i></i><i></i><i></i></span>${waiting ? "Waiting for you" : "Working"}</span></div>`
            : html`<div class="foot">
                ${done?.state === TurnState.Cancelled ? html`<span>Stopped</span>` : nothing}
                ${usage ? html`<span title="Tokens used in this turn">${usage}</span>` : nothing}
                ${done?.duration !== undefined ? html`<span>${durationText(done.duration)}</span>` : nothing}
              </div>`
        }
      </div>
    </article>`;
  }
}

customElements.define("inc-conv-turn", IncConvTurn);
