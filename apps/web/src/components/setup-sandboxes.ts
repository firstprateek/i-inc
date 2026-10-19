// Setup > Sandboxes: whether each team's machine is up, and which subscriptions it is signed in to.
import { css, html } from "lit";
import { type Sandbox, setupApi } from "../setup-api.ts";
import { setupStyles } from "../setup-shared.ts";
import { Loader } from "./loader.ts";
import { base } from "./shared.ts";

/** null: the daemon has no sandbox status yet (or it failed). */
type Data = { sandboxes: Sandbox[] | null };

const states: Record<Sandbox["state"], [string, string]> = {
  running: ["Running", "working"],
  stopped: ["Stopped", ""],
  missing: ["Not created", ""],
  error: ["Error", "alarm"],
};

const signIns: [keyof Sandbox["signedIn"], string][] = [
  ["claude", "Claude"],
  ["antigravity", "Antigravity"],
  ["github", "GitHub"],
  ["codex", "Codex"],
];

export class IncSetupSandboxes extends Loader<Data> {
  static override properties = {
    ...Loader.properties,
    retrying: { state: true },
    retryErrors: { state: true },
  };
  declare retrying: Set<string>;
  declare retryErrors: Record<string, string>;

  constructor() {
    super();
    this.retrying = new Set();
    this.retryErrors = {};
  }

  protected fetch = async (): Promise<Data> => ({ sandboxes: await setupApi.sandboxes() });

  private async retry(team: string) {
    this.retrying = new Set([...this.retrying, team]);
    const errors = { ...this.retryErrors };
    delete errors[team];
    this.retryErrors = errors;
    try {
      const updated = await setupApi.retrySandbox(team);
      if (this.data?.sandboxes) {
        this.data = {
          sandboxes: this.data.sandboxes.map((s) => (s.team === team ? updated : s)),
        };
      }
    } catch (err) {
      this.retryErrors = { ...this.retryErrors, [team]: err instanceof Error ? err.message : String(err) };
    } finally {
      const next = new Set(this.retrying);
      next.delete(team);
      this.retrying = next;
    }
  }

  static override styles = [
    base,
    setupStyles,
    css`
      .working { background: var(--working-bg); color: var(--working-fg); }
      .subs { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
      .subs li { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 12px; border-radius: 999px;
        border: 1px solid var(--line-strong); font-size: 14px; font-weight: 600; }
      .subs li.in { background: var(--working-bg); color: var(--working-fg); border-color: transparent; }
      .subs li.out { color: var(--ink-2); }
      .failed { border-color: var(--alarm); }
      .actions { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
      .codex-help { margin: 8px 0 0; }
    `,
  ];

  override render() {
    if (this.error) return html`<p role="alert">The daemon isn't answering: ${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Loading sandboxes…</p>`;
    const list = this.data.sandboxes;
    if (!list) return html`<p class="note">Sandbox status isn't available yet.</p>`;
    if (!list.length) return html`<p class="muted">No sandboxes yet.</p>`;
    return html`<div class="stack layout-stack layout-page-band">${list.map((s) => {
      const [label, tone] = states[s.state] ?? [s.state, ""];
      return html`<section class="card ${s.state === "error" ? "failed" : ""}" aria-label=${s.machine}>
        <div class="head">
          <h3>${s.team}</h3>
          <span class="chip ${tone}">${label}</span>
          <span class="spacer"></span>
          <span class="sub">${s.cpus} CPUs · ${s.memory}</span>
        </div>
        <p class="sub">${s.machine}</p>
        ${
          s.state === "error"
            ? html`
          <p class="bad" role="alert">${s.reason || "This sandbox is in an error state, so its team can't work."}</p>
          <div class="actions">
            <button
              class="btn"
              type="button"
              ?disabled=${this.retrying.has(s.team)}
              @click=${() => this.retry(s.team)}
            >
              ${this.retrying.has(s.team) ? "Retrying…" : "Retry now"}
            </button>
            ${this.retryErrors[s.team] ? html`<span class="bad" role="alert">${this.retryErrors[s.team]}</span>` : ""}
          </div>
        `
            : ""
        }
        <ul class="subs" aria-label="Signed in to">
          ${signIns.map(([key, name]) => {
            const on = s.signedIn?.[key] === true;
            return html`<li class=${on ? "in" : "out"}>${name}: ${on ? "signed in" : "not signed in"}</li>`;
          })}
        </ul>
        ${s.signedIn?.codex !== true ? html`<p class="note codex-help">To sign Codex in, run <code>sh tools/host/sign-in-codex.sh ${s.team}</code> on the host. Authentication stays there; don't enter credentials in i.inc. <a href="https://github.com/firstprateek/i-inc/blob/main/docs/codex.md" target="_blank" rel="noreferrer">Owner sign-in instructions</a>.</p>` : ""}
      </section>`;
    })}</div>`;
  }
}

customElements.define("inc-setup-sandboxes", IncSetupSandboxes);
