// One ticket: the report or the question waiting for you, the actions that fit its state, and the
// timeline from its event log (spec §6, §10).
import type { Employee } from "@i-inc/core";
import { css, html } from "lit";
import { ApiError, api, imageRules, refreshNow, type TicketEvent, type TicketView } from "../api.ts";
import { assignees, notStarted, optionLabel, waitingLine } from "../assign.ts";
import { ImagePicker, imagePickerStyles } from "./image-picker.ts";
import { Loader } from "./loader.ts";
import "./transcript.ts";
import { layoutStyles } from "./layout.ts";
import { base, check, projectBadge, selectField } from "./shared.ts";

interface Data {
  ticket: TicketView;
  events: TicketEvent[];
  /** Only for a ticket that has not started: who could take it, and the board for who worked here last. */
  employees?: Employee[];
  recent?: TicketView[];
}

export class IncTicket extends Loader<Data> {
  static override properties = {
    ...Loader.properties,
    ticketId: {},
    busy: { state: true },
    note: { state: true },
    pick: { state: true },
    missing: { state: true },
  };
  declare ticketId: string;
  /** The daemon says there is no such ticket. */
  declare missing: boolean;
  declare busy: boolean;
  declare note: string;
  /** The employee chosen in "Who should do this?"; empty until the owner picks, then the default shows. */
  declare pick: string;
  private anchored = false;
  private onHash = () => {
    this.anchored = false;
    this.requestUpdate();
  };
  /** Room left on the ticket for images, after the ones it has. */
  private room = () => imageRules.perTicket - (this.data?.ticket.attachments?.length ?? 0);
  private full = (room: number) =>
    room ? `You can add ${room} more images now.` : `A ticket takes at most ${imageRules.perTicket} images.`;
  /** Images for the ticket as it is, and images with a request for changes. */
  private readonly adding = new ImagePicker(this, { id: "add", room: this.room, full: this.full });
  private readonly reply = new ImagePicker(this, { id: "reply", room: this.room, full: this.full });

  constructor() {
    super();
    this.ticketId = "";
    this.busy = false;
    this.note = "";
    this.pick = "";
    this.missing = false;
  }

  protected fetch = async (): Promise<Data> => {
    let r: Awaited<ReturnType<typeof api.ticket>>;
    try {
      r = await api.ticket(this.ticketId);
      this.missing = false;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) this.missing = true;
      throw e;
    }
    if (!notStarted(r.ticket)) return r;
    // The assign card needs the team and the board; the ticket still shows if they don't load.
    const [employees, recent] = await Promise.all([
      api.employees().catch(() => []),
      api.board().catch(() => []),
    ]);
    return {
      ...r,
      employees: Array.isArray(employees) ? employees : [],
      recent: Array.isArray(recent) ? recent : [],
    };
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("hashchange", this.onHash);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("hashchange", this.onHash);
    super.disconnectedCallback();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("ticketId") && changed.get("ticketId") !== undefined) {
      this.pick = "";
      this.anchored = false;
      this.missing = false;
      void this.reload();
    }
    // "Assign…" on a board card opens #/ticket/<id>/assign: bring the card into view and focus it.
    if (!this.anchored && location.hash.endsWith("/assign")) {
      const card = this.renderRoot.querySelector<HTMLElement>("#assign");
      if (card) {
        this.anchored = true;
        card.scrollIntoView?.({ block: "center" });
        card.querySelector<HTMLElement>("select")?.focus({ preventScroll: true });
      }
    }
  }

  private async act(fn: () => Promise<unknown>) {
    this.busy = true;
    try {
      await fn();
      this.note = "";
      this.adding.clear();
      this.reply.clear();
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
    selectField,
    imagePickerStyles,
    css`
      .wrap { display: flex; flex-direction: column; gap: var(--layout-section-gap, 20px); align-items: stretch; }
      .main { flex-grow: 1; min-width: 0; padding: 26px 30px; display: flex; flex-direction: column; gap: 18px; }
      .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .from { margin: -6px 0 0; font-size: 14px; color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: baseline; overflow-wrap: anywhere; }
      .from a { color: var(--reviewing-fg); font-weight: 600; text-underline-offset: 2px; display: inline-flex; align-items: center; min-height: 44px; }
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
      .waits { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 1.4; color: var(--ink-2); overflow-wrap: anywhere; }
      .waits i { width: 8px; height: 8px; border-radius: 50%; background: var(--needs-fg); flex-shrink: 0; }
      .assign h3 { font-size: 18px; margin: 0; }
      .assign p { margin: 0; font-size: 14px; line-height: 1.45; }
      .assign .pick { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
      .assign label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 700; color: var(--ink-2); flex: 1 1 240px; min-width: 0; }
      .assign .btn:disabled { opacity: 0.6; cursor: default; }
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
      .reply { display: flex; flex-direction: column; gap: 12px; }
      .reply textarea { width: 100%; box-sizing: border-box; min-height: 88px; }
      .problem { margin: 0; font-size: 14px; color: var(--needs-fg); }
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
        .assign .pick { flex-direction: column; align-items: stretch; }
        .assign label { flex: 0 0 auto; }
        .assign .btn { width: 100%; }
        textarea { min-width: 0; min-height: 88px; }
      }
    `,
  ];

  override render() {
    if (this.missing) {
      return html`<section class="card main" role="alert"><h2>There is no ticket #${this.ticketId}</h2>
        <p class="muted">It may have been removed, or the address is wrong.</p>
        <div><a class="btn" href="#/work/board">Back to the board</a></div></section>`;
    }
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
        ${this.fromConversation(t)}
        ${this.images(t)}
        ${t.waiting ? html`<p class="waits"><i aria-hidden="true"></i><span>${waitingLine(t.waiting, t.waitingUntil)}</span></p>` : ""}
        ${this.error ? html`<p role="alert">${this.error}</p>` : ""}
        ${notStarted(t) ? this.assignCard(t) : ""}
        ${this.body(t)}
        ${t.status !== "done" && t.status !== "ready" ? this.addImages(t) : ""}
        <inc-transcript .ticketId=${t.id}></inc-transcript>
      </section>
      <aside class="card" aria-label="Timeline">
        <h2>Timeline</h2>
        <ol>${events.map((e) => this.line(e)).filter((x) => x !== null)}</ol>
      </aside>
    </div>`;
  }

  /** A ticket made from a conversation says so, and links back to it. */
  private fromConversation(t: TicketView) {
    const from = t.fromConversation;
    if (!from) return "";
    return html`<p class="from">From conversation
      ${
        from.title === null
          ? html`<span>(no longer there)</span>`
          : html`<a href="#/conversations/${encodeURIComponent(from.id)}">${from.title}</a>`
      }</p>`;
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

  /** More images for a ticket that isn't done; its builder gets them at their next session. */
  private addImages(t: TicketView) {
    const n = this.adding.images.length;
    return html`<div class="reply" @paste=${this.adding.paste}>
      ${this.adding.render({
        label: "More images",
        hint: `${
          t.status === "queued"
            ? "They go with the ticket when it's picked up."
            : `${t.assignee?.name ?? "The builder"} sees them at their next session.`
        } Up to ${imageRules.count} at a time, 10 MB each. You can paste a screenshot too.`,
      })}
      ${this.adding.problem ? html`<p class="problem" role="alert">${this.adding.problem}</p>` : ""}
      ${
        n
          ? html`<div class="actions">
            <button type="button" class="btn" ?disabled=${this.busy}
              @click=${() => this.act(() => api.attach(t.id, this.adding.files))}>${n === 1 ? "Send 1 image" : `Send ${n} images`}</button>
          </div>`
          : ""
      }
    </div>`;
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
          return html`<div class="ask"><b>Stuck</b><p>${ask.reason}</p>
            <div class="actions">
              <button type="button" class="btn" ?disabled=${this.busy} @click=${() => this.act(() => api.answer(id, "continue"))}>Keep going</button>
            </div></div>`;
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
          <button type="button" class="btn ghost" ?disabled=${this.busy} @click=${() => this.act(() => api.decide(id, "reject"))}>Reject</button>
        </div>
        <div class="reply" @paste=${this.reply.paste}>
          <textarea aria-label="What to change" placeholder="What should change?" .value=${this.note}
            @input=${(e: InputEvent) => {
              this.note = (e.target as HTMLTextAreaElement).value;
            }}></textarea>
          ${this.reply.render({
            label: "Images (optional)",
            hint: `Show what should change: up to ${imageRules.count}, 10 MB each. You can paste a screenshot too.`,
          })}
          ${this.reply.problem ? html`<p class="problem" role="alert">${this.reply.problem}</p>` : ""}
          <div class="actions">
            <button type="button" class="btn ghost" ?disabled=${this.busy || !this.note.trim()}
              @click=${() => this.act(() => api.decide(id, "changes", this.note, this.reply.files))}>Request changes</button>
          </div>
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
    if (t.waiting) return "";
    return html`<p class="muted">${t.status === "queued" ? "Queued" : t.live}</p>`;
  }

  /** The team for this ticket's project, the usual employee first. */
  private options(t: TicketView): Employee[] {
    return assignees(this.data?.employees ?? [], t.project, this.data?.recent ?? []);
  }

  /** Who the select shows: the owner's pick, else who is assigned now, else the usual employee. */
  private choice(t: TicketView): string {
    const options = this.options(t);
    return (
      options.find((e) => e.id === this.pick)?.id ??
      options.find((e) => e.id === t.assignee?.id)?.id ??
      options[0]?.id ??
      ""
    );
  }

  /** "Who should do this?" for a ticket that hasn't started: pick an employee on the project and assign. */
  private assignCard(t: TicketView) {
    const options = this.options(t);
    if (!options.length) {
      return html`<div class="ask assign" id="assign" role="group" aria-labelledby="assign-h">
        <h3 id="assign-h">Who should do this?</h3>
        <p>Nobody works on ${t.project} yet. Add the project to an employee, or <a href="#/company/team/hiring">hire someone</a>.</p>
      </div>`;
    }
    const chosen = this.choice(t);
    return html`<div class="ask assign" id="assign" role="group" aria-labelledby="assign-h">
      <h3 id="assign-h">Who should do this?</h3>
      <p>${t.assignee ? `${t.assignee.name} is assigned. Pick someone else to change it.` : "Pick who works on it. It starts as soon as they're free."}</p>
      <div class="pick">
        <label>Assign to
          <select name="assignee" @change=${(e: Event) => {
            this.pick = (e.target as HTMLSelectElement).value;
          }}>
            ${options.map((e) => html`<option value=${e.id} .selected=${e.id === chosen}>${optionLabel(e)}</option>`)}
          </select>
        </label>
        <button type="button" class="btn" ?disabled=${this.busy} @click=${() => this.act(() => api.assign(t.id, this.choice(t)))}>Assign</button>
      </div>
    </div>`;
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
      case "owner-attached":
        return item(
          e.attachments.length === 1 ? "You added an image" : `You added ${e.attachments.length} images`,
        );
      case "reassigned":
        return item(`Handed from ${e.from} to ${e.to}`);
      case "failed":
        return item(`Failed: ${e.reason}`, "bad");
      case "helper-unavailable":
        return item(`${e.duty === "review" ? "Reviewer" : "Verifier"} unavailable: ${e.reason}`, "bad");
      case "closed":
        return item(html`<b>${e.outcome}</b>`);
      default:
        return null;
    }
  }
}

customElements.define("inc-ticket", IncTicket);
