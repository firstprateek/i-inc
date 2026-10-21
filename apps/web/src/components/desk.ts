import { css, html } from "lit";
import { api, type DeskView, type NamedChange, refreshNow } from "../api.ts";
import { describe } from "./knowledge.ts";
import { LAYOUT_BREAKPOINTS, layoutStyles } from "./layout.ts";
import { Loader } from "./loader.ts";
import { base, projectBadge } from "./shared.ts";

const reasons: Record<string, (h: string, n: number) => string> = {
  tokens: (h, n) => `Tickets waited ${h} for tokens (${n} ${n === 1 ? "ticket" : "tickets"})`,
  helper: (h, n) => `Tickets waited ${h} for a free reviewer (${n} ${n === 1 ? "ticket" : "tickets"})`,
  "owner-answer": (h, n) => `Questions waited ${h} for your answer (${n} ${n === 1 ? "ticket" : "tickets"})`,
  "owner-decision": (h, n) =>
    `Ready work waited ${h} for your decision (${n} ${n === 1 ? "ticket" : "tickets"})`,
};

const waitNames: Record<string, string> = {
  tokens: "Tokens",
  helper: "Reviewers",
  "owner-answer": "Your answers",
  "owner-decision": "Your decisions",
};

const hours = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
const money = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

export class IncDesk extends Loader<DeskView & { learned: NamedChange[] }> {
  static override properties = {
    ...Loader.properties,
    cutting: { state: true },
    actionError: { state: true },
    /** Which half of the old desk to show: Company → Usage, or Work → Releases. */
    show: { type: String },
  };
  declare show: "usage" | "releases";
  // The projects whose release cut is in flight. Replaced (not mutated) on each change so Lit re-renders.
  declare cutting: ReadonlySet<string>;
  declare actionError: string | null;

  constructor() {
    super();
    this.show = "usage";
    this.cutting = new Set();
    this.actionError = null;
  }

  protected fetch = async () => ({ ...(await api.desk()), learned: await api.learned() });

  static override styles = [
    base,
    layoutStyles,
    css`
      .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; align-items: start; }
      .hero { grid-column: span 6; background: var(--ink); color: var(--on-ink); border-radius: 20px; padding: 20px 24px;
        display: flex; flex-direction: column; gap: 8px; }
      .hero small { font-weight: 700; opacity: 0.8; }
      .hero h2 { font-size: 26px; }
      .tile { grid-column: span 3; padding: 18px 20px; display: flex; flex-direction: column; gap: 6px; }
      .tile b { font-family: var(--display); font-size: 36px; }
      .tile small, .note { font-size: 13px; color: var(--ink-2); }
      .panel.learned-panel, .panel.releases { grid-column: 1 / -1; }
      .panel { grid-column: span 6; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
      .bars { display: grid; grid-template-columns: 150px minmax(0, 1fr) 64px; gap: 10px; align-items: center; font-size: 13px; }
      .bar { height: 12px; border-radius: 0 4px 4px 0; background: var(--bar); min-width: 2px; }
      .bar.spend-bar { background: var(--bar-spend); }
      .bar.wait-bar { background: var(--bar-warn); }
      .learned { display: flex; flex-direction: column; }
      .learned a { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line);
        text-decoration: none; font-size: 14px; }
      .learned a:first-child { border-top: none; }
      .learned small { color: var(--ink-2); white-space: nowrap; }
      .num { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
      .releases { display: flex; flex-direction: column; gap: 14px; }
      .release-project { display: flex; flex-direction: column; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
      .release-project:last-of-type { border-bottom: none; padding-bottom: 0; }
      .release-project-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .spacer { flex-grow: 1; }
      .release-btn { font-size: 13px; min-height: 44px; padding: 0 16px; box-sizing: border-box; }
      .err { display: flex; align-items: center; gap: 8px; background: var(--banner-bg); color: var(--banner-fg); border: 1px solid var(--alarm);
        border-radius: 10px; padding: 2px 2px 2px 12px; font-size: 14px; }
      .err span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; padding: 8px 0; }
      .err button { flex-shrink: 0; width: 44px; height: 44px; border: 0; border-radius: 8px; background: transparent; color: inherit;
        display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
      .err button:focus-visible { outline: 2px solid var(--reviewing-mark); outline-offset: -2px; }
      .pending-tickets { display: flex; flex-direction: column; gap: 4px; padding-left: 6px; }
      .pending-ticket { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
      .pending-ticket a { text-decoration: none; color: inherit; }
      .font-mono { font-family: var(--mono); }
      .font-small { font-size: 13px; }
      .recent-releases { display: flex; flex-direction: column; gap: 8px; }
      .recent-release { display: flex; flex-direction: column; gap: 4px; padding: 6px 0; border-top: 1px solid var(--line); }
      .recent-release:first-child { border-top: none; }
      .recent-release-header { display: flex; align-items: center; gap: 8px; font-size: 13px; }
      .recent-release-meta { font-size: 12px; }
      .pending-ticket a, .learned a { overflow-wrap: anywhere; }
      @media (max-width: ${LAYOUT_BREAKPOINTS.phone}px) {
        .grid > * { grid-column: 1 / -1 !important; }
        .grid > .tile { grid-column: span 6 !important; }
        .release-btn { min-height: 44px; }
        .pending-ticket { gap: 12px; }
        .pending-ticket a { display: flex; align-items: center; min-height: 44px; flex-grow: 1; }
        .learned a { align-items: center; min-height: 44px; padding: 4px 0; box-sizing: border-box; }
        .learned a span { overflow-wrap: anywhere; }
        .learned small { white-space: normal; text-align: right; flex-shrink: 0; max-width: 40%; }
      }
      @media (max-width: 560px) {
        .grid > .tile { grid-column: 1 / -1 !important; }
        .hero { padding: 18px 20px; }
        .hero h2 { font-size: 24px; }
        .bars { grid-template-columns: minmax(0, 120px) minmax(0, 1fr) 56px; }
      }
    `,
  ];

  private setCutting(projectId: string, on: boolean) {
    const next = new Set(this.cutting);
    if (on) next.add(projectId);
    else next.delete(projectId);
    this.cutting = next;
  }

  private async cutRelease(projectId: string) {
    // A double-tap (or a tap before the re-render disables the button) must not send a second POST.
    if (this.cutting.has(projectId)) return;
    this.setCutting(projectId, true);
    this.actionError = null;
    try {
      await api.cutRelease(projectId);
      refreshNow();
    } catch (err) {
      this.actionError = `Failed to cut release: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.setCutting(projectId, false);
    }
  }

  override render() {
    if (this.error) return html`<p role="alert">The daemon isn't answering: ${this.error}</p>`;
    if (!this.data)
      return html`<p class="muted">Loading ${this.show === "releases" ? "releases" : "usage"}…</p>`;
    const d = this.data;
    const b = d.bottleneck;
    const max = Math.max(...d.spend.lines.map((l) => l.amount), 0.01);
    return html`<div class="grid layout-page-band">
      ${
        this.show === "releases"
          ? ""
          : html`<section class="hero">
        <small>The bottleneck</small>
        <h2>${b ? (reasons[b.reason]?.(hours(b.hours), b.tickets) ?? b.reason) : "Nothing has waited yet"}</h2>
        <span>${d.waits
          .slice(1)
          .map((w) => reasons[w.reason]?.(hours(w.hours), w.tickets))
          .join(" · ")}</span>
      </section>
      <section class="card tile"><small>Spent this month</small><b>${money(d.spend.total)}</b><small>so far</small></section>
      <section class="card tile"><small>Merged PRs</small><b>${d.merged}</b>
        <small>${d.spend.perMergedPR === null ? "none yet" : `${money(d.spend.perMergedPR)} each`}</small></section>
      <section class="card panel">
        <h2>Spend</h2>
        <div class="bars">
          ${d.spend.lines.map(
            (l) => html`<span>${l.name} <span class="muted">${l.kind}</span></span>
              <div class="bar spend-bar" style="width:${Math.round((l.amount / max) * 100)}%" title=${l.basis}></div>
              <span class="num">${money(l.amount)}</span>`,
          )}
        </div>
        <span class="note">Hardware is its price over 36 months. Electricity is idle and busy watts × hours × your rate.</span>
      </section>
      <section class="card panel">
        <h2>Where work waited</h2>
        ${
          d.waits.length
            ? html`<div class="bars">${d.waits.map((w) => {
                const top = Math.max(...d.waits.map((x) => x.hours), 0.01);
                return html`<span>${waitNames[w.reason] ?? w.reason}</span>
                <div class="bar wait-bar" style="width:${Math.round((w.hours / top) * 100)}%"></div><span class="num">${hours(w.hours)}</span>`;
              })}</div>`
            : html`<span class="note">No waits this month.</span>`
        }
      </section>
      <section class="card panel learned-panel">
        <h2>What the team learned</h2>
        ${
          d.learned.length
            ? html`<div class="learned">${d.learned.map(
                (c) => html`<a href="#/company/brain${c.repo === "handbook" ? "" : `/${c.repo?.slice(6)}`}">
                  <span>${describe(c.subject)}${c.reverted ? " (reverted)" : ""}</span>
                  <small>${c.authorName} · ${c.repo === "handbook" ? "handbook" : "own brain"}</small></a>`,
              )}</div>`
            : html`<span class="note">Nothing yet. Lessons arrive at each ticket's retro.</span>`
        }
      </section>`
      }
      ${
        this.show === "releases"
          ? html`<section class="card panel releases">
        <h2>Releases</h2>
        ${
          this.actionError
            ? html`<div class="err" role="alert"><span>${this.actionError}</span>
              <button type="button" aria-label="Dismiss" @click=${() => {
                this.actionError = null;
              }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg></button></div>`
            : ""
        }
        ${
          (d.pendingReleases ?? []).length
            ? (d.pendingReleases ?? []).map((p) => {
                const count = p.pendingTickets.length;
                const key = p.project || p.id;
                const busy = this.cutting.has(key);
                return html`<div class="release-project">
                <div class="release-project-header">
                  ${projectBadge(p.project || p.id)}
                  <span class="muted font-small">${count} unreleased ${count === 1 ? "ticket" : "tickets"}</span>
                  <span class="spacer"></span>
                  <button
                    class="btn ${count ? "" : "ghost"} release-btn"
                    type="button"
                    aria-busy=${busy ? "true" : "false"}
                    ?disabled=${count === 0 || busy}
                    @click=${() => this.cutRelease(key)}
                  >
                    ${busy ? "Cutting…" : "Cut release"}
                  </button>
                </div>
                ${
                  count > 0
                    ? html`<div class="pending-tickets">
                      ${p.pendingTickets.map(
                        (t) => html`<div class="pending-ticket">
                          <a href="#/ticket/${t.id}">#${t.id} ${t.title}</a>
                          ${t.pushed ? html`<small class="muted font-mono">${t.pushed.slice(0, 7)}</small>` : ""}
                        </div>`,
                      )}
                    </div>`
                    : html`<span class="note">Up to date.</span>`
                }
              </div>`;
              })
            : html`<span class="note">No projects yet. <a href="#/company/projects">Add a project</a> to start cutting releases.</span>`
        }
        <h3>Recent releases</h3>
        ${
          (d.releases ?? []).length > 0
            ? html`<div class="recent-releases">
              ${[...(d.releases ?? [])]
                .reverse()
                .slice(0, 5)
                .map(
                  (r) => html`<div class="recent-release">
                  <div class="recent-release-header">
                    <span class="tag font-mono">${r.tag}</span>
                    ${projectBadge(r.project)}
                    <span class="spacer"></span>
                    <small class="muted">${new Date(r.at).toISOString().slice(0, 10)}</small>
                  </div>
                  <div class="recent-release-meta">
                    <small class="muted">${r.ticketIds.length} ${r.ticketIds.length === 1 ? "ticket" : "tickets"} (${r.ticketIds.map((id: string) => `#${id}`).join(", ")})</small>
                  </div>
                </div>`,
                )}
            </div>`
            : html`<span class="note">Nothing released yet. Cut a release once a project has merged tickets.</span>`
        }
      </section>`
          : ""
      }
    </div>`;
  }
}

customElements.define("inc-desk", IncDesk);
