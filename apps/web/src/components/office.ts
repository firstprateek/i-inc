import { css, html } from "lit";
import { type AccountCost, type AccountRateLimit, api, type DeskEntry } from "../api.ts";
import { withResume } from "../time.ts";
import { LAYOUT_BREAKPOINTS, layoutStyles } from "./layout.ts";
import { Loader } from "./loader.ts";
import { avatar, base, projectBadge, stateLabel } from "./shared.ts";

interface Data {
  employees: DeskEntry[];
  accounts?: AccountCost[];
  rateLimits?: Record<string, AccountRateLimit>;
}

export class IncOffice extends Loader<Data> {
  static override properties = { ...Loader.properties, show: { type: String } };
  /** Company → Team shows the floor; Company → Usage shows the account meters. */
  declare show: "floor" | "meters";

  constructor() {
    super();
    this.show = "floor";
  }

  protected async fetch(): Promise<Data> {
    const office = await api.office();
    return {
      employees: office.employees,
      ...(office.accounts ? { accounts: office.accounts } : {}),
      ...(office.rateLimits ? { rateLimits: office.rateLimits } : {}),
    };
  }

  static override styles = [
    base,
    layoutStyles,
    css`
      .wrap { display: flex; gap: var(--layout-gap, 24px); align-items: flex-start; }
      .floor h2 { font-size: 24px; }
      .floor { flex-grow: 1; min-width: 0; background: var(--floor); border-radius: 28px; padding: 20px 22px;
        display: flex; flex-direction: column; gap: 16px; }
      .desks { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; }
      .desk { padding: 16px; display: flex; flex-direction: column; gap: 8px; text-decoration: none; }
      .desk.waiting { background: var(--needs-surface); border: 2px solid var(--needs-edge); padding: 15px; }
      .scene { position: relative; height: 150px; }
      .scene .avatar { position: absolute; left: 0; top: 24px; border: 3px solid var(--surface); }
      .top { position: absolute; left: 0; right: 0; bottom: 0; height: 54px; background: var(--desk);
        border-radius: 12px; border-bottom: 6px solid var(--desk-edge); }
      .screen { position: absolute; right: 0; bottom: 38px; width: 128px; height: 78px; box-sizing: border-box;
        background: var(--screen); border: 3px solid var(--screen-edge); border-radius: 9px; padding: 8px 9px;
        color: var(--screen-text); font-size: 12px; line-height: 1.35; overflow: hidden; }
      .screen.off { background: var(--screen-edge); }
      .row { display: flex; align-items: center; gap: 6px; }
      .name { font-weight: 700; font-size: 18px; }
      .grow { flex-grow: 1; }
      .ticket { font-size: 14px; font-weight: 600; }
      .meta { font-size: 13px; color: var(--ink-2); }
      .empty-note { margin: 0; font-size: 15px; color: var(--ink-2); }
      .empty-note a, .empty-card a { display: inline-flex; align-items: center; min-height: 44px; }
      .empty-card { padding: 18px 20px; display: flex; flex-direction: column; gap: 8px; }
      .empty-card h2 { font-size: 20px; }
      .empty-card p { margin: 0; color: var(--ink-2); }
      .accounts-card { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
      .accounts-list { display: flex; flex-direction: column; gap: 12px; }
      .account-item { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--line); }
      .account-item:first-child { padding-top: 0; border-top: none; }
      .account-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
      .account-name { font-weight: 700; font-size: 14px; }
      .font-small { font-size: 12px; }
      .quota-bars { display: flex; flex-direction: column; gap: 4px; }
      .quota-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: 12px; }
      .quota-label { color: var(--ink-2); font-weight: 600; }
      .quota-bar-track { height: 8px; border-radius: 4px; background: var(--bar-track); overflow: hidden; }
      .quota-bar { height: 100%; border-radius: 4px; background: var(--bar); min-width: 2px; transition: width 0.3s ease; }
      .quota-bar.ok { background: var(--bar-ok); }
      .quota-bar.warn { background: var(--bar-warn); }
      .quota-bar.crit {
        background-color: var(--bar-crit);
        background-image: repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(0, 0, 0, 0.2) 3px, rgba(0, 0, 0, 0.2) 6px);
      }
      .activity-meters .quota-bar { background: var(--bar-spend); }
      .quota-val { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--ink-2); white-space: nowrap; }
      .quota-val.font-small { font-weight: 500; }
      .account-models { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
      .model-tag { font-size: 11px; padding: 1px 6px; border-radius: 6px; background: var(--sunken); color: var(--ink-2); font-family: var(--mono); }
      .activity-meters { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
      .activity-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; gap: 8px; }
      .activity-val { font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
      .name, .ticket, .meta { overflow-wrap: anywhere; }
      @media (max-width: ${LAYOUT_BREAKPOINTS.split - 1}px) { .wrap { flex-direction: column; align-self: stretch; } .wrap > * { width: 100%; box-sizing: border-box; } }
      @media (max-width: 560px) { .floor { padding: 14px; border-radius: 22px; } .desks { gap: 12px; } .accounts-card { padding: 16px; } }
    `,
  ];

  override render() {
    if (this.error) return this.failure("the office");
    if (!this.data)
      return html`<p class="muted">${this.show === "meters" ? "Loading accounts…" : "Loading your team…"}</p>`;
    if (this.show === "meters") {
      const { accounts, rateLimits } = this.data;
      return accounts?.length
        ? html`<div class="layout-page-band meters">${this.accountsSection(accounts, rateLimits)}</div>`
        : html`<div class="card empty-card layout-page-band" role="status">
            <h2>Accounts and quotas</h2>
            <p>No accounts yet. <a href="#/company/settings/engines">Add an engine and account in Settings</a> to see its quota here.</p>
          </div>`;
    }
    const employees = this.data.employees ?? [];
    return html`<div class="wrap layout-wide-content">
      <section class="floor" aria-label="The floor">
        <h2>The floor</h2>
        ${
          employees.length
            ? html`<div class="desks">${employees.map((e) => this.desk(e))}</div>`
            : html`<p class="empty-note">Nobody works here yet. <a href="#/company/team/hiring">Hire your first employee</a>.</p>`
        }
      </section>
    </div>`;
  }

  private accountsSection(accounts: AccountCost[], rateLimits?: Record<string, AccountRateLimit>) {
    const now = Date.now();
    return html`<div class="card accounts-card">
      <h2>Accounts & quotas</h2>
      <div class="accounts-list">
        ${accounts.map((a) => {
          const rl = rateLimits?.[a.id];
          const isRejected = rl?.status === "rejected" && (!rl.resetsAt || rl.resetsAt > now);
          const isAllowed = rl?.status === "allowed";
          const status = isRejected ? "rejected" : isAllowed ? "allowed" : null;
          const statusTone = isRejected ? "alarm" : "done";

          const rawU5 = rl?.fiveHourUtilization;
          const u5 =
            rawU5 !== undefined && rawU5 !== null
              ? Math.min(100, Math.max(0, Math.round(rawU5 * 100)))
              : null;
          const rawU7 = rl?.sevenDayUtilization;
          const u7 =
            rawU7 !== undefined && rawU7 !== null
              ? Math.min(100, Math.max(0, Math.round(rawU7 * 100)))
              : null;
          const health5 = u5 !== null ? (u5 >= 95 ? "crit" : u5 >= 80 ? "warn" : "ok") : "";
          const health7 = u7 !== null ? (u7 >= 95 ? "crit" : u7 >= 80 ? "warn" : "ok") : "";

          const s5 = a.fiveHourSessions ?? 0;
          const s7 = a.sevenDaySessions ?? 0;
          const m5 = a.fiveHourMinutes ?? 0;
          const m7 = a.sevenDayMinutes ?? 0;
          const bar5 = Math.min(100, Math.max(0, Math.round((m5 / 300) * 100)));
          const bar7 = Math.min(100, Math.max(0, Math.round((m7 / (7 * 24 * 60)) * 100)));
          const s5Text = `${s5} ${s5 === 1 ? "session" : "sessions"}${a.fiveHourMinutes !== undefined ? ` · ${a.fiveHourMinutes}m active` : ""}`;
          const s7Text = `${s7} ${s7 === 1 ? "session" : "sessions"}${a.sevenDayMinutes !== undefined ? ` · ${a.sevenDayMinutes}m active` : ""}`;

          return html`<div class="account-item">
            <div class="account-header">
              <span class="account-name">${a.name}</span>
              ${a.monthlyCap !== undefined ? html`<span class="muted font-small">Cap: $${a.monthlyCap}</span>` : ""}
              ${status ? html`<span class="chip ${statusTone}">${status}</span>` : ""}
            </div>
            ${a.models?.length ? html`<div class="account-models">${a.models.map((m) => html`<span class="model-tag">${m}</span>`)}</div>` : ""}
            ${
              rl && (u5 !== null || u7 !== null)
                ? html`<div class="quota-bars">
                  <div class="quota-row">
                    <span class="quota-label">5h</span>
                    <div class="quota-bar-track" role="meter" aria-label="5-hour utilization" aria-valuenow="${u5 ?? 0}" aria-valuemin="0" aria-valuemax="100" aria-valuetext="${health5.toUpperCase()}: ${u5 ?? 0}%">
                      <div class="quota-bar ${health5}" style="width: ${u5 ?? 0}%"></div>
                    </div>
                    <span class="quota-val">${u5 !== null ? `${u5}%` : "—"}</span>
                  </div>
                  <div class="quota-row">
                    <span class="quota-label">7d</span>
                    <div class="quota-bar-track" role="meter" aria-label="7-day utilization" aria-valuenow="${u7 ?? 0}" aria-valuemin="0" aria-valuemax="100" aria-valuetext="${health7.toUpperCase()}: ${u7 ?? 0}%">
                      <div class="quota-bar ${health7}" style="width: ${u7 ?? 0}%"></div>
                    </div>
                    <span class="quota-val">${u7 !== null ? `${u7}%` : "—"}</span>
                  </div>
                </div>`
                : (a.fiveHourSessions !== undefined || a.sevenDaySessions !== undefined)
                  ? html`<div class="quota-bars activity-meters">
                    <div class="quota-row">
                      <span class="quota-label">5h</span>
                      <div class="quota-bar-track" role="meter" aria-label="5-hour activity" aria-valuenow="${bar5}" aria-valuemin="0" aria-valuemax="100">
                        <div class="quota-bar" style="width: ${bar5}%"></div>
                      </div>
                      <span class="quota-val font-small">${s5Text}</span>
                    </div>
                    <div class="quota-row">
                      <span class="quota-label">7d</span>
                      <div class="quota-bar-track" role="meter" aria-label="7-day activity" aria-valuenow="${bar7}" aria-valuemin="0" aria-valuemax="100">
                        <div class="quota-bar" style="width: ${bar7}%"></div>
                      </div>
                      <span class="quota-val font-small">${s7Text}</span>
                    </div>
                  </div>`
                  : ""
            }
          </div>`;
        })}
      </div>
    </div>`;
  }

  private desk(e: DeskEntry) {
    const [label, tone] = stateLabel[e.state] ?? ["Idle", ""];
    const needs = e.state === "needs-you";
    const off = e.state === "off" || e.state === "idle";
    const href = e.ticket ? `#/ticket/${e.ticket.id}` : "#/work/board";
    return html`<a class="card desk ${needs ? "waiting" : ""}" href=${href} aria-label="${e.name}: ${label}">
      <div class="scene" aria-hidden="true">
        ${e.state === "off" ? "" : avatar(e, 52)}
        <div class="top"></div>
        <div class="screen ${off ? "off" : ""}">${off ? "" : e.ticket ? withResume(e.ticket.live, e.ticket.resumesAt) : ""}</div>
      </div>
      <div class="row"><span class="name">${e.name}</span><span class="grow"></span><span class="chip ${tone}">${label}</span></div>
      <div class="ticket">${e.ticket ? html`#${e.ticket.id} ${e.ticket.title} · ${projectBadge(e.ticket.project)}` : "No ticket right now"}</div>
      <div class="meta">${e.role} · ${e.engine}</div>
    </a>`;
  }
}

customElements.define("inc-office", IncOffice);
