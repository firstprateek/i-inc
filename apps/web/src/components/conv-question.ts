// A question the agent asked (an AHP input request): text, numbers, yes/no and choices. Answered with
// `chat/inputCompleted`; if another device answers first, this shows that it was answered there.
import type { ChatInputQuestion, ChatInputRequest } from "@microsoft/agent-host-protocol";
import { css, html, LitElement, nothing } from "lit";
import { ahp } from "../ahp/hub.ts";
import { cardStyles } from "../conversations/styles.ts";

type Draft = Record<string, string | boolean | string[]>;

export interface InputDetail {
  requestId: string;
  response: "accept" | "decline" | "cancel";
  answers?: Record<string, unknown>;
}

export class IncConvQuestion extends LitElement {
  static override properties = {
    request: { attribute: false },
    response: { type: String },
    draft: { state: true },
    sending: { state: true },
  };
  declare request: ChatInputRequest | undefined;
  /** Set once the request was answered (`accept`, `decline` or `cancel`). */
  declare response: string | undefined;
  declare draft: Draft;
  declare sending: boolean;

  constructor() {
    super();
    this.draft = {};
    this.sending = false;
  }

  static override styles = [
    cardStyles,
    css`
      :host { display: block; min-width: 0; }
      .card { border: 2px solid var(--needs-edge); background: var(--needs-surface); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
      .card.done { border: 1px solid var(--line); background: var(--surface); }
      .msg { margin: 0; font-weight: 700; font-size: 15px; line-height: 1.4; overflow-wrap: anywhere; }
      fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      legend { padding: 0; font-weight: 700; font-size: 14px; margin-bottom: 4px; }
      label.opt { display: flex; gap: 10px; align-items: flex-start; min-height: 44px; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface); cursor: pointer; }
      label.opt input { margin-top: 3px; flex: none; width: 18px; height: 18px; }
      .opt small { display: block; color: var(--ink-2); font-size: 13px; }
      input[type="text"], input[type="number"] { font: 16px var(--body); min-height: 44px; box-sizing: border-box; width: 100%; padding: 0 12px; border-radius: 10px;
        border: 1px solid var(--control-edge); background: var(--surface); color: var(--ink); }
      input:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      .btns { display: flex; gap: 8px; flex-wrap: wrap; }
      .done-line { margin: 0; color: var(--ink-2); font-size: 14px; }
    `,
  ];

  override willUpdate(): void {
    if (this.sending && this.response !== undefined) this.sending = false;
  }

  private set(id: string, v: string | boolean | string[]) {
    this.draft = { ...this.draft, [id]: v };
  }

  private answers(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const q of this.request?.questions ?? []) {
      const v = this.draft[q.id];
      if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
      const value =
        q.kind === ("boolean" as never)
          ? { kind: "boolean", value: v === true }
          : q.kind === ("number" as never) || q.kind === ("integer" as never)
            ? { kind: "number", value: Number(v) }
            : q.kind === ("single-select" as never)
              ? { kind: "selected", value: String(v) }
              : q.kind === ("multi-select" as never)
                ? { kind: "selected-many", value: v as string[] }
                : { kind: "text", value: String(v) };
      out[q.id] = { state: "submitted", value };
    }
    return out;
  }

  private canSend(): boolean {
    return (this.request?.questions ?? []).every((q) => {
      if (!q.required) return true;
      const v = this.draft[q.id];
      return v !== undefined && v !== "" && !(Array.isArray(v) && !v.length);
    });
  }

  private send(response: InputDetail["response"]) {
    if (!this.request || this.sending) return;
    this.sending = true;
    const detail: InputDetail = {
      requestId: this.request.id,
      response,
      ...(response === "accept" ? { answers: this.answers() } : {}),
    };
    this.dispatchEvent(new CustomEvent<InputDetail>("conv-input", { detail, bubbles: true, composed: true }));
  }

  private field(q: ChatInputQuestion) {
    const v = this.draft[q.id];
    switch (q.kind) {
      case "single-select":
      case "multi-select": {
        const many = q.kind === "multi-select";
        return html`<fieldset><legend>${q.title ?? q.message}${q.required ? html`<span class="sr-only"> (required)</span>` : nothing}</legend>
          ${q.title ? html`<p class="done-line">${q.message}</p>` : nothing}
          ${q.options.map(
            (
              o,
            ) => html`<label class="opt"><input type=${many ? "checkbox" : "radio"} name=${q.id} .checked=${many ? Array.isArray(v) && v.includes(o.id) : v === o.id}
              @change=${(e: Event) => {
                const on = (e.target as HTMLInputElement).checked;
                if (many) {
                  const cur = Array.isArray(v) ? v : [];
                  this.set(q.id, on ? [...cur, o.id] : cur.filter((x) => x !== o.id));
                } else this.set(q.id, o.id);
              }} /><span>${o.label}${o.recommended ? " (recommended)" : ""}${o.description ? html`<small>${o.description}</small>` : nothing}</span></label>`,
          )}</fieldset>`;
      }
      case "boolean":
        return html`<label class="opt"><input type="checkbox" .checked=${v === true} @change=${(e: Event) => this.set(q.id, (e.target as HTMLInputElement).checked)} /><span>${q.title ?? q.message}</span></label>`;
      default:
        return html`<label><span class="msg">${q.title ?? q.message}</span>
          <input type=${q.kind === "number" || q.kind === "integer" ? "number" : "text"} maxlength="4000" .value=${typeof v === "string" ? v : ""} ?required=${q.required}
            @input=${(e: Event) => this.set(q.id, (e.target as HTMLInputElement).value)} @keydown=${(
              e: KeyboardEvent,
            ) => {
              if (e.key === "Enter" && !e.isComposing && this.canSend()) this.send("accept");
            }} /></label>`;
    }
  }

  override render() {
    const r = this.request;
    if (!r) return nothing;
    if (this.response !== undefined) {
      const who = ahp().confirmation(`input:${r.id}`);
      const elsewhere = who && !who.byMe ? " on another device" : "";
      const text =
        this.response === "accept" ? "Answered" : this.response === "decline" ? "Declined" : "Cancelled";
      return html`<div class="card done"><p class="msg">${r.message ?? r.questions?.[0]?.message ?? "A question"}</p><p class="done-line">${text}${elsewhere}.</p></div>`;
    }
    return html`<div class="card" role="group" aria-label="The agent has a question">
      ${r.message ? html`<p class="msg">${r.message}</p>` : nothing}
      ${(r.questions ?? []).map((q) => this.field(q))}
      <div class="btns">
        <button class="cbtn primary" type="button" ?disabled=${this.sending || !this.canSend()} @click=${() => this.send("accept")}>${this.sending ? "Sending…" : "Send answer"}</button>
        <button class="cbtn" type="button" ?disabled=${this.sending} @click=${() => this.send("decline")}>Decline</button>
      </div>
    </div>`;
  }
}

customElements.define("inc-conv-question", IncConvQuestion);
