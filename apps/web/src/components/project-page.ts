// One project's page (T62): #/company/projects/<id>. The repo, the mode, the recipe (editable), recent
// tickets and releases, and the two ways to start work: a conversation, or a ticket.
import { css, html } from "lit";
import { refreshNow } from "../api.ts";
import { draftMemo } from "../drafts.ts";
import { ago, conversationHref, type ProjectDetail, problemText, projectsApi } from "../github-projects.ts";
import { type MergeMode, policyDefaults, setupApi } from "../setup-api.ts";
import { listEditor } from "../setup-shared.ts";
import "./new-ticket.ts";
import { Loader } from "./loader.ts";
import { modePicker, projectStyles } from "./project-parts.ts";
import { base } from "./shared.ts";

interface Draft {
  repo: string;
  mode: MergeMode;
  checks: string[];
  protectedPaths: string[];
  followUpsPerDay: string;
  autoRelease: boolean;
}

const fromDetail = (d: ProjectDetail): Draft => ({
  repo: d.project.repo,
  mode: d.policy.mode,
  checks: [...d.project.checks],
  protectedPaths: [...d.policy.protectedPaths],
  followUpsPerDay: String(d.policy.followUpsPerDay ?? policyDefaults.followUpsPerDay),
  autoRelease: d.policy.autoRelease,
});

/** The edits not yet saved, kept per project like an unsent chat message (and forgotten at sign-out). */
const draftKey = (id: string) => `project:${id}`;

function readDraft(id: string): Draft | null {
  try {
    const raw = draftMemo.get(draftKey(id));
    const d = raw ? (JSON.parse(raw) as Partial<Draft>) : null;
    const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
    if (
      !d ||
      typeof d.repo !== "string" ||
      !strings(d.checks) ||
      !strings(d.protectedPaths) ||
      typeof d.followUpsPerDay !== "string" ||
      typeof d.autoRelease !== "boolean" ||
      (d.mode !== "owner-merges" && d.mode !== "direct")
    )
      return null;
    return d as Draft;
  } catch {
    return null;
  }
}

export class IncProjectPage extends Loader<ProjectDetail> {
  static override properties = {
    ...Loader.properties,
    projectId: { type: String },
    draft: { state: true },
    note: { state: true },
    busy: { state: true },
    ticketOpen: { state: true },
    missing: { state: true },
  };
  declare projectId: string;
  declare draft: Draft | null;
  declare note: { ok: boolean; text: string } | null;
  declare busy: "save" | "delete" | null;
  declare ticketOpen: boolean;
  declare missing: boolean;
  private loadedId = "";

  constructor() {
    super();
    this.projectId = "";
    this.draft = null;
    this.note = null;
    this.busy = null;
    this.ticketOpen = false;
    this.missing = false;
  }

  protected fetch = async (): Promise<ProjectDetail> => {
    this.loadedId = this.projectId;
    try {
      const d = await projectsApi.detail(this.projectId);
      this.missing = false;
      // Edits left unsaved (a reload, another page) come back, unless they are what is saved anyway.
      if (this.draft === null) {
        const kept = readDraft(this.projectId);
        if (kept && JSON.stringify(kept) !== JSON.stringify(fromDetail(d))) this.draft = kept;
        else draftMemo.set(draftKey(this.projectId), "");
      }
      return d;
    } catch (e) {
      if ((e as { status?: number }).status === 404) this.missing = true;
      throw e;
    }
  };

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("projectId") && this.isConnected && this.loadedId && this.loadedId !== this.projectId) {
      this.draft = null;
      this.data = null;
      this.note = null;
      this.ticketOpen = false;
      void this.reload();
    }
  }

  static override styles = [
    base,
    projectStyles,
    css`
      .hero { gap: 10px; }
      .hero .top { display: flex; align-items: center; gap: 4px 14px; flex-wrap: wrap; }
      .hero h2 { font-size: 26px; margin: 0; }
      .hero .repo { font-family: var(--mono); font-size: 14px; display: inline-flex; align-items: center; min-height: 44px; color: var(--ink); }
      .facts { display: flex; gap: 8px 10px; flex-wrap: wrap; align-items: center; font-size: 14px; }
      .go { display: flex; gap: 10px; flex-wrap: wrap; }
      table, ul.plain { margin: 0; padding: 0; list-style: none; }
      ul.plain li { display: flex; gap: 4px 12px; align-items: baseline; flex-wrap: wrap; padding: 8px 0; border-top: 1px solid var(--line); min-width: 0; }
      ul.plain li:first-child { border-top: 0; }
      ul.plain a { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; display: inline-flex; align-items: center; min-height: 44px; }
      ul.plain .when { color: var(--ink-2); font-size: 14px; }
      .danger { color: var(--alarm-fg); border-color: var(--alarm-fg); }
      .settings .editor { display: flex; flex-direction: column; gap: 16px; }
    `,
  ];

  private current(d: ProjectDetail): Draft {
    return this.draft ?? fromDetail(d);
  }

  private dirty(d: ProjectDetail): boolean {
    return !!this.draft && JSON.stringify(this.draft) !== JSON.stringify(fromDetail(d));
  }

  private edit(d: ProjectDetail, patch: Partial<Draft>) {
    this.draft = { ...this.current(d), ...patch };
    draftMemo.set(draftKey(d.project.id), JSON.stringify(this.draft));
    this.note = null;
  }

  private discard(d: ProjectDetail) {
    this.draft = null;
    draftMemo.set(draftKey(d.project.id), "");
    this.note = null;
  }

  private async save(d: ProjectDetail) {
    const v = this.current(d);
    const checks = v.checks.map((c) => c.trim()).filter(Boolean);
    const perDay = Number(v.followUpsPerDay);
    const fail = (text: string) => {
      this.note = { ok: false, text };
    };
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(v.repo.trim()))
      return fail("The repo is owner/name on GitHub.");
    if (!checks.length) return fail("The recipe needs at least one command.");
    if (!Number.isInteger(perDay) || perDay < 0) return fail("Follow-ups per day is a whole number.");
    this.busy = "save";
    try {
      await setupApi.saveProject(d.project.id, {
        repo: v.repo.trim(),
        checks,
        mode: v.mode,
        protectedPaths: v.protectedPaths.map((x) => x.trim()).filter(Boolean),
        followUpsPerDay: perDay,
        autoRelease: v.autoRelease,
        ...(d.project.defaultBranch ? { defaultBranch: d.project.defaultBranch } : {}),
      });
      this.draft = null;
      draftMemo.set(draftKey(d.project.id), "");
      this.note = { ok: true, text: "Saved" };
      await this.reload();
      refreshNow();
    } catch (e) {
      fail(problemText(e));
    } finally {
      this.busy = null;
    }
  }

  private async removeProject(d: ProjectDetail) {
    if (!confirm(`Remove ${d.project.id} from i.inc? The repo on GitHub is not touched.`)) return;
    this.busy = "delete";
    try {
      await setupApi.deleteProject(d.project.id);
      refreshNow();
      location.hash = "#/company/projects";
    } catch (e) {
      this.note = { ok: false, text: problemText(e) };
    } finally {
      this.busy = null;
    }
  }

  override render() {
    if (this.missing) {
      return html`<div class="stack"><section class="card"><h2>There is no project called ${this.projectId}</h2>
        <p class="muted">It may have been removed.</p>
        <div><a class="btn" href="#/company/projects">Back to projects</a></div></section></div>`;
    }
    if (this.error) {
      return html`<div class="stack"><p class="callout problem" role="alert">Couldn't load this project: ${this.error}</p>
        <div><button class="btn ghost" type="button" @click=${() => this.reload()}>Try again</button></div></div>`;
    }
    const d = this.data;
    if (!d) return html`<p class="muted" role="status">Loading…</p>`;
    const v = this.current(d);
    const id = d.project.id;
    return html`<div class="stack">
      <section class="card hero" aria-label="${id}">
        <div class="top">
          <h2>${id}</h2>
          ${
            d.repoUrl
              ? html`<a class="repo" href=${d.repoUrl} target="_blank" rel="noopener noreferrer" aria-label="${d.repo} on GitHub (opens GitHub)">${d.repo}<span aria-hidden="true">&nbsp;↗</span></a>`
              : html`<span class="repo">${d.repo}</span>`
          }
        </div>
        <div class="facts">
          <span class="chip">${d.mode === "direct" ? "Direct" : "Owner merges"}</span>
          ${d.defaultBranch ? html`<span class="tag">${d.defaultBranch}</span>` : ""}
          <span class="muted">${d.openTickets} open ${d.openTickets === 1 ? "ticket" : "tickets"}</span>
          ${d.openPrs.map((p) => html`<a class="link" href=${p.url} target="_blank" rel="noopener noreferrer">PR ${p.number ? `#${p.number}` : `for #${p.ticketId}`}</a>`)}
        </div>
        <div class="go">
          <a class="btn" href=${conversationHref(id)}>Start a conversation</a>
          <button class="btn ghost" type="button" aria-expanded=${this.ticketOpen ? "true" : "false"} aria-controls="ticket-form"
            @click=${() => {
              this.ticketOpen = !this.ticketOpen;
            }}>New ticket</button>
        </div>
      </section>
      ${
        this.ticketOpen
          ? html`<div id="ticket-form"><inc-new-ticket .presetProject=${id} .startOpen=${true}></inc-new-ticket></div>`
          : ""
      }
      <section class="card settings" aria-label="Settings">
        <h3>How work is checked and merged</h3>
        <div class="editor">
          ${listEditor({
            label: "Checks, in order",
            noun: "command",
            items: v.checks,
            ordered: true,
            mono: true,
            placeholder: "pnpm test",
            onChange: (checks) => this.edit(d, { checks }),
          })}
          ${modePicker(`mode-${id}`, v.mode, (mode) => this.edit(d, { mode }))}
          <details>
            <summary class="tap">More settings</summary>
            <div class="editor" style="margin-top:12px">
              <label>Repo
                <input type="text" class="mono" .value=${v.repo} autocomplete="off" autocapitalize="off" spellcheck="false"
                  @input=${(e: InputEvent) => this.edit(d, { repo: (e.target as HTMLInputElement).value })} />
              </label>
              ${listEditor({
                label: "Protected paths",
                noun: "path",
                items: v.protectedPaths,
                mono: true,
                placeholder: ".github/",
                onChange: (protectedPaths) => this.edit(d, { protectedPaths }),
              })}
              <p class="hint" style="margin-top:-8px">Changes under these paths wait for your OK before they reach main.</p>
              <label>Follow-ups per day
                <input type="text" inputmode="numeric" .value=${v.followUpsPerDay}
                  @input=${(e: InputEvent) => this.edit(d, { followUpsPerDay: (e.target as HTMLInputElement).value })} />
              </label>
              <label class="check"><input type="checkbox" .checked=${v.autoRelease}
                @change=${(e: Event) => this.edit(d, { autoRelease: (e.target as HTMLInputElement).checked })} /> Cut releases automatically</label>
            </div>
          </details>
          <div class="actions">
            <button class="btn" type="button" ?disabled=${!this.dirty(d) || this.busy === "save"} @click=${() => this.save(d)}>
              ${this.busy === "save" ? "Saving…" : "Save"}</button>
            ${
              this.dirty(d)
                ? html`<span class="hint">Unsaved changes</span>
                  <button class="btn ghost" type="button" ?disabled=${this.busy === "save"} @click=${() => this.discard(d)}>Discard changes</button>`
                : ""
            }
            ${this.note ? html`<span class=${this.note.ok ? "hint" : "error-line"} role=${this.note.ok ? "status" : "alert"}>${this.note.text}</span>` : ""}
          </div>
        </div>
      </section>
      <section class="card" aria-label="Recent tickets">
        <h3>Recent tickets</h3>
        ${
          d.tickets.length === 0
            ? html`<p class="muted">No tickets yet. Start a conversation, or file a ticket above.</p>`
            : html`<ul class="plain">${d.tickets.map(
                (t) => html`<li><a href="#/ticket/${encodeURIComponent(t.id)}">#${t.id} ${t.title}</a>
                  <span class="when">${t.status} · ${ago(t.at)}</span></li>`,
              )}</ul>`
        }
      </section>
      <section class="card" aria-label="Releases">
        <h3>Releases</h3>
        ${
          d.releases.length === 0
            ? html`<p class="muted">No releases yet.</p>`
            : html`<ul class="plain">${d.releases.map(
                (r) =>
                  html`<li><b>${r.tag}</b><span class="when">${ago(r.at)} · ${r.ticketIds.length} ${r.ticketIds.length === 1 ? "ticket" : "tickets"}</span></li>`,
              )}</ul>`
        }
        <div><a class="link" href="#/work/releases">All releases</a></div>
      </section>
      <div>
        <button class="btn ghost danger" type="button" ?disabled=${this.busy === "delete"} @click=${() => this.removeProject(d)}>Remove this project</button>
      </div>
    </div>`;
  }
}

customElements.define("inc-project-page", IncProjectPage);
