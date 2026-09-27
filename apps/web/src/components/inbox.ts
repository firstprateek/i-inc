// The phone inbox (spec §10): what needs you and what's ready, each answerable in one tap.
import { css, html } from "lit";
import { api, refreshNow, type TicketView } from "../api.ts";
import { Loader } from "./loader.ts";
import { avatar, base } from "./shared.ts";

export class IncInbox extends Loader<TicketView[]> {
  protected fetch = () => api.board();

  private async act(fn: () => Promise<unknown>) {
    try {
      await fn();
      refreshNow();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  static override styles = [
    base,
    css`
      :host { max-width: 560px; }
      h1 { font-size: 30px; margin: 4px 0 14px; }
      .list { display: flex; flex-direction: column; gap: 12px; }
      .item { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
      .item.waiting { background: var(--needs-surface); border: 2px solid var(--needs-edge); padding: 13px 15px; }
      .who { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); }
      .who b { color: var(--ink); }
      .q { font-size: 17px; font-weight: 700; line-height: 1.3; }
      .actions { display: flex; gap: 8px; }
      .actions .btn:first-child { flex-grow: 1; }
      h2 { font-size: 20px; margin-top: 18px; }
      .empty { color: var(--ink-2); }
    `,
  ];

  override render() {
    if (this.error) return html`<p role="alert">${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Loading your inbox…</p>`;
    const needs = this.data.filter((t) => t.status === "needs-you");
    const ready = this.data.filter((t) => t.status === "ready");
    const n = needs.length;
    return html`
      <h1>${n ? `${n} ${n === 1 ? "thing needs" : "things need"} you` : "Nothing needs you"}</h1>
      <div class="list">${needs.map((t) => this.ask(t))}</div>
      ${ready.length ? html`<h2>Ready for you</h2><div class="list">${ready.map((t) => this.ready(t))}</div>` : ""}
      ${!n && !ready.length ? html`<p class="empty">The team is working. Reports will land here.</p>` : ""}
    `;
  }

  private header(t: TicketView, what: string) {
    return html`<div class="who">${t.assignee ? avatar(t.assignee.id, t.assignee.name, 28) : ""}
      <span><b>${t.assignee?.name ?? "Unassigned"}</b> · ${what} · ${t.project}</span></div>`;
  }

  private ask(t: TicketView) {
    const a = t.needsYou;
    if (!a) return "";
    const btn = (label: string, fn: () => Promise<unknown>, ghost = false) =>
      html`<button class="btn ${ghost ? "ghost" : ""}" @click=${() => this.act(fn)}>${label}</button>`;
    const body =
      a.kind === "plan-gate"
        ? html`<div class="q">The plan for “${t.title}” waits at the gate.</div>
            <div class="actions">${btn("Approve plan", () => api.answer(t.id, "approve"))}
              <a class="btn ghost" href="#/ticket/${t.id}" style="display:inline-flex;align-items:center;text-decoration:none">Read it</a></div>`
        : a.kind === "disagreement"
          ? html`<div class="q">The builder and reviewer disagree on “${t.title}”.</div>
              <div class="actions"><a class="btn" href="#/ticket/${t.id}" style="display:inline-flex;align-items:center;justify-content:center;text-decoration:none">See both sides</a></div>`
          : a.kind === "proposals"
            ? html`<div class="q">${a.items.length} ${a.items.length === 1 ? "proposal waits" : "proposals wait"} for you.</div>
                <div class="actions">${btn("Approve all", () => api.answer(t.id, "approve"))}${btn("Decline", () => api.answer(t.id, "reject"), true)}</div>`
            : html`<div class="q">${a.reason}</div>`;
    return html`<div class="card item waiting">${this.header(t, a.kind.replace("-", " "))}${body}</div>`;
  }

  private ready(t: TicketView) {
    return html`<div class="card item">${this.header(t, "report")}
      <div class="q">${t.title}</div>
      <div class="actions">
        <button class="btn" @click=${() => this.act(() => api.decide(t.id, "approve"))}>Approve</button>
        <a class="btn ghost" href="#/ticket/${t.id}" style="display:inline-flex;align-items:center;text-decoration:none">Report</a>
      </div></div>`;
  }
}

customElements.define("inc-inbox", IncInbox);
