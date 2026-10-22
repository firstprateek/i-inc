// Setup > Teams: who shares a sandbox, and how big it is. A team is made here, and its people chosen here
// (or at hiring). A personal assistant works on home data and always has a sandbox of its own, which the
// daemon makes when it is hired, so it is never picked into a team.
import { isHomeEmployee } from "@i-inc/core";
import { html } from "lit";
import { api, refreshNow } from "../api.ts";
import { defaultSandbox, setupApi, type Team } from "../setup-api.ts";
import { message, type Note, noteLine, setupStyles } from "../setup-shared.ts";
import { Loader } from "./loader.ts";
import { base } from "./shared.ts";

interface Person {
  id: string;
  name: string;
  /** Works on home data: has a sandbox of its own, and isn't picked into a team. */
  home: boolean;
}

interface TeamsData {
  teams: Team[];
  names: Record<string, string>;
  people: Person[];
}

const teamIdPattern = /^[a-z0-9-]{1,32}$/;
/** A team's id from its name, the way hiring makes an employee's. */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32)
    .replace(/-$/, "");

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
    picks: { state: true },
    notes: { state: true },
    busy: { state: true },
    newName: { state: true },
    newPicks: { state: true },
  };
  declare drafts: Record<string, Size>;
  /** Members being picked for a team, before Save members. */
  declare picks: Record<string, string[]>;
  declare notes: Record<string, Note>;
  declare busy: string | null;
  declare newName: string;
  declare newPicks: string[];

  constructor() {
    super();
    this.drafts = {};
    this.picks = {};
    this.notes = {};
    this.busy = null;
    this.newName = "";
    this.newPicks = [];
  }

  protected fetch = async (): Promise<TeamsData> => {
    const [teams, office, staff] = await Promise.all([
      setupApi.teams(),
      api.office().catch(() => null),
      api
        .employees()
        .then((list) => (Array.isArray(list) ? list : []))
        .catch(() => []),
    ]);
    const names: Record<string, string> = {};
    for (const e of office?.employees ?? []) names[e.id] = e.name;
    for (const e of staff) names[e.id] = e.name;
    const people = staff.map((e) => ({ id: e.id, name: e.name, home: isHomeEmployee(e) }));
    return { teams, names, people };
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

  /** The picked members of a team: what's being chosen, else who is in it now. */
  private picked(t: Team): string[] {
    return this.picks[t.id] ?? t.members;
  }

  private membersDirty(t: Team): boolean {
    const p = this.picks[t.id];
    return !!p && [...p].sort().join(",") !== [...t.members].sort().join(",");
  }

  private togglePick(t: Team, id: string, on: boolean) {
    const now = this.picked(t);
    this.picks = { ...this.picks, [t.id]: on ? [...new Set([...now, id])] : now.filter((m) => m !== id) };
    const { [t.id]: _gone, ...rest } = this.notes;
    this.notes = rest;
  }

  /** The home employees a team already holds stay in it: the daemon won't let one out of its own sandbox. */
  private homeMembers(t: Team): string[] {
    const home = new Set(this.data?.people.filter((p) => p.home).map((p) => p.id));
    return t.members.filter((m) => home.has(m));
  }

  private async saveMembers(t: Team) {
    this.busy = `members-${t.id}`;
    try {
      const members = [...new Set([...this.picked(t), ...this.homeMembers(t)])];
      await setupApi.saveTeam({ ...t, members });
      const { [t.id]: _gone, ...rest } = this.picks;
      this.picks = rest;
      this.notes = { ...this.notes, [t.id]: { ok: true, text: "Saved" } };
      await this.reload();
      refreshNow();
    } catch (e) {
      this.notes = { ...this.notes, [t.id]: { ok: false, text: message(e) } };
    } finally {
      this.busy = null;
    }
  }

  private async createTeam(ev: Event) {
    ev.preventDefault();
    const name = this.newName.trim();
    const id = slug(name);
    const note = (n: Note) => {
      this.notes = { ...this.notes, "new-team": n };
    };
    if (!name || !teamIdPattern.test(id)) {
      note({ ok: false, text: "Name the team, with some letters or digits in it." });
      return;
    }
    const same = this.data?.teams.find(
      (t) => t.id === id || t.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (same) {
      note({ ok: false, text: `There is already a team called ${same.name}. Pick another name.` });
      return;
    }
    this.busy = "new-team";
    try {
      await setupApi.saveTeam({ id, name, members: this.newPicks }, { create: true });
      this.newName = "";
      this.newPicks = [];
      note({ ok: true, text: `Made ${name}` });
      await this.reload();
      refreshNow();
    } catch (e) {
      note({ ok: false, text: message(e) });
    } finally {
      this.busy = null;
    }
  }

  private createForm(people: Person[], teams: Team[]) {
    const open = people.filter((p) => !p.home);
    const teamOf = (id: string) => teams.find((t) => t.members.includes(id))?.name;
    return html`<section class="card" aria-label="Make a team">
      <h3>Make a team</h3>
      <p class="sub">A team shares one sandbox (a machine of its own). Everyone not in a team works in the company's shared one. A personal assistant always has a sandbox of its own, made when it is hired.</p>
      <form @submit=${(ev: Event) => void this.createTeam(ev)}>
        <label>Name
          <input type="text" name="team-name" autocomplete="off" placeholder="Engineering" .value=${this.newName}
            @input=${(e: InputEvent) => {
              this.newName = (e.target as HTMLInputElement).value;
            }} /></label>
        ${
          open.length
            ? html`<fieldset class="field"><legend>Who works in it (optional)</legend>
                ${open.map(
                  (p) => html`<label class="check"><input type="checkbox" name="team-member" value=${p.id}
                    .checked=${this.newPicks.includes(p.id)}
                    @change=${(e: Event) => {
                      const on = (e.target as HTMLInputElement).checked;
                      this.newPicks = on ? [...this.newPicks, p.id] : this.newPicks.filter((m) => m !== p.id);
                    }} />
                    ${p.name}${teamOf(p.id) ? html` <span class="muted">(now in ${teamOf(p.id)})</span>` : ""}</label>`,
                )}</fieldset>`
            : ""
        }
        <div class="actions">
          <button class="btn" type="submit" ?disabled=${this.busy === "new-team"}>Make team</button>
          ${noteLine(this.notes["new-team"])}
        </div>
      </form>
    </section>`;
  }

  private membersEditor(t: Team, people: Person[], teams: Team[]) {
    const open = people.filter((p) => !p.home);
    if (!open.length) return "";
    const picked = this.picked(t);
    const elsewhere = (id: string) => teams.find((x) => x.id !== t.id && x.members.includes(id))?.name;
    return html`<fieldset class="field"><legend>Who works in ${t.name}</legend>
      ${open.map(
        (p) => html`<label class="check"><input type="checkbox" .checked=${picked.includes(p.id)}
          @change=${(e: Event) => this.togglePick(t, p.id, (e.target as HTMLInputElement).checked)} />
          ${p.name}${!picked.includes(p.id) && elsewhere(p.id) ? html` <span class="muted">(now in ${elsewhere(p.id)})</span>` : ""}</label>`,
      )}
      <div class="actions"><button class="btn ghost" type="button"
        ?disabled=${!this.membersDirty(t) || this.busy === `members-${t.id}`} @click=${() => void this.saveMembers(t)}>
        ${this.busy === `members-${t.id}` ? "Saving…" : "Save people"}</button></div>
    </fieldset>`;
  }

  override render() {
    if (this.error) return html`<p role="alert">The daemon isn't answering: ${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Loading teams…</p>`;
    const { teams, names, people } = this.data;
    return html`<div class="stack layout-stack layout-page-band">
      ${teams.length ? "" : html`<p class="muted">No teams yet. Everyone works in the shared company sandbox.</p>`}
      ${teams.map((t) => {
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
        ${this.membersEditor(t, people, teams)}
      </section>`;
      })}
      ${this.createForm(people, teams)}
    </div>`;
  }
}

customElements.define("inc-setup-teams", IncSetupTeams);
