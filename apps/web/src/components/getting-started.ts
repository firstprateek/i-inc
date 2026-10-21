// The first-run checklist on Conversations (V1 plan §1): connect GitHub, add a project, meet the team,
// start a conversation. It is one compact row (the next step, its main action, Dismiss) with the
// remaining steps on demand, and shows until all four are done or the owner dismisses it.
import { css, html, LitElement, nothing } from "lit";
import { api, call, refresh } from "../api.ts";
import { DISMISS_KEY, isDismissed, MESSAGE_SENT_EVENT, SHOW_EVENT, STARTED_KEY } from "../first-run.ts";
import { GITHUB_INSTALL_URL, GITHUB_MANAGE_URL, setupApi } from "../setup-api.ts";
import { base } from "./shared.ts";

export { DISMISS_KEY, GITHUB_INSTALL_URL, GITHUB_MANAGE_URL, isDismissed, STARTED_KEY };

export type StepId = "github" | "project" | "team" | "conversation";

/** What is known about a step: done, not yet, "error" (the daemon could not be asked), or null (not looked at). */
export type StepState = boolean | "error" | null;
export type Progress = Record<StepId, StepState>;

export interface StepAction {
  label: string;
  /** What the compact row shows on its button; `label` is its accessible name. */
  short?: string;
  href: string;
  external?: boolean;
}

export interface Step {
  id: StepId;
  title: string;
  text: string;
  done: boolean;
  /** The daemon could not be asked, so the step is neither done nor known to be open. */
  error: boolean;
  /** The step's main action first. Empty once the step is done. */
  actions: StepAction[];
}

/** The four steps, in order, with their words and actions. Pure, so it is easy to test. */
export function checklist(progress: Progress, employeeId = ""): Step[] {
  const step = (id: StepId, title: string, text: string, doneText: string, actions: StepAction[]): Step => {
    const done = progress[id] === true;
    const error = progress[id] === "error";
    return {
      id,
      title,
      text: done ? doneText : error ? "Couldn't check this just now." : text,
      done,
      error,
      actions: done ? [] : actions,
    };
  };
  return [
    step(
      "github",
      "Connect GitHub",
      "Install the i.inc bot on the repositories you want your team to work on.",
      "GitHub is connected: the bot can see your repositories.",
      [
        { label: "Install the bot", short: "Install", href: GITHUB_INSTALL_URL, external: true },
        { label: "Manage repository access", href: GITHUB_MANAGE_URL, external: true },
        { label: "Company → Projects", href: "#/company/projects" },
      ],
    ),
    step(
      "project",
      "Add a project",
      "Pick a repository for your team to work on, or start a new one.",
      "You have a project.",
      [{ label: "Add a project", short: "Add", href: "#/company/projects" }],
    ),
    step(
      "team",
      "Meet your team",
      "See who works here, or hire another employee.",
      "Your team is in place.",
      [
        { label: "See your team", short: "Open", href: "#/company/team" },
        { label: "Hire someone", href: "#/company/team/hiring" },
      ],
    ),
    step(
      "conversation",
      "Start a conversation",
      "Say hello to an employee, or ask for something new.",
      "You have talked with your team.",
      [{ label: "Start a conversation", short: "Start", href: `#/conversations/${employeeId}` }],
    ),
  ];
}

interface Thread {
  id: string;
  last: { from?: string } | null;
}

/** True when the owner has said something in any employee's conversation. */
async function ownerHasSpoken(): Promise<boolean> {
  try {
    if (localStorage.getItem(STARTED_KEY) === "1") return true;
  } catch {}
  const { threads } = await call<{ threads: Thread[] }>("GET", "/api/chat");
  let spoke = threads.some((t) => t.last?.from === "owner");
  if (!spoke) {
    const threadsWithEntries = await Promise.all(
      threads.slice(0, 12).map((t) =>
        call<{ entries: { from?: string }[] }>("GET", `/api/chat/${encodeURIComponent(t.id)}`).then(
          (r) => r.entries ?? [],
          () => [],
        ),
      ),
    );
    spoke = threadsWithEntries.some((entries) => entries.some((e) => e.from === "owner"));
  }
  if (spoke) {
    try {
      localStorage.setItem(STARTED_KEY, "1");
    } catch {}
  }
  return spoke;
}

/** Looks at no more than this often, since a refresh fires on every ticket event. */
const RECHECK_MS = 30_000;

export class IncGettingStarted extends LitElement {
  static override properties = {
    progress: { state: true },
    dismissed: { state: true },
    employeeId: { state: true },
    loaded: { state: true },
    open: { state: true },
  };
  declare progress: Progress;
  declare dismissed: boolean;
  declare employeeId: string;
  declare loaded: boolean;
  /** The remaining steps are showing. */
  declare open: boolean;
  private checking = false;
  private lastCheck = 0;

  constructor() {
    super();
    this.progress = { github: null, project: null, team: null, conversation: null };
    this.dismissed = isDismissed();
    this.employeeId = "";
    this.loaded = false;
    this.open = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    refresh.addEventListener("refresh", this.onRefresh);
    window.addEventListener(MESSAGE_SENT_EVENT, this.onMessageSent);
    window.addEventListener(SHOW_EVENT, this.onShow);
    void this.check();
  }

  override disconnectedCallback(): void {
    refresh.removeEventListener("refresh", this.onRefresh);
    window.removeEventListener(MESSAGE_SENT_EVENT, this.onMessageSent);
    window.removeEventListener(SHOW_EVENT, this.onShow);
    super.disconnectedCallback();
  }

  private onRefresh = () => {
    if (Date.now() - this.lastCheck > RECHECK_MS) void this.check();
  };

  /** The owner's message was accepted: step four is done now, not at the next look. */
  private onMessageSent = () => {
    this.progress = { ...this.progress, conversation: true };
  };

  /** "Show getting started" in the account menu. */
  private onShow = () => {
    this.dismissed = false;
    this.lastCheck = 0;
    void this.check();
  };

  /** Whether the checklist is on screen: not dismissed, looked at, and something left to do. */
  get visible(): boolean {
    return !this.dismissed && this.loaded && Object.values(this.progress).some((v) => v !== true);
  }

  /** Looks at what the daemon has. A step that was done stays done for this visit; a failed read says so. */
  async check(): Promise<void> {
    if (this.dismissed || this.checking) return;
    this.checking = true;
    this.lastCheck = Date.now();
    const known = this.progress;
    const failed = () => "error" as const;
    try {
      const [github, project, employees, conversation] = await Promise.all([
        known.github === true ? true : setupApi.githubRepos().then((r) => r.length > 0, failed),
        known.project === true ? true : api.projects().then((p) => p.length > 0, failed),
        api.employees().then(
          (e) => e,
          () => null,
        ),
        known.conversation === true ? true : ownerHasSpoken().catch(failed),
      ]);
      this.employeeId = employees?.[0]?.id ?? this.employeeId;
      this.progress = {
        github,
        project,
        team: employees ? employees.length > 0 : "error",
        conversation,
      };
      this.loaded = true;
    } finally {
      this.checking = false;
    }
  }

  override updated(): void {
    this.hidden = !this.visible;
  }

  private dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {}
    this.dismissed = true;
    this.open = false;
  };

  private toggle = () => {
    this.open = !this.open;
    // Opening it is a good moment to look again, in case something failed or has changed.
    if (this.open) void this.check();
  };

  /** "Start a conversation" on the conversations screen itself: go straight to the message field. */
  private startHere = (e: Event) => {
    const composer = this.parentElement
      ?.querySelector("inc-chat")
      ?.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea");
    if (!composer) return;
    e.preventDefault();
    composer.focus();
  };

  static override styles = [
    base,
    css`
      :host { display: block; min-width: 0; }
      :host([hidden]) { display: none; }
      .gs { padding: 6px 12px; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; }
      .bar { display: flex; align-items: center; gap: 12px; min-height: 44px; min-width: 0; }
      .title { display: flex; align-items: baseline; gap: 8px; flex: none; }
      .title h2 { font-size: 16px; white-space: nowrap; }
      .count { font-size: 13px; font-weight: 700; color: var(--ink-2); font-variant-numeric: tabular-nums; }
      .next { flex: 1 1 0; min-width: 0; margin: 0; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .next .lbl { color: var(--ink-2); }
      .next .err { color: var(--ink-2); }
      .bar .btn { flex: none; padding: 0 16px; font-size: 14px; display: inline-flex; align-items: center; justify-content: center;
        text-decoration: none; box-sizing: border-box; min-width: 44px; }
      .dismiss svg { display: none; width: 18px; height: 18px; }
      .more { list-style: none; margin: 0; padding: 4px 0 6px; display: flex; flex-direction: column; border-top: 1px solid var(--line);
        max-height: 40dvh; overflow-y: auto; overscroll-behavior: contain; }
      .step { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; padding: 8px 0; }
      .step + .step { border-top: 1px solid var(--line); }
      .num { width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
        font-size: 13px; font-weight: 800; border: 1px solid var(--line-strong); }
      .step.next-step .num { border: 2px solid var(--reviewing-mark); }
      .step b { font-size: 15px; }
      .step p { margin: 0; font-size: 14px; line-height: 1.4; color: var(--ink-2); }
      .step .copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
      .actions .btn { padding: 0 14px; font-size: 14px; display: inline-flex; align-items: center; justify-content: center;
        text-decoration: none; box-sizing: border-box; min-width: 44px; max-width: 100%; white-space: normal; text-align: center; padding-block: 6px; }
      @media (max-width: 900px) {
        .gs { padding: 6px 10px; }
        /* A phone: the title and the two small controls, then the next step and its action. */
        .bar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: "title toggle dismiss" "next next primary"; gap: 4px 8px; }
        .title { grid-area: title; }
        .toggle { grid-area: toggle; }
        .dismiss { grid-area: dismiss; }
        .next { grid-area: next; }
        .primary { grid-area: primary; }
        .step { grid-template-columns: 24px minmax(0, 1fr); }
        .step .actions { grid-column: 2; justify-content: flex-start; }
      }
      @media (max-width: 520px) {
        .dismiss { width: 44px; padding: 0; }
        .dismiss svg { display: block; }
        .dismiss .label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
      }
    `,
  ];

  override render() {
    if (!this.visible) return html``;
    const steps = checklist(this.progress, this.employeeId);
    const done = steps.filter((s) => s.done).length;
    const remaining = steps.filter((s) => !s.done);
    const next = remaining[0];
    const go = next?.actions[0];
    const link = (a: StepAction, ghost: boolean, id: StepId, short = false) =>
      html`<a class="btn ${ghost ? "ghost" : ""} ${short ? "primary" : ""}" href=${a.href}
        target=${a.external ? "_blank" : nothing} rel=${a.external ? "noopener noreferrer" : nothing}
        aria-label=${a.external ? `${a.label} (opens GitHub)` : short && a.short ? a.label : nothing}
        @click=${id === "conversation" ? this.startHere : null}>${short ? (a.short ?? a.label) : a.label}</a>`;
    return html`<section class="card gs" aria-labelledby="gs-title">
      <div class="bar">
        <div class="title"><h2 id="gs-title">Getting started</h2>
          <span class="count" role="status" aria-label="${done} of ${steps.length} done">${done}/${steps.length}</span></div>
        <p class="next"><span class="lbl">Next:</span> <b>${next?.title}</b>${next?.error ? html` <span class="err">· Couldn't check</span>` : ""}</p>
        ${next && go ? link(go, false, next.id, true) : ""}
        <button class="btn ghost toggle" type="button" aria-expanded=${this.open ? "true" : "false"} aria-controls="gs-more"
          @click=${this.toggle}>${this.open ? "Hide steps" : "Steps"}</button>
        <button class="btn ghost dismiss" type="button" aria-label="Dismiss getting started" @click=${this.dismiss}>
          <span class="label">Dismiss</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      ${
        this.open
          ? html`<ol class="more" id="gs-more">
              ${remaining.map(
                (s) => html`<li class="step ${s === next ? "next-step" : ""}">
                  <span class="num" aria-hidden="true">${steps.indexOf(s) + 1}</span>
                  <div class="copy"><b>${s.title}</b><p>${s.text}</p></div>
                  <div class="actions">${s.actions.map((a, j) => link(a, !(s === next && j === 0), s.id))}</div>
                </li>`,
              )}
            </ol>`
          : ""
      }
    </section>`;
  }
}

customElements.define("inc-getting-started", IncGettingStarted);
