import { css, html, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { api, type EmployeeQueueView } from "../api.ts";
import { Loader } from "./loader.ts";
import { base } from "./shared.ts";

export class IncEmployeeQueue extends Loader<EmployeeQueueView> {
  static override properties = {
    ...Loader.properties,
    employeeId: { type: String },
    employeeName: { type: String },
    announcement: { state: true },
  };
  declare employeeId: string;
  declare employeeName: string;
  declare announcement: string;

  constructor() {
    super();
    this.employeeId = "";
    this.employeeName = "";
    this.announcement = "";
  }

  protected override updated(changed: PropertyValues): void {
    if (changed.has("employeeId") && changed.get("employeeId") !== undefined) {
      this.resetLoad();
      this.announcement = "";
      void this.reload();
    }
  }

  protected fetch(): Promise<EmployeeQueueView> {
    return api.employeeQueue(this.employeeId);
  }

  private async move(id: string, direction: -1 | 1): Promise<void> {
    if (this.pressing || !this.data) return;
    const employeeId = this.employeeId;
    const focused = this.shadowRoot?.activeElement as HTMLElement | null;
    const expected = this.data.tickets.map((t) => t.id);
    const index = expected.indexOf(id);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= expected.length) return;
    const before = direction === -1 ? expected[destination] : expected[destination + 1];
    await this.press(async () => {
      try {
        await api.moveQueued(employeeId, id, before ?? null, expected);
        if (this.employeeId === employeeId) {
          this.announcement = `Moved ticket #${id} ${direction === -1 ? "up" : "down"}.`;
          await this.reload();
        }
      } catch (e) {
        // A conflict may mean a ticket just started. Keep the controls in sync before retrying.
        if (this.employeeId === employeeId) await this.reload();
        if (this.employeeId !== employeeId) return false;
        throw e;
      }
      return false;
    });
    await this.updateComplete;
    if (
      this.employeeId === employeeId &&
      focused &&
      (!this.shadowRoot?.activeElement || this.shadowRoot.activeElement === focused) &&
      (document.activeElement === document.body || document.activeElement === this)
    ) {
      if (focused.isConnected) focused.focus();
      else this.shadowRoot?.querySelector<HTMLElement>("h3")?.focus();
    }
  }

  static override styles = [
    base,
    css`
    :host { display: block; }
    h3 { margin: 0; font-size: 20px; }
    p { color: var(--ink-2); }
    ol { list-style: none; padding: 0; margin: 0; }
    li { display: flex; align-items: center; gap: 16px; padding: 12px 0; border-top: 1px solid var(--line); }
    .ticket { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    a { display: inline-flex; align-items: center; min-height: 44px; }
    .meta { color: var(--ink-2); font-size: 14px; }
    .controls { display: flex; gap: 8px; }
    button { min-width: 44px; min-height: 44px; }
    button[aria-disabled="true"] { opacity: .5; cursor: default; }
    .sr { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
    @media (max-width: 560px) { li { align-items: stretch; flex-direction: column; gap: 4px; } }
  `,
  ];

  override render() {
    return html`<section aria-label="${this.employeeName}'s queue">
      <h3 tabindex="-1">${this.employeeName}'s queue</h3>
      <p>Runs from top to bottom. Held tickets are skipped until released.</p>
      ${this.actionNotice()}
      <span class="sr" role="status">${this.announcement}</span>
      ${
        this.error
          ? this.failure("the queue")
          : !this.data
            ? html`<p>Loading queue…</p>`
            : !this.data.tickets.length
              ? html`<p>No waiting tickets.</p>`
              : html`
        <ol>${repeat(
          this.data.tickets,
          (t) => t.id,
          (t, i) => html`
          <li data-ticket=${t.id}>
            <div class="ticket">
              <a href="#/ticket/${t.id}">#${t.id} ${t.title}</a>
              <div class="meta">${t.project}${t.held ? " · Held" : ""}</div>
            </div>
            <div class="controls">
              <button class="btn ghost" aria-label="Move ticket #${t.id} up" aria-disabled=${this.pressing || i === 0} @click=${() => this.move(t.id, -1)}>↑ Up</button>
              <button class="btn ghost" aria-label="Move ticket #${t.id} down" aria-disabled=${this.pressing || i === (this.data?.tickets.length ?? 0) - 1} @click=${() => this.move(t.id, 1)}>↓ Down</button>
            </div>
          </li>`,
        )}</ol>`
      }
    </section>`;
  }
}
customElements.define("inc-employee-queue", IncEmployeeQueue);
