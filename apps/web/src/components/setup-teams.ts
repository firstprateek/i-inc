// Setup > Teams: who shares a sandbox, and how big it is.
import { html } from "lit";
import { api, refreshNow } from "../api.ts";
import { defaultSandbox, setupApi, type Team } from "../setup-api.ts";
import { message, type Note, noteLine, setupStyles } from "../setup-shared.ts";
import { Loader } from "./loader.ts";
import { base } from "./shared.ts";

interface TeamsData {
  teams: Team[];
  names: Record<string, string>;
}

interface Size {
  cpus: string;
  memory: string;
}

const sizeOf = (t: Team): Size => {
  const s = t.sandbox ?? defaultSandbox;
  return { cpus: String(s.cpus), memory: s.memory.replace(/G$/, "") };
};

export class IncSetupTeams extends Loader<TeamsData> {
  static override properties = {
    ...Loader.properties,
    drafts: { state: true },
    notes: { state: true },
    busy: { state: true },
  };
  declare drafts: Record<string, Size>;
  declare notes: Record<string, Note>;
  declare busy: string | null;

  constructor() {
    super();
    this.drafts = {};
    this.notes = {};
    this.busy = null;
  }

  protected fetch = async (): Promise<TeamsData> => {
    const [teams, office] = await Promise.all([setupApi.teams(), api.office().catch(() => null)]);
    const names: Record<string, string> = {};
    for (const e of office?.employees ?? []) names[e.id] = e.name;
    return { teams, names };
  };

  static override styles = [base, setupStyles];

  private size(t: Team): Size {
    return this.drafts[t.id] ?? sizeOf(t);
  }

  private dirty(t: Team): boolean {
    const d = this.drafts[t.id];
    return !!d && JSON.stringify(d) !== JSON.stringify(sizeOf(t));
  }

  private edit(t: Team, patch: Partial<Size>) {
    this.drafts = { ...this.drafts, [t.id]: { ...this.size(t), ...patch } };
    const { [t.id]: _gone, ...rest } = this.notes;
    this.notes = rest;
  }

  private async save(t: Team) {
    const s = this.size(t);
    const cpus = Number(s.cpus);
    const mem = Number(s.memory);
    if (!Number.isInteger(cpus) || cpus < 1 || !Number.isInteger(mem) || mem < 1) {
      this.notes = { ...this.notes, [t.id]: { ok: false, text: "CPUs and memory are whole numbers." } };
      return;
    }
    this.busy = t.id;
    try {
      await setupApi.saveTeam({ ...t, sandbox: { cpus, memory: `${mem}G` } });
      const { [t.id]: _gone, ...rest } = this.drafts;
      this.drafts = rest;
      this.notes = { ...this.notes, [t.id]: { ok: true, text: "Saved" } };
      await this.reload();
      refreshNow();
    } catch (e) {
      this.notes = { ...this.notes, [t.id]: { ok: false, text: message(e) } };
    } finally {
      this.busy = null;
    }
  }

  override render() {
    if (this.error) return html`<p role="alert">The daemon isn't answering: ${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Loading teams…</p>`;
    const { teams, names } = this.data;
    if (!teams.length) {
      return html`<p class="muted">No teams yet. Everyone works in the shared company sandbox.</p>`;
    }
    return html`<div class="stack layout-stack layout-page-band">${teams.map((t) => {
      const s = this.size(t);
      return html`<section class="card" aria-label=${t.name}>
        <div class="head"><h3>${t.name}</h3><span class="tag">${t.id}</span></div>
        <p class="sub">${
          t.members.length ? t.members.map((m) => names[m] ?? m).join(", ") : "No members yet"
        }</p>
        <div class="row">
          <label>CPUs
            <input type="number" inputmode="numeric" min="1" step="1" .value=${s.cpus}
              @input=${(e: InputEvent) => this.edit(t, { cpus: (e.target as HTMLInputElement).value })} /></label>
          <label>Memory (GB)
            <input type="number" inputmode="numeric" min="1" step="1" .value=${s.memory}
              @input=${(e: InputEvent) => this.edit(t, { memory: (e.target as HTMLInputElement).value })} /></label>
        </div>
        <div class="actions">
          <button class="btn" type="button" ?disabled=${!this.dirty(t) || this.busy === t.id} @click=${() => this.save(t)}>
            ${this.busy === t.id ? "Saving…" : "Save size"}</button>
          ${noteLine(this.notes[t.id])}
        </div>
      </section>`;
    })}</div>`;
  }
}

customElements.define("inc-setup-teams", IncSetupTeams);
