// Setup > Projects: how each project's work reaches main, and the checks it must pass.
import { css, html } from "lit";
import { refreshNow } from "../api.ts";
import { type MergeMode, type Project, policyDefaults, setupApi } from "../setup-api.ts";
import { listEditor, message, type Note, noteLine, setupStyles } from "../setup-shared.ts";
import { Loader } from "./loader.ts";
import { base } from "./shared.ts";

interface Draft {
  repo: string;
  mode: MergeMode;
  protectedPaths: string[];
  followUpsPerDay: string;
  checks: string[];
  autoRelease: boolean;
}

const fromProject = (p: Project): Draft => ({
  repo: p.repo,
  mode: p.mode ?? policyDefaults.mode,
  protectedPaths: [...(p.protectedPaths ?? policyDefaults.protectedPaths)],
  followUpsPerDay: String(p.followUpsPerDay ?? policyDefaults.followUpsPerDay),
  checks: [...p.checks],
  autoRelease: p.autoRelease ?? policyDefaults.autoRelease,
});

export class IncSetupProjects extends Loader<Project[]> {
  static override properties = {
    ...Loader.properties,
    drafts: { state: true },
    notes: { state: true },
    busy: { state: true },
  };
  declare drafts: Record<string, Draft>;
  declare notes: Record<string, Note>;
  declare busy: string | null;

  constructor() {
    super();
    this.drafts = {};
    this.notes = {};
    this.busy = null;
  }

  protected fetch = () => setupApi.projects();

  static override styles = [
    base,
    setupStyles,
    css`
      .modes { display: flex; flex-direction: column; gap: 6px; }
    `,
  ];

  private draft(p: Project): Draft {
    return this.drafts[p.id] ?? fromProject(p);
  }

  private dirty(p: Project): boolean {
    const d = this.drafts[p.id];
    return !!d && JSON.stringify(d) !== JSON.stringify(fromProject(p));
  }

  private edit(p: Project, patch: Partial<Draft>) {
    this.drafts = { ...this.drafts, [p.id]: { ...this.draft(p), ...patch } };
    const { [p.id]: _gone, ...rest } = this.notes;
    this.notes = rest;
  }

  private async save(p: Project) {
    const d = this.draft(p);
    const checks = d.checks.map((c) => c.trim()).filter(Boolean);
    const perDay = Number(d.followUpsPerDay);
    const fail = (text: string) => {
      this.notes = { ...this.notes, [p.id]: { ok: false, text } };
    };
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(d.repo.trim()))
      return fail("The repo is owner/name on GitHub.");
    if (!checks.length) return fail("The recipe needs at least one command.");
    if (!Number.isInteger(perDay) || perDay < 0) return fail("Follow-ups per day is a whole number.");
    this.busy = p.id;
    try {
      await setupApi.saveProject(p.id, {
        repo: d.repo.trim(),
        checks,
        mode: d.mode,
        protectedPaths: d.protectedPaths.map((x) => x.trim()).filter(Boolean),
        followUpsPerDay: perDay,
        autoRelease: d.autoRelease,
      });
      const { [p.id]: _gone, ...rest } = this.drafts;
      this.drafts = rest;
      this.notes = { ...this.notes, [p.id]: { ok: true, text: "Saved" } };
      await this.reload();
      refreshNow();
    } catch (e) {
      fail(message(e));
    } finally {
      this.busy = null;
    }
  }

  private card(p: Project) {
    const d = this.draft(p);
    const modeBtn = (m: MergeMode, label: string) =>
      html`<button type="button" aria-pressed=${d.mode === m ? "true" : "false"} @click=${() => this.edit(p, { mode: m })}>${label}</button>`;
    return html`<section class="card" aria-label=${p.id}>
      <div class="head"><h3>${p.id}</h3></div>
      <label>Repo
        <input type="text" class="mono" .value=${d.repo} autocomplete="off" autocapitalize="off" spellcheck="false"
          @input=${(e: InputEvent) => this.edit(p, { repo: (e.target as HTMLInputElement).value })} />
      </label>
      <div class="field">
        <span>How work reaches main</span>
        <div class="seg" role="group" aria-label="Mode">
          ${modeBtn("direct", "Direct")}${modeBtn("owner-merges", "Owner merges")}
        </div>
        <p class="note">${
          d.mode === "direct"
            ? "After a fresh-context review, finished work is pushed straight to main."
            : "Finished work becomes a pull request that you review and merge."
        }</p>
      </div>
      ${listEditor({
        label: "Protected paths",
        noun: "path",
        items: d.protectedPaths,
        mono: true,
        placeholder: ".github/",
        onChange: (protectedPaths) => this.edit(p, { protectedPaths }),
      })}
      <p class="note" style="margin-top:-8px">Changes under these paths wait for your OK before they reach main.</p>
      <label>Follow-ups per day
        <input type="number" inputmode="numeric" min="0" step="1" .value=${d.followUpsPerDay}
          @input=${(e: InputEvent) => this.edit(p, { followUpsPerDay: (e.target as HTMLInputElement).value })} />
      </label>
      ${listEditor({
        label: "Check recipe, in order",
        noun: "command",
        items: d.checks,
        ordered: true,
        mono: true,
        placeholder: "pnpm test",
        onChange: (checks) => this.edit(p, { checks }),
      })}
      <label class="check"><input type="checkbox" .checked=${d.autoRelease}
        @change=${(e: Event) => this.edit(p, { autoRelease: (e.target as HTMLInputElement).checked })} /> Cut releases automatically</label>
      <div class="actions">
        <button class="btn" type="button" ?disabled=${!this.dirty(p) || this.busy === p.id} @click=${() => this.save(p)}>
          ${this.busy === p.id ? "Saving…" : "Save"}</button>
        ${noteLine(this.notes[p.id])}
      </div>
    </section>`;
  }

  override render() {
    if (this.error) return html`<p role="alert">The daemon isn't answering: ${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Loading projects…</p>`;
    if (!this.data.length) return html`<p class="muted">No projects yet.</p>`;
    return html`<div class="stack">${this.data.map((p) => this.card(p))}</div>`;
  }
}

customElements.define("inc-setup-projects", IncSetupProjects);
