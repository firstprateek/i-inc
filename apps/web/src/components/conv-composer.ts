// The composer: a multi-line box. Enter sends (Shift+Enter breaks a line; a phone's Enter breaks a line, since
// it has a Send button), never while an IME is composing. Paste or drop images. `/` opens the agent's slash
// commands. The agent's own modes and models are pickers. While a turn runs: Stop, and typing offers Steer
// (runs next, ahead of the queue) or Queue; the queued messages are listed and removable.
import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import { css, html, LitElement, nothing } from "lit";
import { checkOutgoing } from "../conversations/actions.ts";
import {
  type Command,
  commandsOf,
  matchCommands,
  modePicker,
  otherPickers,
  type Picker,
  slashQuery,
} from "../conversations/model.ts";
import { cardStyles } from "../conversations/styles.ts";
import { draftMemo } from "../drafts.ts";
import { isTouchDevice } from "./chat.ts";
import { ImagePicker, imagePickerStyles } from "./image-picker.ts";
import { selectField } from "./shared.ts";

export type Intent = "turn" | "steer" | "queue";
export interface SendDetail {
  text: string;
  files: File[];
  intent: Intent;
}

/** The Enter key on a composer: should it send? Never while an IME is composing a character. */
export function enterSends(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">,
  composing: boolean,
  touch: boolean,
): boolean {
  if (e.key !== "Enter") return false;
  if (e.isComposing || composing || e.keyCode === 229) return false;
  if (e.shiftKey || touch) return false;
  return true;
}

export class IncConvComposer extends LitElement {
  static override properties = {
    session: { attribute: false },
    chat: { attribute: false },
    conversationId: { type: String },
    name: { type: String },
    blocked: { type: String },
    onSend: { attribute: false },
    text: { state: true },
    sending: { state: true },
    error: { state: true },
    slash: { state: true },
    slashIndex: { state: true },
    dragging: { state: true },
  };
  declare session: SessionState | undefined;
  declare chat: ChatState | undefined;
  declare conversationId: string;
  declare name: string;
  /** Why sending is not possible right now (reconnecting, conversation gone); empty when it is. */
  declare blocked: string;
  declare onSend: ((d: SendDetail) => Promise<string | null>) | undefined;
  declare text: string;
  declare sending: boolean;
  declare error: string | null;
  declare slash: Command[];
  declare slashIndex: number;
  declare dragging: boolean;

  private readonly picker = new ImagePicker(this, {
    id: "conv-images",
    room: () => 6,
    full: () => "A message takes at most 6 images.",
  });
  private composing = false;
  private composedAt = 0;
  private draftFor = "";

  constructor() {
    super();
    this.conversationId = "";
    this.name = "";
    this.blocked = "";
    this.text = "";
    this.sending = false;
    this.error = null;
    this.slash = [];
    this.slashIndex = 0;
    this.dragging = false;
  }

  static override styles = [
    cardStyles,
    imagePickerStyles,
    selectField,
    css`
      :host { display: block; min-width: 0; }
      .composer { position: relative; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .box { border: 1px solid var(--control-edge); border-radius: 18px; background: var(--surface); padding: 8px 10px 6px; display: flex; flex-direction: column; gap: 6px; }
      .box:focus-within { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      .box.drag { border-style: dashed; background: var(--sunken); }
      textarea { font: 16px/1.45 var(--body); color: var(--ink); background: transparent; border: 0; resize: none; width: 100%; box-sizing: border-box; min-height: 28px;
        max-height: 40vh; padding: 4px 4px; outline: none; }
      textarea::placeholder { color: var(--ink-2); }
      .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .row .grow { flex: 1 1 auto; }
      .pickers { display: flex; gap: 6px; flex-wrap: wrap; min-width: 0; }
      .pickers label { display: inline-flex; align-items: center; min-width: 0; }
      .pickers select { min-height: 44px; font-size: 14px; font-weight: 600; width: auto; max-width: 190px; border-radius: 999px; padding-left: 14px; }
      .icon { flex: none; width: 44px; height: 44px; border-radius: 50%; border: 0; background: transparent; color: var(--ink-2); display: inline-grid; place-items: center; cursor: pointer; }
      .icon:hover { background: var(--sunken); color: var(--ink); }
      .icon:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      .icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .send { width: 44px; height: 44px; border-radius: 50%; border: 0; background: var(--ink); color: var(--on-ink); display: inline-grid; place-items: center; cursor: pointer; flex: none; }
      .send:disabled { opacity: 0.35; cursor: default; }
      .send:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .send svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
      .stop { background: var(--alarm); color: #fff; }
      .stop svg { fill: currentColor; stroke: none; width: 16px; height: 16px; }
      .hint { margin: 0; font-size: 12.5px; color: var(--ink-2); padding: 0 6px; }
      .problem { margin: 0; font-size: 13.5px; color: var(--alarm-fg); font-weight: 600; padding: 0 6px; }
      .queue { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .queue li { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 12px; background: var(--sunken); padding: 2px 4px 2px 10px; min-height: 44px; }
      .queue .tag { flex: none; font-size: 11.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.4px; color: var(--reviewing-fg); }
      .queue .t { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
      .pop { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 30; max-width: 520px; background: var(--surface); border: 1px solid var(--line-strong);
        border-radius: 14px; box-shadow: 0 12px 32px rgba(0,0,0,0.16); padding: 6px; max-height: 280px; overflow: auto; }
      .pop [role="option"] { display: flex; flex-direction: column; gap: 1px; padding: 8px 12px; border-radius: 8px; min-height: 44px; box-sizing: border-box; justify-content: center; cursor: pointer; }
      .pop [role="option"][aria-selected="true"], .pop [role="option"]:hover { background: var(--sunken); }
      .pop b { font: 700 14px var(--mono); }
      .pop small { color: var(--ink-2); font-size: 13px; }
      @media (max-width: 767px) {
        .hint.kbd { display: none; }
        .pickers select { max-width: 140px; }
      }
    `,
  ];

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("conversationId") && this.conversationId !== this.draftFor) {
      this.draftFor = this.conversationId;
      this.text = draftMemo.get(`conv:${this.conversationId}`) ?? "";
      this.error = null;
      this.slash = [];
      this.picker.clear();
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("text") || changed.has("conversationId")) this.fit();
  }

  /** Puts text back in the box (a message the host refused), unless something new has been typed. */
  restore(text: string, files: File[] = []): void {
    if (files.length) this.picker.add(files);
    if (this.text.trim()) return;
    this.text = text;
    draftMemo.set(`conv:${this.conversationId}`, text);
    this.focusInput();
  }

  focusInput(): void {
    this.renderRoot.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }

  private fit() {
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round(innerHeight * 0.4))}px`;
  }

  private get running(): boolean {
    return !!this.chat?.activeTurn;
  }

  private onInput = (e: Event) => {
    const ta = e.target as HTMLTextAreaElement;
    this.text = ta.value;
    draftMemo.set(`conv:${this.conversationId}`, this.text);
    this.updateSlash(ta);
  };

  private updateSlash(ta: HTMLTextAreaElement) {
    const q = slashQuery(ta.value, ta.selectionStart ?? ta.value.length);
    const list = q ? matchCommands(commandsOf(this.session), q.word) : [];
    this.slash = list;
    if (this.slashIndex >= list.length) this.slashIndex = 0;
  }

  private pickCommand(c: Command) {
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("textarea");
    if (!ta) return;
    const cursor = ta.selectionStart ?? ta.value.length;
    const q = slashQuery(ta.value, cursor);
    if (!q) return;
    const next = `${ta.value.slice(0, q.start)}/${c.name} ${ta.value.slice(cursor)}`;
    this.text = next;
    draftMemo.set(`conv:${this.conversationId}`, next);
    this.slash = [];
    const at = q.start + c.name.length + 2;
    void this.updateComplete.then(() => {
      ta.focus();
      ta.setSelectionRange(at, at);
    });
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (this.slash.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = this.slash.length;
        this.slashIndex = (this.slashIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.isComposing && !e.shiftKey) {
        e.preventDefault();
        const c = this.slash[this.slashIndex];
        if (c) this.pickCommand(c);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.slash = [];
        return;
      }
    }
    if (e.key === "Enter" && e.altKey && this.running && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void this.submit("queue");
      return;
    }
    if (enterSends(e, this.composing || Date.now() - this.composedAt < 60, isTouchDevice())) {
      e.preventDefault();
      void this.submit(this.running ? "steer" : "turn");
    }
  };

  async submit(intent: Intent): Promise<void> {
    const text = this.text.trim();
    const files = this.picker.files;
    if ((!text && !files.length) || this.sending || this.blocked || !this.onSend) return;
    if (checkOutgoing(text, files)) return; // the box already says why
    this.sending = true;
    this.error = null;
    const problem = await this.onSend({ text, files, intent });
    this.sending = false;
    if (problem) {
      this.error = problem;
      return;
    }
    this.text = "";
    this.slash = [];
    draftMemo.set(`conv:${this.conversationId}`, "");
    this.picker.clear();
    this.focusInput();
  }

  private emit<T>(name: string, detail: T) {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  private picked(p: Picker) {
    return html`<label><span class="sr-only">${p.title}</span><select aria-label=${p.title} title=${p.title}
      @change=${(e: Event) => this.emit("conv-config", { key: p.key, value: (e.target as HTMLSelectElement).value })}>
      ${p.choices.map((c) => html`<option value=${c.value} ?selected=${c.value === p.value} title=${c.description ?? ""}>${c.label}</option>`)}
    </select></label>`;
  }

  private queue() {
    const items: { kind: "steering" | "queued"; id: string; text: string }[] = [];
    const s = this.chat?.steeringMessage;
    if (s) items.push({ kind: "steering", id: s.id, text: s.message.text });
    for (const q of this.chat?.queuedMessages ?? [])
      items.push({ kind: "queued", id: q.id, text: q.message.text });
    if (!items.length) return nothing;
    return html`<ul class="queue" aria-label="Messages waiting to be sent">${items.map(
      (
        m,
      ) => html`<li><span class="tag">${m.kind === "steering" ? "Steering, runs next" : "Queued"}</span><span class="t" title=${m.text}>${m.text}</span>
        <button class="icon" type="button" aria-label="Remove ${m.kind === "steering" ? "steering" : "queued"} message: ${m.text.slice(0, 40)}"
          @click=${() => this.emit("conv-unqueue", { kind: m.kind, id: m.id })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg></button></li>`,
    )}</ul>`;
  }

  override render() {
    const running = this.running;
    const hasInput = !!this.text.trim() || this.picker.files.length > 0;
    const mode = modePicker(this.session);
    const others = otherPickers(this.session);
    const tooBig = checkOutgoing(this.text, this.picker.files);
    const dis = !!this.blocked || !!tooBig;
    return html`<form class="composer" @submit=${(e: Event) => e.preventDefault()}
      @dragover=${(e: DragEvent) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          this.dragging = true;
        }
      }}
      @dragleave=${() => {
        this.dragging = false;
      }}
      @drop=${(e: DragEvent) => {
        e.preventDefault();
        this.dragging = false;
        this.picker.add([...(e.dataTransfer?.files ?? [])]);
      }}>
      ${this.queue()}
      ${
        this.slash.length
          ? html`<div class="pop" role="listbox" id="slash-list" aria-label="Commands">${this.slash.map(
              (
                c,
                i,
              ) => html`<div role="option" id="slash-${i}" aria-selected=${i === this.slashIndex ? "true" : "false"}
              @mousedown=${(e: Event) => {
                e.preventDefault();
                this.pickCommand(c);
              }}><b>/${c.name}</b>${c.description ? html`<small>${c.description}${c.hint ? ` (${c.hint})` : ""}</small>` : nothing}</div>`,
            )}</div>`
          : nothing
      }
      ${this.picker.problem ? html`<p class="problem" role="alert">${this.picker.problem}</p>` : nothing}
      ${this.error ? html`<p class="problem" role="alert">${this.error}</p>` : nothing}
      ${tooBig ? html`<p class="problem" role="alert">${tooBig}</p>` : nothing}
      ${this.blocked ? html`<p class="hint" role="status">${this.blocked}</p>` : nothing}
      <div class="box ${this.dragging ? "drag" : ""}">
        ${this.picker.thumbs({ compact: true })}
        <textarea rows="1" .value=${this.text} placeholder=${running ? "Type to steer or queue…" : `Message ${this.name || "the agent"}…`}
          aria-label="Message" role="combobox" aria-autocomplete="list" aria-expanded=${this.slash.length ? "true" : "false"}
          aria-controls=${this.slash.length ? "slash-list" : nothing} aria-activedescendant=${this.slash.length ? `slash-${this.slashIndex}` : nothing}
          enterkeyhint="send" autocomplete="off" autocapitalize="sentences"
          @input=${this.onInput} @keydown=${this.onKeydown}
          @click=${(e: Event) => this.updateSlash(e.target as HTMLTextAreaElement)}
          @paste=${this.picker.paste}
          @compositionstart=${() => {
            this.composing = true;
          }}
          @compositionend=${() => {
            this.composing = false;
            this.composedAt = Date.now();
          }}></textarea>
        <div class="row">
          ${this.picker.input()}
          <button class="icon" type="button" aria-label="Attach images" title="Attach images (or paste or drop them)" @click=${() => this.picker.open()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3"/></svg>
          </button>
          <div class="pickers">${mode ? this.picked(mode) : nothing}${others.map((p) => this.picked(p))}</div>
          <span class="grow"></span>
          ${
            running
              ? html`${
                  hasInput
                    ? html`<button class="cbtn" type="button" ?disabled=${dis || this.sending} title="Runs next, ahead of the queue" @click=${() => void this.submit("steer")}>Steer</button>
                  <button class="cbtn" type="button" ?disabled=${dis || this.sending} title="Waits for its turn (Alt+Enter)" @click=${() => void this.submit("queue")}>Queue</button>`
                    : nothing
                }
                <button class="send stop" type="button" aria-label="Stop" title="Stop the agent" @click=${() => this.emit("conv-stop", {})}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>`
              : html`<button class="send" type="submit" aria-label="Send" title="Send" ?disabled=${!hasInput || dis || this.sending} @click=${() => void this.submit("turn")}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>`
          }
        </div>
      </div>
      ${running && hasInput ? html`<p class="hint">Steer runs your message next, ahead of the queue. Queue waits its turn. Stop interrupts the agent.</p>` : html`<p class="hint kbd">Enter sends · Shift+Enter for a new line · / for commands</p>`}
    </form>`;
  }
}

customElements.define("inc-conv-composer", IncConvComposer);
