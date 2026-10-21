// Setup > Sandboxes: whether each team's machine is up, which subscriptions it is signed in to, and
// how full its disk is and what the last cleanup freed (contract C23). A card at the end says what
// the Mac mini keeps and for how long.
import { css, html, nothing } from "lit";
import { call } from "../api.ts";
import { type Sandbox, setupApi } from "../setup-api.ts";
import { setupStyles } from "../setup-shared.ts";
import { Loader } from "./loader.ts";
import { base } from "./shared.ts";

/** The parts of `GET /api/storage` this card reads (contract C23 in docs/coord.md). */
export interface StorageView {
  settings: {
    sandboxCleanupDays: number;
    transcriptCompactDays: number;
    transcriptKeepItems: number;
    backupMaxAgeDays: number;
    logMaxMb: number;
    logKeep: number;
    diskWarnPct: number;
  };
  machines: {
    machine: string;
    diskBytes: number | null;
    fs: { totalBytes: number; usedBytes: number; percent: number; measuredAt: number } | null;
    lastCleanup: {
      at: number;
      status: string;
      reason?: string;
      tickets: number;
      freedBytes: number;
      kept: { ticket: string; reason: string }[];
    } | null;
    freedBytesTotal: number;
  }[];
  host: {
    db: { bytes: number; walBytes: number };
    knowledgeBytes: number;
    logs: { bytes: number };
    containerData: { bytes: number | null } | null;
    rows: { images: { count: number; bytes: number } };
  };
  memory: { rssBytes: number; heapUsedBytes: number };
}

/** null: the daemon has no sandbox status yet (or it failed). */
type Data = { sandboxes: Sandbox[] | null; storage: StorageView | null };

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** "20.4 GB", "812 MB". */
export const sizeText = (bytes: number): string =>
  bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / MB))} MB`;

/** "just now", "3 hours ago", "2 days ago". */
export function agoText(at: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 2) return "just now";
  if (min < 120) return `${min} minutes ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} hours ago`;
  return `${Math.round(min / 1440)} days ago`;
}

async function loadStorage(): Promise<StorageView | null> {
  try {
    const r = await call<Partial<StorageView>>("GET", "/api/storage");
    return Array.isArray(r.machines) && r.settings && r.host && r.memory ? (r as StorageView) : null;
  } catch {
    return null;
  }
}

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

  protected fetch = async (): Promise<Data> => {
    const [sandboxes, storage] = await Promise.all([setupApi.sandboxes(), loadStorage()]);
    return { sandboxes, storage };
  };

  private async retry(team: string) {
    this.retrying = new Set([...this.retrying, team]);
    const errors = { ...this.retryErrors };
    delete errors[team];
    this.retryErrors = errors;
    try {
      const updated = await setupApi.retrySandbox(team);
      if (this.data?.sandboxes) {
        this.data = {
          ...this.data,
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
      .disk { display: flex; flex-direction: column; gap: 4px; }
      .disk p { margin: 0; }
      .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; margin: 0; font-size: 14px; }
      .facts dt { color: var(--ink-2); }
      .facts dd { margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
      .keeps { margin: 0; padding-left: 18px; font-size: 14px; display: flex; flex-direction: column; gap: 4px; }
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
        ${this.disk(s.machine)}
        ${s.signedIn?.codex !== true ? html`<p class="note codex-help">To sign Codex in, run <code>sh tools/host/sign-in-codex.sh ${s.team}</code> on the host. Authentication stays there; don't enter credentials in i.inc. <a href="https://github.com/firstprateek/i-inc/blob/main/docs/codex.md" target="_blank" rel="noreferrer">Owner sign-in instructions</a>.</p>` : ""}
      </section>`;
    })}${this.host()}</div>`;
  }

  /** How full a machine's disk is, and the last cleanup. Nothing when the daemon has no storage report. */
  private disk(machine: string) {
    const storage = this.data?.storage;
    const m = storage?.machines.find((x) => x.machine === machine);
    if (!storage || !m) return "";
    const fs = m.fs;
    const warn = fs !== null && fs.percent >= storage.settings.diskWarnPct;
    const last = m.lastCleanup;
    return html`<div class="disk" aria-label="Disk and cleanup">
      ${
        fs
          ? html`<p class="sub ${warn ? "bad" : ""}" role=${warn ? "alert" : nothing}>Disk ${fs.percent}% full: ${sizeText(fs.usedBytes)} of ${sizeText(fs.totalBytes)}, measured ${agoText(fs.measuredAt)}.${warn ? " Cleanup runs about once an hour." : ""}</p>`
          : html`<p class="sub">Disk use is measured while the machine is up and idle.</p>`
      }
      ${m.diskBytes !== null ? html`<p class="sub">The machine's disk file on the Mac mini: ${sizeText(m.diskBytes)}.</p>` : ""}
      ${
        last && last.status === "cleaned"
          ? html`<p class="sub">Last cleanup ${agoText(last.at)}: freed ${sizeText(last.freedBytes)} from ${last.tickets} closed ${last.tickets === 1 ? "ticket" : "tickets"}${last.kept.length ? `, kept ${last.kept.length} with unpushed work` : ""}. ${sizeText(m.freedBytesTotal)} freed in all.</p>`
          : last
            ? html`<p class="sub bad">Last cleanup ${agoText(last.at)} didn't finish${last.reason ? `: ${last.reason}` : ""}.</p>`
            : html`<p class="sub">No cleanup has run yet.</p>`
      }
    </div>`;
  }

  /** What the Mac mini keeps, and for how long. */
  private host() {
    const storage = this.data?.storage;
    if (!storage) return "";
    const { host, settings: c, memory } = storage;
    return html`<section class="card" aria-label="Mac mini storage">
      <div class="head"><h3>On the Mac mini</h3></div>
      <dl class="facts">
        <dt>Database</dt><dd>${sizeText(host.db.bytes + host.db.walBytes)}</dd>
        <dt>Brains and handbook</dt><dd>${sizeText(host.knowledgeBytes)}</dd>
        <dt>Logs</dt><dd>${sizeText(host.logs.bytes)}</dd>
        <dt>Your uploaded images</dt><dd>${host.rows.images.count} (${sizeText(host.rows.images.bytes)}), kept</dd>
        ${host.containerData?.bytes != null ? html`<dt>Container data</dt><dd>${sizeText(host.containerData.bytes)}</dd>` : ""}
        <dt>Daemon memory</dt><dd>${sizeText(memory.rssBytes)}</dd>
      </dl>
      <ul class="keeps" aria-label="What is kept, and for how long">
        <li>A closed ticket's copies in a sandbox go ${c.sandboxCleanupDays > 0 ? `${c.sandboxCleanupDays} days after it ends` : "never (cleanup is off)"}. The branch stays on GitHub.</li>
        <li>${c.transcriptCompactDays > 0 ? `Transcripts of tickets closed over ${c.transcriptCompactDays} days ago keep their last ${c.transcriptKeepItems} items per session.` : "Transcripts are kept whole."}</li>
        <li>Logs rotate at ${c.logMaxMb} MB, keeping ${c.logKeep}.</li>
        <li>${c.backupMaxAgeDays > 0 ? `Database backups older than ${c.backupMaxAgeDays} days are deleted, except the newest.` : "Database backups are kept."}</li>
        <li>You get a push when a sandbox's disk passes ${c.diskWarnPct}% full.</li>
      </ul>
    </section>`;
  }
}

customElements.define("inc-setup-sandboxes", IncSetupSandboxes);
