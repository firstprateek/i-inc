// Setup > Notifications: a clear on/off for push on this device, and why it can't be on when it can't.
import { css, html, LitElement } from "lit";
import { api, type NotifySettings } from "../api.ts";
import { disablePush, enablePush, type PushState, pushState } from "../push.ts";
import { message, type Note, noteLine, setupStyles } from "../setup-shared.ts";
import { base } from "./shared.ts";

const stateChip: Record<PushState, [string, string]> = {
  on: ["On", "working"],
  off: ["Off", ""],
  denied: ["Blocked", "needs"],
  unsupported: ["Not supported", ""],
  unavailable: ["Not available yet", ""],
};

export class IncSetupNotifications extends LitElement {
  static override properties = {
    state: { state: true },
    busy: { state: true },
    note: { state: true },
    kinds: { state: true },
    kindBusy: { state: true },
    kindNote: { state: true },
  };
  declare state: PushState | null;
  declare busy: boolean;
  declare note: Note | undefined;
  /** What to be notified about (T65), or null until the daemon has said (or if it has no such setting). */
  declare kinds: NotifySettings | null;
  declare kindBusy: string;
  declare kindNote: Note | undefined;

  constructor() {
    super();
    this.state = null;
    this.busy = false;
    this.note = undefined;
    this.kinds = null;
    this.kindBusy = "";
    this.kindNote = undefined;
  }

  static override styles = [
    base,
    setupStyles,
    css`
      .working { background: var(--working-bg); color: var(--working-fg); }
      .needs { background: var(--needs-bg); color: var(--needs-fg); }
      p { margin: 0; line-height: 1.45; }
      .switch { display: flex; align-items: center; gap: 14px; min-height: 44px; }
      .switch span { font-size: 16px; font-weight: 600; }
      .track { position: relative; flex-shrink: 0; width: 72px; height: 44px; padding: 0; border-radius: 999px; cursor: pointer;
        border: 1px solid var(--line-strong); background: var(--sunken); }
      .track::after { content: ""; position: absolute; top: 4px; left: 4px; width: 34px; height: 34px; border-radius: 50%;
        background: var(--ink-2); transition: transform 0.15s; }
      .track[aria-checked="true"] { background: var(--ink); border-color: var(--ink); }
      .track[aria-checked="true"]::after { transform: translateX(28px); background: var(--on-ink); }
      .track[aria-disabled="true"] { opacity: 0.5; cursor: default; }
      .track:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .kind { display: flex; flex-direction: column; gap: 4px; padding-top: 10px; }
      .kind .sub { margin: 0; padding-left: 86px; }
      @media (max-width: 480px) { .kind .sub { padding-left: 0; } }
      @media (prefers-reduced-motion: reduce) { .track::after { transition: none; } }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    void pushState().then((s) => {
      this.state = s;
    });
    void api
      .notifySettings()
      .then((k) => {
        this.kinds = k;
      })
      .catch(() => {});
  }

  private async setKind(key: keyof NotifySettings) {
    const kinds = this.kinds;
    if (!kinds || this.kindBusy) return;
    this.kindBusy = key;
    this.kindNote = undefined;
    try {
      this.kinds = await api.setNotifySettings({ [key]: !kinds[key] });
    } catch (e) {
      this.kindNote = { ok: false, text: message(e) };
    } finally {
      this.kindBusy = "";
    }
  }

  private kindRow(key: keyof NotifySettings, label: string, why: string) {
    const kinds = this.kinds;
    if (!kinds) return "";
    const on = kinds[key];
    return html`<div class="kind">
      <div class="switch">
        <button class="track" type="button" role="switch" aria-checked=${on ? "true" : "false"}
          aria-labelledby="kind-${key}" aria-describedby="why-${key}" aria-disabled=${this.kindBusy !== "" ? "true" : "false"} @click=${() => this.setKind(key)}></button>
        <span id="kind-${key}">${label}</span>
      </div>
      <p class="sub" id="why-${key}">${why}</p>
    </div>`;
  }

  private async toggle() {
    if (this.busy || !this.state) return;
    this.busy = true;
    this.note = undefined;
    const turningOn = this.state !== "on";
    try {
      this.state = turningOn ? await enablePush() : await disablePush();
      if (this.state === "on") this.note = { ok: true, text: "Notifications are on for this device." };
    } catch (e) {
      // A failed turn-off still leaves this device off; read the truth back.
      this.note = { ok: false, text: message(e) };
      this.state = await pushState();
    } finally {
      this.busy = false;
    }
  }

  private explain(state: PushState) {
    switch (state) {
      case "unsupported":
        return html`<p>This browser can't show notifications from i.inc.</p>
          <p><b>On iPhone,</b> install i.inc first: open it in Safari, tap Share, then Add to Home Screen, and open
          it from the Home Screen. iOS only allows push notifications for installed web apps.</p>`;
      case "denied":
        return html`<p>Notifications are blocked for i.inc on this device, so it can't ask again.</p>
          <p>To re-enable them, allow notifications for i.inc in the browser's site settings. On iPhone, open Settings,
          then Notifications, then i.inc. Then come back here and turn them on.</p>`;
      case "unavailable":
        return html`<p class="note">Notifications aren't available yet.</p>`;
      default:
        return "";
    }
  }

  override render() {
    const state = this.state;
    if (!state) return html`<p class="muted">Checking this device…</p>`;
    const [label, tone] = stateChip[state];
    const canToggle = state === "on" || state === "off";
    return html`<div class="stack layout-stack layout-page-band">
      <section class="card" aria-label="Notifications">
        <div class="head">
          <h3>This device</h3>
          <span class="chip ${tone}">${label}</span>
        </div>
        <p class="sub">A notification when a ticket needs you, a report is ready, or main goes red.</p>
        ${
          canToggle
            ? html`<div class="switch">
              <button class="track" type="button" role="switch" aria-checked=${state === "on" ? "true" : "false"}
                aria-labelledby="switch-label" aria-disabled=${this.busy ? "true" : "false"} @click=${() => this.toggle()}></button>
              <span id="switch-label">${this.busy ? "Working…" : state === "on" ? "Notifications on" : "Notifications off"}</span>
            </div>`
            : this.explain(state)
        }
        ${noteLine(this.note)}
      </section>
      ${
        this.kinds
          ? html`<section class="card" aria-label="What to be notified about">
            <div class="head"><h3>What to be notified about</h3></div>
            <p class="sub">Applies to every device that has notifications on. Tickets always notify; these are about conversations.</p>
            ${this.kindRow(
              "conversationsNeedMe",
              "Conversations need me",
              "When an employee in a conversation is waiting for your permission or an answer and you aren't looking at that conversation, send a notification that opens its card.",
            )}
            ${this.kindRow(
              "longReplyFinished",
              "A long reply finished",
              "When a reply you asked for takes over a minute and finishes while you aren't looking at that conversation, send a notification.",
            )}
            ${noteLine(this.kindNote)}
          </section>`
          : ""
      }
    </div>`;
  }
}

customElements.define("inc-setup-notifications", IncSetupNotifications);
