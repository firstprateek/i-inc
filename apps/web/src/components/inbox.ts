// Work → Needs you (spec §10): what needs you and what's ready, each answerable in one tap.
import { css, html } from "lit";
import {
  api,
  type Conversation,
  type PolicyProposal,
  type ProposalView,
  refreshNow,
  type TicketView,
} from "../api.ts";
import { waitingLine, waitsForAssignee } from "../assign.ts";
import { visible } from "../conversations/model.ts";
import { needsYouCount, waitingConversations } from "../needs-you.ts";
import { layoutStyles } from "./layout.ts";
import { Loader } from "./loader.ts";
import "./proposals.ts";
import { protectedOk } from "./protected-card.ts";
import { avatar, base, projectBadge } from "./shared.ts";

export class IncInbox extends Loader<{
  tickets: TicketView[];
  policies: PolicyProposal[];
  proposals: ProposalView[];
  conversations: Conversation[];
  names: Record<string, string>;
}> {
  protected fetch = async () => {
    const conversations = await waitingConversations();
    return {
      tickets: await api.board(),
      policies: (await api.handbook()).awaiting ?? [],
      proposals: await api.proposals(),
      conversations,
      names: conversations.length
        ? Object.fromEntries((await api.employees().catch(() => [])).map((e) => [e.id, e.name]))
        : {},
    };
  };

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
    layoutStyles,
    css`
      :host { width: 100%; min-width: 0; display: block; }
      .summary { margin: 0 0 14px; font-size: 17px; font-weight: 700; }
      .list { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
      .item { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; box-sizing: border-box; }
      .item.waiting { background: var(--needs-surface); border: 2px solid var(--needs-edge); padding: 13px 15px; }
      .who { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); min-width: 0; max-width: 100%; flex-wrap: wrap; }
      .who b { color: var(--ink); }
      .who span { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; max-width: 100%; }
      .waits { margin: 0; display: flex; align-items: flex-start; gap: 8px; font-size: 14px; line-height: 1.4; color: var(--ink-2); overflow-wrap: anywhere; }
      .waits i { width: 8px; height: 8px; border-radius: 50%; background: var(--needs-fg); flex-shrink: 0; margin-top: 6px; }
      .actions a.btn { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; box-sizing: border-box; }
      .q { font-size: 17px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; min-width: 0; }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .actions .btn:first-child { flex-grow: 1; }
      h2 { font-size: 20px; margin-top: 18px; }
      .proposed { margin-top: 14px; }
      .clear { padding: 28px 20px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; margin-top: 4px; }
      .clear .badge { width: 56px; height: 56px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
        background: var(--working-bg); color: var(--working-fg); margin-bottom: 6px; }
      .clear .badge svg { width: 28px; height: 28px; display: block; }
      .clear h2 { font-size: 22px; margin: 0; }
      .clear p { margin: 0; color: var(--ink-2); font-size: 15px; line-height: 1.4; max-width: 34ch; }
      .clear .links { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 12px; width: 100%; }
      .clear .links .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; box-sizing: border-box; text-decoration: none; }
    `,
  ];

  override render() {
    if (this.error) return html`<p role="alert">${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Loading what needs you…</p>`;
    const needs = this.data.tickets.filter((t) => t.status === "needs-you");
    const ready = this.data.tickets.filter((t) => t.status === "ready");
    const policies = this.data.policies;
    // A ticket nobody can start until the owner picks someone is the owner's to fix.
    const unassigned = this.data.tickets.filter(waitsForAssignee);
    const proposals = this.data.proposals;
    const conversations = this.data.conversations;
    const n = needsYouCount(this.data.tickets, policies, proposals, conversations);
    return html`
      <p class="summary">${n ? `${n} ${n === 1 ? "thing needs" : "things need"} you` : "Nothing needs you"}</p>
      <div class="list">${conversations.map((c) => this.conversation(c))}${needs.map((t) => this.ask(t))}${unassigned.map((t) => this.unassigned(t))}${policies.map((p) => this.policy(p))}</div>
      ${proposals.length ? html`<inc-proposals class="proposed" .proposals=${proposals}></inc-proposals>` : ""}
      ${ready.length ? html`<h2>Ready for you</h2><div class="list">${ready.map((t) => this.ready(t))}</div>` : ""}
      ${!n && !ready.length ? this.allClear() : ""}
    `;
  }

  private allClear() {
    return html`<div class="card clear" role="status">
      <span class="badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
      <h2>All clear</h2>
      <p>Nothing needs your answer. Tickets that do will show up here.</p>
      <div class="links">
        <a class="btn" href="#/work/board">Go to the board</a>
        <a class="btn ghost" href="#/conversations">Start a conversation</a>
      </div></div>`;
  }

  private header(t: TicketView, what: string) {
    return html`<div class="who">${t.assignee ? avatar(t.assignee, 28) : ""}
      <span><b>${t.assignee?.name ?? "Unassigned"}</b> · ${what} · ${projectBadge(t.project)}</span></div>
      ${this.wait(t)}`;
  }

  /** Why the ticket isn't running, in plain words. */
  private wait(t: TicketView) {
    return t.waiting
      ? html`<p class="waits"><i aria-hidden="true"></i><span>${waitingLine(t.waiting, t.waitingUntil)}</span></p>`
      : "";
  }

  private unassigned(t: TicketView) {
    return html`<div class="card item waiting">
      <div class="who"><span><b>#${t.id}</b> · not started · ${projectBadge(t.project)}</span></div>
      <div class="q">${t.title}</div>
      ${this.wait(t)}
      <div class="actions">
        <a class="btn" href="#/ticket/${t.id}/assign" aria-label="Assign ticket #${t.id}: ${t.title}">Assign…</a>
        <a class="btn ghost" href="#/ticket/${t.id}">Open</a>
      </div></div>`;
  }

  private ask(t: TicketView) {
    const a = t.needsYou;
    if (!a) return "";
    const btn = (label: string, fn: () => Promise<unknown>, ghost = false) =>
      html`<button type="button" class="btn ${ghost ? "ghost" : ""}" @click=${() => this.act(fn)}>${label}</button>`;
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
            : a.kind === "protected-paths"
              ? protectedOk(t, a.paths, (fn) => void this.act(fn))
              : html`<div class="q">${a.reason}</div>`;
    return html`<div class="card item waiting">${this.header(t, a.kind.replace("-", " "))}${body}</div>`;
  }

  /** A conversation whose agent waits for a permission or an answer; it opens at that card. */
  private conversation(c: Conversation) {
    const who = this.data?.names[c.employeeId] ?? c.employeeId;
    return html`<div class="card item waiting">
      <div class="who"><span><b>${who}</b> · conversation${c.project ? html` · ${projectBadge(c.project)}` : ""}</span></div>
      <div class="q">${visible(c.title, true)}</div>
      <p class="waits"><i aria-hidden="true"></i><span>${who} is waiting for your permission or an answer.</span></p>
      <div class="actions"><a class="btn" href="#/conversations/${c.id}" aria-label="Open the conversation: ${visible(c.title, true)}">Open the card</a></div></div>`;
  }

  private policy(p: PolicyProposal) {
    return html`<div class="card item waiting">
      <div class="who"><span><b>${p.author}</b> · handbook policy · ${p.page}</span></div>
      <div class="q">${p.text}</div>
      <div class="actions">
        <button type="button" class="btn" @click=${() => this.act(() => api.decidePolicy(p.id, true))}>Approve</button>
        <button type="button" class="btn ghost" @click=${() => this.act(() => api.decidePolicy(p.id, false))}>Decline</button>
      </div></div>`;
  }

  private ready(t: TicketView) {
    return html`<div class="card item">${this.header(t, "report")}
      <div class="q">${t.title}</div>
      <div class="actions">
        <button type="button" class="btn" @click=${() => this.act(() => api.decide(t.id, "approve"))}>Approve</button>
        <a class="btn ghost" href="#/ticket/${t.id}" style="display:inline-flex;align-items:center;text-decoration:none">Report</a>
      </div></div>`;
  }
}

customElements.define("inc-inbox", IncInbox);
