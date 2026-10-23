// The context panel: where this conversation works (project and branch), the agent's plan, the files it
// changed (with diffs), the brain pages it used (when the host says), and usage. Each section hides when it
// has nothing to say, except the first, so the panel is never a wall of empty headings.

import type { Employee } from "@i-inc/core";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { css, html, LitElement, nothing } from "lit";
import { ahp } from "../ahp/hub.ts";
import type { AccountRateLimit, Conversation, ShipView } from "../api.ts";
import {
  brainPages,
  brainScopeLabel,
  type ChangedFile,
  changedFiles,
  latestPlan,
  tokens,
  usageLine,
  usageTotals,
} from "../conversations/model.ts";
import { cardStyles } from "../conversations/styles.ts";
import { base, projectBadge } from "./shared.ts";
import "./conv-diff.ts";
import { app, web } from "../links.ts";

export class IncConvContext extends LitElement {
  static override properties = {
    conv: { attribute: false },
    watch: { attribute: false },
    employee: { attribute: false },
    limit: { attribute: false },
    accountName: { type: String },
    closable: { type: Boolean },
    ship: { attribute: false },
    openFile: { state: true },
    tick: { state: true },
  };
  declare conv: Conversation | undefined;
  /** A ticket stage being watched (T69): the panel shows the stage and what it did, and nothing to ship. */
  declare watch: { ticket: string; stage: string; back: string } | undefined;
  declare employee: Employee | undefined;
  declare limit: AccountRateLimit | undefined;
  declare accountName: string;
  /** Shows a close button (the sheet on a phone, the drawer on a narrow laptop). */
  declare closable: boolean;
  /** What shipping says about this conversation (C22b), loaded by the screen. */
  declare ship: ShipView | undefined;
  declare openFile: string | null;
  declare tick: number;
  private off: (() => void) | undefined;
  private memo: { turns: unknown; active: unknown; files: ChangedFile[] } | undefined;

  constructor() {
    super();
    this.accountName = "";
    this.closable = false;
    this.openFile = null;
    this.tick = 0;
  }

  static override styles = [
    base,
    cardStyles,
    css`
      :host { display: flex; flex-direction: column; min-height: 0; height: 100%; min-width: 0; }
      .bar { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 4px 8px; }
      .bar h2 { font-size: 16px; }
      .x { width: 44px; height: 44px; border-radius: 50%; border: 0; background: transparent; color: var(--ink); cursor: pointer; display: grid; place-items: center; }
      .x:hover { background: var(--sunken); } .x:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      .x svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
      .scroll { flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 12px; padding: 0 2px 12px; }
      section { border: 1px solid var(--line); border-radius: 14px; background: var(--surface); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      h3 { font: 800 12px var(--body); text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink-2); margin: 0; }
      .kv { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
      .kv div { display: flex; justify-content: space-between; gap: 10px; align-items: center; min-width: 0; }
      .kv span:first-child { color: var(--ink-2); flex: none; }
      .kv a { color: var(--reviewing-fg); font-weight: 700; text-underline-offset: 2px; display: inline-flex; align-items: center; min-height: 44px; }
      code { font: 12.5px var(--mono); background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
      ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .plan li { display: flex; gap: 8px; font-size: 14px; line-height: 1.4; }
      .plan .dot { flex: none; width: 16px; height: 16px; margin-top: 2px; border-radius: 50%; border: 2px solid var(--line-strong); display: grid; place-items: center; }
      .plan .completed .dot { background: var(--working-fg); border-color: var(--working-fg); color: var(--ground); }
      .plan .completed .t { color: var(--ink-2); text-decoration: line-through; }
      .plan .in_progress .dot { border-color: var(--reviewing-mark); }
      .plan .in_progress .dot::after { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--reviewing-mark); }
      .plan svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 3.4; stroke-linecap: round; stroke-linejoin: round; }
      .file button { all: unset; box-sizing: border-box; width: 100%; min-height: 44px; display: flex; align-items: center; gap: 8px; cursor: pointer; border-radius: 10px; padding: 0 6px; }
      .file button:hover { background: var(--sunken); }
      .file button:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -2px; }
      .file .p { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12.5px var(--mono); direction: rtl; text-align: left; }
      .file .p bdi { direction: ltr; }
      .plus { color: var(--diff-add-fg); background: var(--diff-add-bg); border-radius: 4px; padding: 0 5px; font: 700 11.5px var(--mono); }
      .minus { color: var(--diff-del-fg); background: var(--diff-del-bg); border-radius: 4px; padding: 0 5px; font: 700 11.5px var(--mono); }
      .meter { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
      .meter .track { height: 8px; border-radius: 4px; background: var(--bar-track); overflow: hidden; }
      .meter .fill { height: 100%; background: var(--bar-ok); }
      .meter .fill.warn { background: var(--bar-warn); } .meter .fill.crit { background: var(--bar-crit); }
      .muted { color: var(--ink-2); font-size: 13.5px; margin: 0; }
      .ship-row { display: flex; flex-direction: column; gap: 2px; font-size: 14px; line-height: 1.4; min-width: 0; }
      .ship-row a { color: var(--reviewing-fg); font-weight: 700; text-underline-offset: 2px; display: inline-flex; align-items: center; min-height: 44px; overflow-wrap: anywhere; }
      .ship-row .sub { color: var(--ink-2); font-size: 13px; }
      .pill { display: inline-block; font-size: 12px; font-weight: 800; padding: 1px 9px; border-radius: 999px; background: var(--neutral-bg); color: var(--neutral-fg); white-space: nowrap; }
      .pill.ok { background: var(--working-bg); color: var(--working-fg); border: 1px solid var(--working-edge); }
      .pill.bad { background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--needs-edge); }
      .ship-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .brain li { font-size: 14px; line-height: 1.4; overflow-wrap: anywhere; }
      .brain a { color: var(--ink); }
      .tag { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--line); color: var(--ink-2); font-size: 11.5px; font-weight: 600; }
      .tag.warn { border-color: var(--alarm); color: var(--alarm-fg); }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    this.off = ahp().onChange((uris) => {
      const c = this.conv;
      if (c && (uris.has(c.ahpChat) || uris.has(c.ahpSession))) this.tick++;
    });
  }
  override disconnectedCallback(): void {
    this.off?.();
    super.disconnectedCallback();
  }

  private files(chat: ChatState | undefined): ChangedFile[] {
    if (this.memo && this.memo.turns === chat?.turns && this.memo.active === chat?.activeTurn)
      return this.memo.files;
    const files = changedFiles(chat);
    this.memo = { turns: chat?.turns, active: chat?.activeTurn, files };
    return files;
  }

  private ask(kind: "ticket" | "pr" | "takeback", e: Event) {
    // The screen opens the dialog; the opener is remembered there so focus can go back to it.
    e.currentTarget?.dispatchEvent(
      new CustomEvent("conv-ship", { detail: { kind, from: "context" }, bubbles: true, composed: true }),
    );
  }

  /** The "Ship this work" section: the ticket and PR it has, and the two ways to send it on. */
  private shipSection(conv: Conversation) {
    if (!conv.project) return nothing;
    const s = this.ship;
    const t =
      s?.ticket ??
      (conv.ship?.ticket
        ? {
            id: conv.ship.ticket.id,
            title: "",
            status: "running" as const,
            stage: null,
            live: "",
            held: conv.ship.ticket.held,
            outcome: null,
          }
        : null);
    const pr =
      s?.pr ??
      (conv.ship?.pr ? { ...conv.ship.pr, state: "unknown" as const, draft: true, checks: null } : null);
    const direct = s?.mode === "direct";
    const canTicket = s ? s.canTicket : !t?.held;
    const canPr = s ? s.canPr : !t?.held;
    const checks = pr?.checks;
    return html`<section aria-labelledby="h-ship"><h3 id="h-ship">Ship this work</h3>
      ${
        t
          ? html`<div class="ship-row"><a href="#/ticket/${t.id}">Ticket #${t.id}${t.title ? `: ${t.title}` : ""}</a>
              <span class="sub"><span class="pill ${t.status === "done" ? "ok" : t.status === "failed" || t.status === "needs-you" ? "bad" : ""}">${this.statusWord(t)}</span>
                ${t.live && !this.statusWord(t).toLowerCase().includes(t.live.toLowerCase()) ? html` ${t.live}` : nothing}</span>
              ${t.held ? html`<span class="sub">It has this conversation's files; the conversation is paused until it is done.</span>` : nothing}
              ${t.canTakeBack ? html`<div class="ship-actions"><button class="cbtn" type="button" @click=${(e: Event) => this.ask("takeback", e)}>Take the work back</button></div>` : nothing}</div>`
          : nothing
      }
      ${
        pr
          ? html`<div class="ship-row"><a href=${web(pr.url)} target="_blank" rel="noopener">Pull request #${pr.number} on GitHub</a>
              <span class="sub"><span class="pill ${pr.state === "merged" ? "ok" : ""}">${pr.state === "open" ? (pr.draft ? "Draft" : "Open") : pr.state === "unknown" ? "Open" : pr.state === "merged" ? "Merged" : "Closed"}</span></span>
              ${
                checks
                  ? html`<span class="sub" role="status"><span class="pill ${checks.state === "success" ? "ok" : checks.state === "failure" ? "bad" : ""}">Checks: ${this.checksWord(checks)}</span></span>`
                  : pr.problem
                    ? html`<span class="sub">${pr.problem}</span>`
                    : html`<span class="sub">No checks have started yet.</span>`
              }</div>`
          : nothing
      }
      ${
        s?.reason && (direct || !canTicket)
          ? html`<p class="muted">${s.reason}</p>`
          : !t && !pr
            ? html`<p class="muted">${direct ? "This project goes to main after a review: make it a ticket." : "Send the work on: a ticket has it checked and reviewed; a PR is the quick way to look at it on GitHub."}</p>`
            : nothing
      }
      <div class="ship-actions">
        <button class="cbtn primary" type="button" aria-disabled=${canTicket ? "false" : "true"} ?disabled=${!canTicket} @click=${(e: Event) => this.ask("ticket", e)}>Make this a ticket</button>
        ${direct ? nothing : html`<button class="cbtn" type="button" aria-disabled=${canPr ? "false" : "true"} ?disabled=${!canPr} @click=${(e: Event) => this.ask("pr", e)}>${pr ? "Update the PR" : "Open a PR"}</button>`}
      </div>
    </section>`;
  }

  private statusWord(t: NonNullable<ShipView["ticket"]>): string {
    if (t.status === "done")
      return t.outcome === "merged" ? "Merged" : t.outcome === "rejected" ? "Rejected" : "Done";
    if (t.status === "failed") return "Failed";
    if (t.status === "needs-you") return "Needs you";
    if (t.status === "ready") return "Ready for you";
    if (t.status === "queued") return "Starting";
    const stage = t.stage ? `${t.stage[0]?.toUpperCase()}${t.stage.slice(1)}` : "";
    return stage ? `Running · ${stage}` : "Running";
  }

  private checksWord(c: NonNullable<NonNullable<ShipView["pr"]>["checks"]>): string {
    if (c.state === "none") return "none yet";
    if (c.state === "success") return `all ${c.total} passed`;
    if (c.state === "failure") return `${c.failed} of ${c.total} failed`;
    return `${c.passed} of ${c.total} passed, ${c.pending} running`;
  }

  private meter(label: string, pct: number | undefined) {
    if (pct === undefined) return nothing;
    const p = Math.max(0, Math.min(100, Math.round(pct * 100)));
    return html`<div class="meter"><span>${label}: ${p}% used</span><div class="track" role="meter" aria-valuenow=${p} aria-valuemin="0" aria-valuemax="100" aria-label="${label} used">
      <div class="fill ${p >= 95 ? "crit" : p >= 80 ? "warn" : ""}" style="width:${p}%"></div></div></div>`;
  }

  override render() {
    const conv = this.conv;
    if (!conv) return nothing;
    const c = ahp();
    const chat = c.chat(conv.ahpChat);
    const session = c.session(conv.ahpSession);
    const plan = latestPlan(chat);
    const files = this.files(chat);
    const brain = brainPages(session, chat);
    const usage = usageTotals(chat);
    const last = chat?.activeTurn?.usage ?? chat?.turns.at(-1)?.usage;
    const done = plan?.filter((e) => e.status === "completed").length ?? 0;
    return html`
      <div class="bar"><h2>Context</h2>${this.closable ? html`<button class="x" type="button" aria-label="Close context" @click=${() => this.dispatchEvent(new CustomEvent("conv-toggle-context", { bubbles: true, composed: true }))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` : nothing}</div>
      <div class="scroll">
        <section aria-labelledby="h-where"><h3 id="h-where">${this.watch ? "This session" : "Where it works"}</h3>
          <div class="kv">
            <div><span>Employee</span><span>${this.employee?.name ?? conv.employeeId}</span></div>
            <div><span>Project</span>${conv.project ? projectBadge(conv.project) : html`<span>None</span>`}</div>
            ${this.watch ? html`<div><span>Ticket</span><a href=${app(this.watch.back)}>#${this.watch.ticket}</a></div><div><span>Stage</span><span>${this.watch.stage}</span></div>` : nothing}
            ${conv.branch && !this.watch ? html`<div><span>Branch</span><code title=${conv.branch}>${conv.branch}</code></div>` : nothing}
            <div><span>Engine</span><span>${conv.engineId}</span></div>
          </div>
          <p class="muted">${this.watch ? "Read-only. This is what the stage did, as it happens; the ticket's own page has the record." : conv.branch ? "A private copy of the project. Nothing here is pushed or merged unless you ask." : "An empty scratch folder."}</p>
        </section>
        ${this.watch ? nothing : this.shipSection(conv)}
        ${
          plan?.length
            ? html`<section class="plan" aria-labelledby="h-plan"><h3 id="h-plan">Plan · ${done} of ${plan.length} done</h3>
          <ul>${plan.map(
            (
              e,
            ) => html`<li class=${e.status}><span class="dot" aria-hidden="true">${e.status === "completed" ? html`<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>` : nothing}</span>
            <span class="t">${e.content}</span><span class="sr-only">${e.status === "completed" ? "done" : e.status === "in_progress" ? "in progress" : "to do"}</span></li>`,
          )}</ul></section>`
            : nothing
        }
        ${
          files.length
            ? html`<section class="file" aria-labelledby="h-files"><h3 id="h-files">Files changed · ${files.length}</h3>
          <ul>${files.map(
            (
              f,
            ) => html`<li><button type="button" aria-expanded=${this.openFile === f.uri ? "true" : "false"} @click=${() => {
              this.openFile = this.openFile === f.uri ? null : f.uri;
            }}><span class="p" title=${f.path}><bdi>${f.path}</bdi></span><span class="plus">+${f.added}</span><span class="minus">−${f.removed}</span></button>
            ${this.openFile === f.uri ? html`<inc-conv-diff .edit=${f.edit}></inc-conv-diff>` : nothing}</li>`,
          )}</ul></section>`
            : nothing
        }
        ${
          brain.length
            ? html`<section aria-labelledby="h-brain"><h3 id="h-brain">Brain pages used</h3>
          <ul class="brain">${brain.map(
            (
              p,
            ) => html`<li>${p.href ? html`<a href=${app(p.href)} title=${p.slug ?? p.title}>${p.title}</a>` : p.title}
              ${p.scope ? html`<span class="tag">${brainScopeLabel(p.scope)}</span>` : nothing}
              ${p.read ? html`<span class="tag">opened</span>` : nothing}
              ${p.untrusted ? html`<span class="tag warn" title="Built from web pages, issues or other people's repos">untrusted</span>` : nothing}</li>`,
          )}</ul></section>`
            : nothing
        }
        <section aria-labelledby="h-usage"><h3 id="h-usage">Usage</h3>
          ${
            usage.turns
              ? html`<div class="kv">
                  <div><span>${this.watch ? "This session" : "This conversation"}</span><span>${tokens(usage.input)} in · ${tokens(usage.output)} out</span></div>
                  ${last ? html`<div><span>Latest turn</span><span>${usageLine(last)}</span></div>` : nothing}
                  ${usage.model ? html`<div><span>Model</span><span>${usage.model}</span></div>` : nothing}
                </div>`
              : html`<p class="muted">${this.watch ? "Token use shows here when the session reports it." : "Token use shows here after the first reply."}</p>`
          }
          ${this.limit ? html`${this.meter(`${this.accountName || "Account"} · 5 hours`, this.limit.fiveHourUtilization)}${this.meter(`${this.accountName || "Account"} · 7 days`, this.limit.sevenDayUtilization)}` : nothing}
        </section>
      </div>`;
  }
}

customElements.define("inc-conv-context", IncConvContext);
