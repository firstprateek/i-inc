// One ticket: the report or the question waiting for you, the actions that fit its state, and the
// timeline from its event log (spec §6, §10).
import { css, html } from "lit";
import { api, refreshNow, type TicketEvent, type TicketView } from "../api.ts";
import { Loader } from "./loader.ts";
import "./transcript.ts";
import { layoutStyles } from "./layout.ts";
import { base, check, projectBadge } from "./shared.ts";

interface Data {
  ticket: TicketView;
  events: TicketEvent[];
}

export class IncTicket extends Loader<Data> {
  static override properties = {
    ...Loader.properties,
    ticketId: {},
    busy: { state: true },
    note: { state: true },
  };
  declare ticketId: string;
  declare busy: boolean;
  declare note: string;

  constructor() {
    super();
    this.ticketId = "";
    this.busy = false;
    this.note = "";
  }

  protected fetch = () => api.ticket(this.ticketId);

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("ticketId") && changed.get("ticketId") !== undefined) void this.reload();
  }

  private async act(fn: () => Promise<unknown>) {
    this.busy = true;
    try {
      await fn();
      this.note = "";
      refreshNow();
      this.dispatchEvent(new CustomEvent("changed", { bubbles: true, composed: true }));
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  static override styles = [
    base,
    layoutStyles,
    css`
      .wrap { display: flex; flex-direction: column; gap: var(--layout-section-gap, 20px); align-items: stretch; }
      .main { flex-grow: 1; min-width: 0; padding: 26px 30px; display: flex; flex-direction: column; gap: 18px; }
      .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      h2 { font-size: 24px; letter-spacing: -0.4px; overflow-wrap: anywhere; }
      dd, ol li span, .ask code { overflow-wrap: anywhere; }
      dl { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 12px 20px; margin: 0; font-size: 15px; line-height: 1.5; }
      dt { font-weight: 700; color: var(--ink-2); }
      dd { margin: 0; }
      .ask { background: var(--needs-surface); border: 2px solid var(--needs-edge); border-radius: 16px; padding: 16px 18px;
        display: flex; flex-direction: column; gap: 12px; }
      .ask pre, .ask p { margin: 0; white-space: pre-wrap; font: 14px/1.5 var(--body); }
      .ask ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; font: 14px/1.5 var(--body); }
      .ask code { font-family: var(--mono); font-size: 13px; }
      .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      textarea { font: 16px var(--body); padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line-strong);
        background: var(--surface); color: var(--ink); min-height: 44px; flex-grow: 1; min-width: 220px; }
      aside { width: auto; padding: 22px 24px; display: flex; flex-direction: column; gap: 12px; }
      ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
      ol li { display: grid; grid-template-columns: 48px 12px minmax(0, 1fr); gap: 10px; font-size: 14px; }
      ol li span { overflow-wrap: anywhere; }
      ol li time { font-size: 13px; color: var(--ink-2); }
      ol li i { width: 10px; height: 10px; border-radius: 50%; margin-top: 5px; background: var(--ink); }
      ol li i.bad { background: var(--alarm); }
      ol li i.rev { background: var(--reviewing-mark); }
      ol li i.you { background: var(--needs-edge); }
      .shots { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px; }
      .shots a { display: block; width: 112px; height: 112px; border-radius: 12px; overflow: hidden; border: 1px solid var(--line); }
      .shots img { width: 100%; height: 100%; object-fit: cover; display: block; }
      @media (max-width: 600px) {
        h2 { font-size: 22px; }
        .shots a { width: 96px; height: 96px; }
        .main { padding: 18px; }
        aside { padding: 18px; }
        dl { grid-template-columns: 1fr; gap: 2px 0; }
        dd { margin-bottom: 10px; }
        /* Answers are thumb-sized and full width, with the note box above its button. */
        .actions { flex-direction: column; align-items: stretch; }
        .actions .btn { width: 100%; white-space: normal; }
        textarea { min-width: 0; min-height: 88px; }
      }
    `,
  ];

  override render() {
    if (this.error && !this.data) return html`<p role="alert">${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Loading the ticket…</p>`;
    const { ticket: t, events } = this.data;
    return html`<div class="wrap">
      <section class="card main">
        <div class="row">
          <span class="tag">${t.type}</span>${projectBadge(t.project)}<span class="tag">${t.effort}</span>
          <span class="muted" style="font-size:13px;font-weight:700">#${t.id}</span>
        </div>
        <h2>${t.title}</h2>
        ${this.images(t)}
        ${this.error ? html`<p role="alert">${this.error}</p>` : ""}
        ${this.body(t)}
        <inc-transcript .ticketId=${t.id}></inc-transcript>
      </section>
      <aside class="card" aria-label="Timeline">
        <h2>Timeline</h2>
        <ol>${events.map((e) => this.line(e)).filter((x) => x !== null)}</ol>
      </aside>
    </div>`;
  }

  /** The owner's images, each opening at full size. */
  private images(t: TicketView) {
    if (!t.attachments?.length) return "";
    return html`<ul class="shots" aria-label="Images from the owner">
      ${t.attachments.map(
        (a) => html`<li><a href=${a.url} target="_blank" rel="noopener" aria-label="Open ${a.name}">
          <img src=${a.url} alt=${a.name} loading="lazy" /></a></li>`,
      )}
    </ul>`;
  }

  private body(t: TicketView) {
    const id = t.id;
    if (t.status === "needs-you" && t.needsYou) {
      const ask = t.needsYou;
      switch (ask.kind) {
        case "plan-gate":
          return html`<div class="ask"><b>The plan waits at the gate</b><pre>${ask.plan}</pre>
            <div class="actions">
              <button type="button" class="btn" ?disabled=${this.busy} @click=${() => this.act(() => api.answer(id, "approve"))}>Approve plan</button>
              <button type="button" class="btn ghost" ?disabled=${this.busy} @click=${() => this.act(() => api.answer(id, "reject"))}>Reject</button>
            </div></div>`;
        case "disagreement":
          return html`<div class="ask"><b>The builder and reviewer disagree</b>
            <dl><dt>Builder</dt><dd>${ask.builder}</dd><dt>Reviewer</dt><dd>${ask.reviewer}</dd></dl>
            <div class="actions">
              <button type="button" class="btn ghost" ?disabled=${this.busy} @click=${() => this.act(() => api.answer(id, "builder"))}>Side with the builder</button>
              <button type="button" class="btn ghost" ?disabled=${this.busy} @click=${() => this.act(() => api.answer(id, "reviewer"))}>Side with the reviewer</button>
            </div></div>`;
        case "proposals":
          return html`<div class="ask"><b>${ask.items.length} proposals wait for you</b>
            <ul>${ask.items.map((p) => html`<li>${p.summary}${p.to?.length ? html` <span class="muted">to ${p.to.join(", ")}</span>` : ""}</li>`)}</ul>
            <div class="actions">
              <button type="button" class="btn" ?disabled=${this.busy} @click=${() => this.act(() => api.answer(id, "approve"))}>Approve all</button>
              <button type="button" class="btn ghost" ?disabled=${this.busy} @click=${() => this.act(() => api.answer(id, "reject"))}>Decline</button>
            </div></div>`;
        case "stuck":
          return html`<div class="ask"><b>Stuck</b><p>${ask.reason}</p></div>`;
        case "protected-paths":
          return html`<div class="ask"><b>This change touches protected paths</b>
            <ul>${ask.paths.map((p) => html`<li><code>${p}</code></li>`)}</ul>
            <p class="muted">It was reviewed, and reaches main once you OK it. GitHub only takes workflow changes from you: run <code>tools/host/push-for-owner.sh</code> first, then OK it.</p>
            <div class="actions">
              <button type="button" class="btn" ?disabled=${this.busy} @click=${() => this.act(() => api.answer(id, "approve"))}>OK it</button>
              <button type="button" class="btn ghost" ?disabled=${this.busy} @click=${() => this.act(() => api.answer(id, "reject"))}>Decline</button>
            </div></div>`;
      }
    }
    if (t.status === "ready" && t.report) {
      const r = t.report;
      return html`
        <div class="row"><span class="chip">${check} ${r.checks}</span><span class="muted" style="font-size:14px">${r.byline} · ${r.minutes} min</span></div>
        ${r.engines ? html`<div class="muted" style="font-size:14px">${r.engines}</div>` : ""}
        <dl><dt>What changed</dt><dd>${r.judgment || "The builder's draft is empty."}</dd></dl>
        <div class="actions">
          <button type="button" class="btn" ?disabled=${this.busy} @click=${() => this.act(() => api.decide(id, "approve"))}>Approve and merge</button>
          <textarea aria-label="What to change" placeholder="What should change?" .value=${this.note}
            @input=${(e: InputEvent) => {
              this.note = (e.target as HTMLTextAreaElement).value;
            }}></textarea>
          <button type="button" class="btn ghost" ?disabled=${this.busy || !this.note.trim()}
            @click=${() => this.act(() => api.decide(id, "changes", this.note))}>Request changes</button>
          <button type="button" class="btn ghost" ?disabled=${this.busy} @click=${() => this.act(() => api.decide(id, "reject"))}>Reject</button>
        </div>`;
    }
    if (t.status === "failed") {
      return html`<div class="ask"><b>An honest failure${t.failure ? ` in ${t.failure.stage}` : ""}</b><p>${t.failure?.reason ?? "Failed"}</p>
        ${t.failure?.tried?.length ? html`<p class="muted">Tried: ${t.failure.tried.join(", ")}</p>` : ""}
        <div class="actions">
          <button type="button" class="btn" ?disabled=${this.busy} @click=${() => this.act(() => api.retry(id))}>Retry ticket</button>
        </div></div>`;
    }
    if (t.status === "done") return html`<p><span class="chip done">${t.outcome}</span></p>`;
    return html`<p class="muted">${t.waiting ?? (t.status === "queued" ? "Queued" : t.live)}</p>`;
  }

  private line(e: TicketEvent) {
    const time = new Date(e.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const item = (text: unknown, dot = "") =>
      html`<li><time>${time}</time><i class=${dot}></i><span>${text}</span></li>`;
    switch (e.type) {
      case "stage-started":
        return item(html`<b>${e.stage}</b> started`);
      case "checks-ran":
        return e.green ? item("Checks green") : item(`Checks: ${e.failures.length} failing`, "bad");
      case "out-of-tokens":
        return item("Out of tokens: a coffee break", "you");
      case "engine-switched":
        return item(`Switched engine: ${e.reason}`, "bad");
      case "review-verdict":
        return item(
          e.approved
            ? `Review round ${e.round}: approved`
            : `Review round ${e.round}: ${e.findings.length} findings`,
          "rev",
        );
      case "proof":
        return item(`Proof: ${e.items.filter((i) => i.pass).length} of ${e.items.length} done-when items`);
      case "gates-ran":
        return e.ok ? item("Final gates passed") : item(`Gates: ${e.reason ?? "failed"}`, "bad");
      case "needs-you":
        return item("Waiting for you", "you");
      case "owner-answered":
        return item(`You answered: ${e.answer}`);
      case "report-ready":
        return item(html`<b>Report ready</b>`);
      case "owner-decided":
        return item(`You decided: ${e.decision}`);
      case "reassigned":
        return item(`Handed from ${e.from} to ${e.to}`);
      case "failed":
        return item(`Failed: ${e.reason}`, "bad");
      case "closed":
        return item(html`<b>${e.outcome}</b>`);
      default:
        return null;
    }
  }
}

customElements.define("inc-ticket", IncTicket);
