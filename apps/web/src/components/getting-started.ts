// The first-run checklist on Conversations (V1 plan §1): connect GitHub, add a project, meet the team,
// start a conversation. It shows until all four are done or the owner dismisses it.
import { css, html, LitElement, nothing } from "lit";
import { api, call, refresh } from "../api.ts";
import { setupApi } from "../setup-api.ts";
import { base } from "./shared.ts";

/** Set to "1" when the owner dismisses the checklist. */
export const DISMISS_KEY = "i-inc-getting-started-dismissed";
/** Set to "1" once the owner has said something in a conversation, so it is not looked for again. */
export const STARTED_KEY = "i-inc-first-conversation";
/** Where the bot's installation (and the repositories it can see) is managed on GitHub. */
export const GITHUB_INSTALL_URL = "https://github.com/settings/installations";

export type StepId = "github" | "project" | "team" | "conversation";

/** What is known about each step: true done, false not yet, null not looked at yet. */
export type Progress = Record<StepId, boolean | null>;

export interface StepAction {
  label: string;
  href: string;
  external?: boolean;
}

export interface Step {
  id: StepId;
  title: string;
  text: string;
  done: boolean;
  /** The step's main action, then a lesser one. Empty once the step is done. */
  actions: StepAction[];
}

/** The four steps, in order, with their words and actions. Pure, so it is easy to test. */
export function checklist(progress: Progress, employeeId = ""): Step[] {
  const done = (id: StepId) => progress[id] === true;
  const step = (id: StepId, title: string, text: string, doneText: string, actions: StepAction[]): Step => ({
    id,
    title,
    text: done(id) ? doneText : text,
    done: done(id),
    actions: done(id) ? [] : actions,
  });
  return [
    step(
      "github",
      "Connect GitHub",
      "Install the i.inc bot on the repositories you want your team to work on.",
      "GitHub is connected: the bot can see your repositories.",
      [
        { label: "Open GitHub settings", href: GITHUB_INSTALL_URL, external: true },
        { label: "Company → Projects", href: "#/company/projects" },
      ],
    ),
    step(
      "project",
      "Add a project",
      "Pick a repository for your team to work on, or start a new one.",
      "You have a project.",
      [{ label: "Add a project", href: "#/company/projects" }],
    ),
    step(
      "team",
      "Meet your team",
      "See who works here, or hire another employee.",
      "Your team is in place.",
      [
        { label: "See your team", href: "#/company/team" },
        { label: "Hire someone", href: "#/company/team/hiring" },
      ],
    ),
    step(
      "conversation",
      "Start a conversation",
      "Say hello to an employee, or ask for something new.",
      "You have talked with your team.",
      [{ label: "Start a conversation", href: `#/conversations/${employeeId}` }],
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

/** The checklist is hidden for good once dismissed. */
export function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Looks at no more than this often, since a refresh fires on every ticket event. */
const RECHECK_MS = 30_000;

export class IncGettingStarted extends LitElement {
  static override properties = {
    progress: { state: true },
    dismissed: { state: true },
    employeeId: { state: true },
    loaded: { state: true },
  };
  declare progress: Progress;
  declare dismissed: boolean;
  declare employeeId: string;
  declare loaded: boolean;
  private checking = false;
  private lastCheck = 0;

  constructor() {
    super();
    this.progress = { github: null, project: null, team: null, conversation: null };
    this.dismissed = isDismissed();
    this.employeeId = "";
    this.loaded = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    refresh.addEventListener("refresh", this.onRefresh);
    void this.check();
  }

  override disconnectedCallback(): void {
    refresh.removeEventListener("refresh", this.onRefresh);
    super.disconnectedCallback();
  }

  private onRefresh = () => {
    if (Date.now() - this.lastCheck > RECHECK_MS) void this.check();
  };

  /** Whether the checklist is on screen: not dismissed, looked at, and something left to do. */
  get visible(): boolean {
    return !this.dismissed && this.loaded && Object.values(this.progress).some((v) => v !== true);
  }

  /** Looks at what the daemon has. A step that was done stays done for this visit; a failed read is "not yet". */
  async check(): Promise<void> {
    if (this.dismissed || this.checking) return;
    this.checking = true;
    this.lastCheck = Date.now();
    const known = this.progress;
    const no = () => false;
    try {
      const [github, project, employees, conversation] = await Promise.all([
        known.github ? true : setupApi.githubRepos().then((r) => r.length > 0, no),
        known.project ? true : api.projects().then((p) => p.length > 0, no),
        api.employees().then(
          (e) => e,
          () => null,
        ),
        known.conversation ? true : ownerHasSpoken().catch(no),
      ]);
      this.employeeId = employees?.[0]?.id ?? this.employeeId;
      this.progress = { github, project, team: (employees?.length ?? 0) > 0, conversation };
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
      .gs { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; box-sizing: border-box; }
      .head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .head h2 { font-size: 20px; }
      .head .grow { flex-grow: 1; }
      .steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
      .step { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; min-width: 0; background: var(--ground); }
      .step.next { border: 2px solid var(--reviewing-mark); padding: 11px 13px; background: var(--surface); }
      .title { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 16px; }
      .badge { width: 24px; height: 24px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center;
        font-size: 13px; font-weight: 800; border: 1px solid var(--line-strong); color: var(--ink); }
      .step.done .badge { background: var(--working-bg); color: var(--working-fg); border-color: var(--working-edge); }
      .badge svg { width: 14px; height: 14px; display: block; }
      .step p { margin: 0; font-size: 14px; line-height: 1.4; color: var(--ink-2); }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; padding-top: 4px; }
      .actions a.btn { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; box-sizing: border-box; min-width: 44px; }
      .sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
      @media (max-width: 900px) {
        :host { max-height: 44dvh; overflow-y: auto; overscroll-behavior: contain; }
        .gs { padding: 14px 16px; }
        .steps { grid-template-columns: minmax(0, 1fr); }
        .actions .btn { flex: 1 1 auto; }
      }
    `,
  ];

  override render() {
    if (!this.visible) return html``;
    const steps = checklist(this.progress, this.employeeId);
    const done = steps.filter((s) => s.done).length;
    const next = steps.find((s) => !s.done);
    return html`<section class="card gs" aria-labelledby="gs-title">
      <div class="head">
        <h2 id="gs-title">Getting started</h2>
        <span class="muted" role="status">${done} of ${steps.length} done</span>
        <span class="grow"></span>
        <button class="btn ghost dismiss" type="button" @click=${this.dismiss}>Dismiss</button>
      </div>
      <ol class="steps">
        ${steps.map(
          (s, i) => html`<li class="step ${s.done ? "done" : ""} ${s === next ? "next" : ""}">
            <div class="title"><span class="badge" aria-hidden="true">${
              s.done
                ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`
                : i + 1
            }</span>${s.title}${s.done ? html`<span class="sr"> (done)</span>` : ""}</div>
            <p>${s.text}</p>
            ${
              s.actions.length
                ? html`<div class="actions">${s.actions.map(
                    (a, j) => html`<a class="btn ${s === next && j === 0 ? "" : "ghost"}" href=${a.href}
                      target=${a.external ? "_blank" : nothing} rel=${a.external ? "noopener noreferrer" : nothing}
                      @click=${s.id === "conversation" ? this.startHere : null}>${a.label}${a.external ? html`<span class="sr"> (opens GitHub)</span>` : ""}</a>`,
                  )}</div>`
                : ""
            }
          </li>`,
        )}
      </ol>
    </section>`;
  }
}

customElements.define("inc-getting-started", IncGettingStarted);
