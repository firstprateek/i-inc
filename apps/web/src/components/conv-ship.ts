// The confirm dialog for shipping a conversation's work (T62b): "Make this a ticket" or "Open a PR". It says
// in plain words what will be committed (the files, with their plus and minus counts), where it goes (a PR,
// or main after a review) and what the owner still has to do, and for a ticket lets the owner edit the title
// and the done-when items before anything is made. Errors are sentences from the daemon, shown in place.
import type { Employee } from "@i-inc/core";
import { css, html, LitElement, nothing } from "lit";
import { api, type Conversation, type ShipView } from "../api.ts";
import { cardStyles } from "../conversations/styles.ts";
import { base } from "./shared.ts";

export type ShipKind = "ticket" | "pr" | "takeback";

/** What the dialog tells the screen when it is done (so it can reload) or closed (so focus can go back). */
export interface ShipDone {
  kind: ShipKind;
  ticketId?: string;
  pr?: { number: number; url: string };
}

const MAX_ITEMS = 10;
const MAX_SHOWN = 40;

export class IncConvShip extends LitElement {
  static override properties = {
    conv: { attribute: false },
    employee: { attribute: false },
    kind: { type: String },
    ship: { attribute: false },
    view: { state: true },
    confirmBinary: { state: true },
    loading: { state: true },
    loadError: { state: true },
    title: { state: true },
    items: { state: true },
    busy: { state: true },
    failure: { state: true },
    result: { state: true },
  };
  declare conv: Conversation | undefined;
  declare employee: Employee | undefined;
  declare kind: ShipKind;
  /** What shipping said when the dialog opened: the ticket to take the work back from. */
  declare ship: ShipView | undefined;
  /** The owner has looked at the binary files that can't be scanned. */
  declare confirmBinary: boolean;
  declare view: ShipView | undefined;
  declare loading: boolean;
  declare loadError: string;
  declare title: string;
  declare items: string[];
  declare busy: boolean;
  declare failure: string;
  declare result: ShipDone | undefined;
  private loadToken = 0;

  constructor() {
    super();
    this.kind = "ticket";
    this.confirmBinary = false;
    this.loading = true;
    this.loadError = "";
    this.title = "";
    this.items = [];
    this.busy = false;
    this.failure = "";
  }

  static override styles = [
    base,
    cardStyles,
    css`
      :host { display: contents; }
      .backdrop { position: fixed; inset: 0; z-index: 95; background: rgba(0,0,0,0.45); display: grid; place-items: center; padding: 16px; box-sizing: border-box; }
      .panel { width: min(580px, 100%); max-height: min(90dvh, 760px); display: flex; flex-direction: column; background: var(--ground); color: var(--ink);
        border: 1px solid var(--line-strong); border-radius: 20px; box-shadow: 0 24px 64px rgba(0,0,0,0.32); overflow: hidden; }
      header { flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 20px 6px; }
      header h2 { font-size: 22px; line-height: 1.2; }
      .lead { margin: 0; padding: 0 20px 4px; color: var(--ink-2); font-size: 15px; line-height: 1.5; }
      .x { flex: none; width: 44px; height: 44px; margin: -6px -8px 0 0; border-radius: 50%; border: 0; background: transparent; color: var(--ink); display: grid; place-items: center; }
      .x:hover { background: var(--sunken); } .x:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      .x svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
      .body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px 20px 16px; display: flex; flex-direction: column; gap: 14px; }
      section { border: 1px solid var(--line); border-radius: 14px; background: var(--surface); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      h3 { font: 800 12px var(--body); text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink-2); margin: 0; }
      p { margin: 0; font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
      code { font: 12.5px var(--mono); background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; overflow-wrap: anywhere; }
      ul.files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow-y: auto; }
      ul.files li { display: flex; align-items: center; gap: 8px; min-height: 32px; min-width: 0; }
      .p { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12.5px var(--mono); direction: rtl; text-align: left; }
      .p bdi { direction: ltr; }
      .plus { color: var(--diff-add-fg); background: var(--diff-add-bg); border-radius: 4px; padding: 0 5px; font: 700 11.5px var(--mono); }
      .minus { color: var(--diff-del-fg); background: var(--diff-del-bg); border-radius: 4px; padding: 0 5px; font: 700 11.5px var(--mono); }
      .prot { font-size: 11px; font-weight: 800; padding: 1px 6px; border-radius: 6px; background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--needs-edge); }
      .field { display: flex; flex-direction: column; gap: 6px; }
      .field label, .field .lbl { font-size: 13px; font-weight: 700; color: var(--ink-2); }
      input[type="text"] { font: 16px var(--body); color: var(--ink); background: var(--surface); box-sizing: border-box; width: 100%; min-height: 44px; padding: 0 12px;
        border-radius: 10px; border: 1px solid var(--control-edge); }
      input[type="text"]:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      .item { display: flex; gap: 6px; align-items: center; }
      .item .rm { flex: none; width: 44px; height: 44px; border-radius: 50%; border: 0; background: transparent; color: var(--ink-2); display: grid; place-items: center; }
      .item .rm:hover { background: var(--sunken); color: var(--ink); } .item .rm:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      .item .rm svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
      .check { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 15px; font-weight: 600; cursor: pointer; }
      .check input { width: 22px; height: 22px; flex: none; accent-color: var(--ink); }
      .alert { margin: 0; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--alarm); background: var(--banner-bg); color: var(--banner-fg); font-weight: 600; font-size: 14.5px; line-height: 1.45; }
      .notice { margin: 0; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--needs-edge); background: var(--banner-bg); color: var(--banner-fg); font-size: 14.5px; line-height: 1.45; }
      .muted { color: var(--ink-2); }
      footer { flex: none; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; padding: 12px 20px max(16px, env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: var(--ground); }
      .skeleton { display: flex; flex-direction: column; gap: 10px; }
      .skeleton i { display: block; height: 56px; border-radius: 12px; background: var(--sunken); }
      .finished { padding: 8px 20px 16px; display: flex; flex-direction: column; gap: 10px; }
      .finished a { color: var(--reviewing-fg); font-weight: 700; text-underline-offset: 2px; display: inline-flex; align-items: center; min-height: 44px; }
      @media (max-width: 767px) {
        .backdrop { align-items: end; padding: 0; }
        .panel { width: 100%; max-height: 92dvh; border-radius: 22px 22px 0 0; border-bottom: 0; }
        footer .cbtn { flex: 1 1 140px; }
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("keydown", this.onKey, true);
    if (this.kind === "takeback") this.loading = false;
    else void this.load();
  }

  override disconnectedCallback(): void {
    document.removeEventListener("keydown", this.onKey, true);
    this.loadToken++;
    super.disconnectedCallback();
  }

  override updated(changed: Map<string, unknown>): void {
    // The preview arrived: the title is the first thing to edit.
    if (changed.get("loading") === true && !this.loading) this.focusFirst();
  }

  override firstUpdated(): void {
    this.focusFirst();
  }

  private focusables(): HTMLElement[] {
    return [
      ...this.renderRoot.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]',
      ),
    ];
  }

  private focusFirst() {
    const items = this.focusables();
    const field =
      items.find((e) => e instanceof HTMLInputElement) ?? items.find((e) => e.dataset.main !== undefined);
    (field ?? items[0])?.focus({ preventScroll: true });
  }

  private close = () => {
    this.dispatchEvent(new CustomEvent("conv-ship-close", { bubbles: true, composed: true }));
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!this.busy) this.close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = this.focusables();
    if (!items.length) return;
    let active: Element | null = this.shadowRoot?.activeElement ?? document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const at = active ? items.indexOf(active as HTMLElement) : -1;
    const to = at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    e.preventDefault();
    items[to]?.focus();
  };

  // ───────────────────────────── data ─────────────────────────────

  async load(): Promise<void> {
    const conv = this.conv;
    if (!conv) return;
    const token = ++this.loadToken;
    this.loading = true;
    this.loadError = "";
    try {
      const view = await api.ship(conv.id, true);
      if (token !== this.loadToken) return;
      this.view = view;
      this.title = view.suggestion?.title ?? conv.title;
      this.items = view.suggestion?.doneWhen ?? [];
    } catch (e) {
      if (token !== this.loadToken) return;
      this.loadError = e instanceof Error ? e.message : String(e);
    } finally {
      if (token === this.loadToken) this.loading = false;
    }
  }

  private problem(): string {
    const title = this.title.trim();
    if (!title) return "Give it a title.";
    if (title.length > 200) return "The title is too long: 200 characters at most.";
    if (this.kind === "ticket") {
      const items = this.items.map((i) => i.trim()).filter(Boolean);
      if (!items.length) return "Add at least one done-when item: how will you know it works?";
      if (items.length > MAX_ITEMS) return `A ticket has ${MAX_ITEMS} done-when items at most.`;
      if (items.some((i) => i.length > 300)) return "A done-when item is 300 characters at most.";
    }
    return "";
  }

  private submit = async () => {
    const conv = this.conv;
    if (!conv || this.busy) return;
    const why = this.kind === "takeback" ? "" : this.problem();
    if (why) {
      this.failure = why;
      return;
    }
    this.busy = true;
    this.failure = "";
    try {
      const confirm = this.confirmBinary ? { confirmBinary: true } : {};
      if (this.kind === "takeback") {
        await api.takeBack(conv.id);
        this.result = { kind: "takeback" };
      } else if (this.kind === "ticket") {
        const r = await api.makeTicket(conv.id, {
          title: this.title.trim(),
          doneWhen: this.items.map((i) => i.trim()).filter(Boolean),
          ...confirm,
        });
        this.result = { kind: "ticket", ticketId: r.ticket.id };
      } else {
        const r = await api.openPr(conv.id, { title: this.title.trim(), ...confirm });
        this.result = { kind: "pr", pr: { number: r.pr.number, url: r.pr.url } };
      }
      this.dispatchEvent(
        new CustomEvent<ShipDone>("conv-ship-done", { detail: this.result, bubbles: true, composed: true }),
      );
      await this.updateComplete;
      this.focusFirst();
    } catch (e) {
      this.failure = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  };

  // ───────────────────────────── view ─────────────────────────────

  private name(): string {
    return this.employee?.name ?? this.conv?.employeeId ?? "The employee";
  }

  private committed(v: ShipView) {
    const copy = v.copy;
    if (!copy) return nothing;
    const added = copy.files.reduce((n, f) => n + f.added, 0);
    const removed = copy.files.reduce((n, f) => n + f.removed, 0);
    const protectedSet = new Set(copy.protectedPaths);
    // Protected files first, so the ones that wait for the owner are never hidden behind "and N more".
    const ordered = [
      ...copy.files.filter((f) => protectedSet.has(f.path)),
      ...copy.files.filter((f) => !protectedSet.has(f.path)),
    ];
    const shown = ordered.slice(0, MAX_SHOWN);
    return html`<section aria-labelledby="h-what"><h3 id="h-what">What gets committed</h3>
      <p>${
        copy.uncommitted
          ? html`${this.name()}'s ${copy.uncommitted === 1 ? "unsaved change" : `${copy.uncommitted} unsaved changes`} become a commit on <code>${copy.branch}</code>, with a message that names the ${this.kind === "ticket" ? "ticket" : "pull request"}.`
          : html`Everything is already committed on <code>${copy.branch}</code>; nothing new is saved.`
      }</p>
      <p class="muted">${copy.files.length} ${copy.files.length === 1 ? "file differs" : "files differ"} from the project's main:
        <span class="plus">+${added}</span> <span class="minus">−${removed}</span></p>
      <ul class="files" aria-label="Files">${shown.map(
        (f) => html`<li><span class="p" title=${f.path}><bdi>${f.path}</bdi></span>
          ${protectedSet.has(f.path) ? html`<span class="prot" title="A protected path: it waits for you">protected</span>` : nothing}
          ${f.binary ? html`<span class="muted">binary</span>` : html`<span class="plus">+${f.added}</span><span class="minus">−${f.removed}</span>`}</li>`,
      )}${copy.files.length > shown.length ? html`<li class="muted">and ${copy.files.length - shown.length} more</li>` : nothing}</ul>
    </section>
    ${
      copy.binaries?.length
        ? html`<section aria-labelledby="h-bin"><h3 id="h-bin">Binary, not scanned</h3>
          <p>i.inc can't read these files to check them for credentials. Look at them yourself:</p>
          <ul class="files" aria-label="Binary files">${copy.binaries.map((b) => html`<li><span class="p" title=${b.path}><bdi>${b.path}</bdi></span><span class="muted">${Math.max(1, Math.round(b.size / 1024))} KB</span></li>`)}</ul>
          <label class="check"><input type="checkbox" .checked=${this.confirmBinary} ?disabled=${this.busy}
            @change=${(e: Event) => {
              this.confirmBinary = (e.target as HTMLInputElement).checked;
            }} /> <span>I've looked at ${copy.binaries.length === 1 ? "this file" : "these files"}</span></label>
        </section>`
        : nothing
    }`;
  }

  private where(v: ShipView) {
    const branch = v.copy?.branch ?? this.conv?.branch ?? "its branch";
    const ownerMerges = v.mode === "owner-merges";
    const protectedPaths = v.copy?.protectedPaths ?? [];
    if (this.kind === "pr") {
      return html`<section aria-labelledby="h-where"><h3 id="h-where">Where it goes</h3>
        <p><code>${branch}</code> is pushed to GitHub as the i.inc bot, and a <b>draft pull request</b> opens into the project's main branch. Checks run on GitHub and show in the context panel.</p></section>
        <section aria-labelledby="h-you"><h3 id="h-you">What you still do</h3>
        <p>Look at the pull request on GitHub and merge it yourself: only you can. It hasn't been through i.inc's checks and review; to get those first, make this a ticket instead.</p>
        ${protectedPaths.length ? html`<p>It touches protected paths (${protectedPaths.join(", ")}): read those with care.</p>` : nothing}</section>`;
    }
    return html`<section aria-labelledby="h-where"><h3 id="h-where">Where it goes</h3>
        <p>${
          ownerMerges
            ? html`A <b>pull request</b> opens on GitHub from <code>${branch}</code>. i.inc then runs the project's checks, has another employee review it, and marks the pull request ready.`
            : html`<b>Straight to main</b> on GitHub, after i.inc runs the project's checks and another employee reviews it. No pull request in between.`
        }</p>
        <p class="muted">${this.name()} is paused on this conversation's files until the ticket is done, so two agents never change the same copy.</p></section>
      <section aria-labelledby="h-you"><h3 id="h-you">What you still do</h3>
        <p>${
          ownerMerges
            ? "Look at the pull request and merge it when you're happy: only you can merge."
            : protectedPaths.length
              ? `This change touches protected paths (${protectedPaths.join(", ")}): i.inc waits for your OK before anything goes to main.`
              : "Nothing, unless the review finds something it can't settle: then the ticket asks you."
        }</p>
        ${ownerMerges && protectedPaths.length ? html`<p>It touches protected paths (${protectedPaths.join(", ")}): read those with care.</p>` : nothing}</section>`;
  }

  private fields() {
    return html`<section aria-label="Details">
      <div class="field"><label for="ship-title">${this.kind === "ticket" ? "Ticket title" : "Pull request title"}</label>
        <input id="ship-title" type="text" maxlength="200" .value=${this.title} ?disabled=${this.busy}
          @input=${(e: Event) => {
            this.title = (e.target as HTMLInputElement).value;
          }} /></div>
      ${
        this.kind === "ticket"
          ? html`<div class="field" role="group" aria-labelledby="ship-dw"><span class="lbl" id="ship-dw">Done when</span>
              ${this.items.map(
                (
                  it,
                  i,
                ) => html`<div class="item"><input type="text" aria-label="Done when, item ${i + 1}" maxlength="300" .value=${it} ?disabled=${this.busy}
                  @input=${(e: Event) => {
                    const next = [...this.items];
                    next[i] = (e.target as HTMLInputElement).value;
                    this.items = next;
                  }} />
                  <button class="rm" type="button" aria-label="Remove item ${i + 1}" ?disabled=${this.busy || this.items.length < 2}
                    @click=${() => {
                      this.items = this.items.filter((_, j) => j !== i);
                    }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`,
              )}
              <div><button class="cbtn" type="button" ?disabled=${this.busy || this.items.length >= MAX_ITEMS}
                @click=${() => {
                  this.items = [...this.items, ""];
                  void this.updateComplete.then(() => {
                    const inputs = this.renderRoot.querySelectorAll<HTMLInputElement>(".item input");
                    inputs[inputs.length - 1]?.focus();
                  });
                }}>Add an item</button></div></div>`
          : nothing
      }</section>`;
  }

  private finished(r: ShipDone) {
    return html`<div class="finished" role="status">
      ${
        r.kind === "takeback"
          ? html`<p><b>Done.</b> The ticket is ended and the work is yours again. ${this.name()} can change the files, and will be told what happened.</p>`
          : r.kind === "ticket"
            ? html`<p><b>Done.</b> This work is now ticket #${r.ticketId}. ${this.name()} is paused on this conversation's files while it runs; you can follow it here or on the ticket.</p>
            <a href="#/ticket/${r.ticketId}" data-main>Open ticket #${r.ticketId}</a>`
            : html`<p><b>Done.</b> Pull request #${r.pr?.number} is open as a draft. Its checks show in the context panel.</p>
            <a href=${r.pr?.url ?? "#"} target="_blank" rel="noopener" data-main>Open it on GitHub</a>`
      }
    </div>`;
  }

  override render() {
    const conv = this.conv;
    if (!conv) return nothing;
    const ticket = this.kind === "ticket";
    const takeback = this.kind === "takeback";
    const heading = takeback ? "Take the work back" : ticket ? "Make this a ticket" : "Open a pull request";
    const v = this.view;
    const blocked = v ? (ticket ? !v.canTicket : !v.canPr) : false;
    const blockers = v?.copy?.blockers ?? [];
    const needsConfirm = (v?.copy?.binaries?.length ?? 0) > 0 && !this.confirmBinary;
    const stop = blocked || blockers.length > 0 || !!v?.problem;
    const ticketId = this.ship?.ticket?.id ?? this.conv?.ship?.ticket?.id ?? "";
    return html`<div class="backdrop" @click=${(e: Event) => {
      if (e.target === e.currentTarget && !this.busy) this.close();
    }}>
      <div class="panel" role="dialog" aria-modal="true" aria-labelledby="ship-h" aria-busy=${this.loading ? "true" : "false"}>
        <header><h2 id="ship-h">${heading}</h2>
          <button class="x" type="button" aria-label="Close" ?disabled=${this.busy} @click=${this.close}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>
        ${
          this.result
            ? this.finished(this.result)
            : html`
        <p class="lead">${
          takeback
            ? `Ticket #${ticketId} is waiting for you.`
            : ticket
              ? `${this.name()}'s work from "${conv.title}" goes through i.inc's pipeline: checks, a review, then ${v?.mode === "direct" ? "main" : "a pull request for you"}.`
              : `A quick way to get "${conv.title}" onto GitHub for you to look at, without i.inc's review.`
        }</p>
        <div class="body">
          ${
            takeback
              ? html`<section aria-labelledby="h-tb"><h3 id="h-tb">What happens</h3>
                  <p>Ticket #${ticketId} ends as rejected, so nothing more happens to it, and nothing is merged by i.inc. ${this.name()} can change this conversation's files again, and is told what the ticket did.</p>
                  <p class="muted">A pull request already open on GitHub stays open: close it there if you don't want it.</p></section>`
              : this.loading
                ? html`<div class="skeleton" aria-label="Looking at the working copy"><i></i><i></i><i></i></div>`
                : this.loadError
                  ? html`<p class="alert" role="alert">${this.loadError}</p>
                    <div><button class="cbtn" type="button" @click=${() => void this.load()}>Try again</button></div>`
                  : v
                    ? html`
                    ${v.problem ? html`<p class="alert" role="alert">${v.problem}</p><div><button class="cbtn" type="button" @click=${() => void this.load()}>Look again</button></div>` : nothing}
                    ${blocked && v.reason ? html`<p class="notice" role="status">${v.reason}</p>` : nothing}
                    ${blockers.map((b) => html`<p class="alert" role="alert">Can't ship yet: ${b}.</p>`)}
                    ${v.copy ? this.committed(v) : nothing}
                    ${stop ? nothing : html`${this.where(v)}${this.fields()}`}`
                    : nothing
          }
          ${this.failure ? html`<p class="alert" role="alert">${this.failure}</p>` : nothing}
        </div>
        <footer>
          <button class="cbtn" type="button" ?disabled=${this.busy} @click=${this.close}>Cancel</button>
          <button class="cbtn primary" type="button" data-main ?disabled=${this.busy || this.loading || (!takeback && (stop || !v || needsConfirm))} @click=${() => void this.submit()}>${
            takeback
              ? this.busy
                ? "Taking it back…"
                : "Take it back"
              : this.busy
                ? ticket
                  ? "Making the ticket…"
                  : "Opening…"
                : ticket
                  ? "Make the ticket"
                  : "Open the pull request"
          }</button>
        </footer>`
        }
        ${this.result ? html`<footer><button class="cbtn primary" type="button" @click=${this.close}>Close</button></footer>` : nothing}
      </div></div>`;
  }
}

customElements.define("inc-conv-ship", IncConvShip);
