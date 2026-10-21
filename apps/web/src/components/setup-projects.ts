// Company → Projects (T62): every project with a status line, the repos the bot can see but that aren't
// projects yet (each with "Add"), and the way to give the bot more repos. Adding and creating are
// project-flow.ts; one project's page is project-page.ts.
import { css, html } from "lit";
import {
  ADD_PROJECT_HREF,
  addRepoHref,
  ago,
  draftStore,
  type GitHubRepoSummary,
  type GitHubStatus,
  NEW_PROJECT_HREF,
  type NewProjectDraft,
  type ProjectStatus,
  problemText,
  projectHref,
  projectsApi,
} from "../github-projects.ts";
import { GITHUB_INSTALL_URL, GITHUB_MANAGE_URL } from "../setup-api.ts";
import { Loader } from "./loader.ts";
import { problemBox, projectStyles } from "./project-parts.ts";
import { base } from "./shared.ts";

interface ListData {
  projects: ProjectStatus[];
  status: GitHubStatus | null;
  statusError: unknown;
  repos: GitHubRepoSummary[] | null;
  reposError: unknown;
  warning: string | null;
  draft: NewProjectDraft | null;
}

/** More repos than this get a filter box. */
const FILTER_FROM = 8;

export class IncSetupProjects extends Loader<ListData> {
  static override properties = {
    ...Loader.properties,
    filter: { state: true },
    refreshing: { state: true },
    refreshNote: { state: true },
  };
  declare filter: string;
  declare refreshing: boolean;
  declare refreshNote: { ok: boolean; text: string } | null;

  constructor() {
    super();
    this.filter = "";
    this.refreshing = false;
    this.refreshNote = null;
  }

  protected fetch = async (): Promise<ListData> => {
    const [projects, status, repos] = await Promise.all([
      projectsApi.overview(),
      projectsApi.status().then(
        (s) => ({ s }),
        (e: unknown) => ({ e }),
      ),
      projectsApi.repos().then(
        (r) => ({ r }),
        (e: unknown) => ({ e }),
      ),
    ]);
    return {
      projects,
      status: "s" in status ? status.s : null,
      statusError: "e" in status ? status.e : null,
      repos: "r" in repos ? repos.r.repos : null,
      reposError: "e" in repos ? repos.e : null,
      warning: "r" in repos && repos.r.warning ? repos.r.warning.error : null,
      draft: draftStore.read(),
    };
  };

  static override styles = [
    base,
    projectStyles,
    css`
      .conn { gap: 8px; }
      .conn .line { font-size: 15px; line-height: 1.45; }
      .project { gap: 10px; }
      .project h3 { margin: 0; }
      .project h3 a { text-decoration: none; display: inline-flex; align-items: center; min-height: 44px; }
      .project h3 a:hover { text-decoration: underline; }
      .p-head { display: flex; align-items: center; gap: 4px 14px; flex-wrap: wrap; min-width: 0; }
      .p-head .repo { font-family: var(--mono); font-size: 13px; color: var(--ink-2); overflow-wrap: anywhere; display: inline-flex; align-items: center; min-height: 44px; }
      dl.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 0; font-size: 14px; align-items: baseline; }
      dl.facts dt { color: var(--ink-2); font-weight: 600; }
      dl.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
      dl.facts code { background: var(--sunken); padding: 1px 6px; border-radius: 6px; margin-right: 4px; display: inline-block; }
      dl.facts a { color: var(--ink); }
      .teach h3 { margin-bottom: 2px; }
      .teach ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; line-height: 1.4; }
      .repo-row { display: flex; align-items: center; gap: 10px 14px; padding: 10px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
      .repo-row:first-of-type { border-top: 0; }
      .repo-info { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .repo-info .name { font-family: var(--mono); font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
      .repo-info .meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 13px; color: var(--ink-2); }
      .repo-info .desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
      .warn-repo { color: var(--needs-fg); font-weight: 600; }
      @media (max-width: 560px) {
        dl.facts { grid-template-columns: minmax(0, 1fr); gap: 0; }
        dl.facts dd { margin-bottom: 8px; }
      }
    `,
  ];

  private async refreshRepos() {
    this.refreshing = true;
    this.refreshNote = null;
    try {
      const list = await projectsApi.repos(true);
      const data = this.data;
      if (data) {
        this.data = {
          ...data,
          repos: list.repos,
          reposError: null,
          warning: list.warning?.error ?? null,
        };
      }
      const n = list.repos.filter((r) => !r.alreadyRegistered).length;
      this.refreshNote = { ok: true, text: `Updated: ${n} ${n === 1 ? "repo" : "repos"} to add.` };
    } catch (e) {
      this.refreshNote = { ok: false, text: problemText(e) };
    } finally {
      this.refreshing = false;
    }
  }

  private connection(d: ListData) {
    const manage = d.status?.links.manage ?? GITHUB_MANAGE_URL;
    const install = d.status?.links.install ?? GITHUB_INSTALL_URL;
    const inst = d.status?.installation;
    const seen = d.repos?.length;
    let line: unknown;
    if (d.status && !d.status.configured) {
      line = html`<span>The GitHub App isn't set up, so i.inc can't see any repos yet. Install the bot, and follow <code>docs/github-app.md</code> on the Mac mini.</span>`;
    } else if (d.reposError) {
      line = "";
    } else if (inst?.account) {
      line = html`<span>The i.inc bot is installed on <b>${inst.account}</b>${
        inst.accountType === "Organization"
          ? " (an organization)"
          : inst.accountType === "User"
            ? " (a personal account)"
            : ""
      } and can see ${seen === undefined ? "some" : seen} ${seen === 1 ? "repo" : "repos"}.</span>`;
    } else if (seen !== undefined) {
      line = html`<span>The i.inc bot can see ${seen} ${seen === 1 ? "repo" : "repos"}.</span>`;
    }
    return html`<section class="card conn" aria-label="GitHub access">
      ${line ? html`<p class="line">${line}</p>` : ""}
      ${d.reposError ? problemBox(d.reposError, html`<div class="row"><button class="btn ghost" type="button" @click=${() => this.reload()}>Try again</button></div>`) : ""}
      ${d.warning ? html`<p class="callout needs" role="status">${d.warning} The list below is from a little while ago.</p>` : ""}
      ${d.statusError && !d.reposError ? problemBox(d.statusError) : ""}
      <div class="row">
        <a class="link" href=${manage} target="_blank" rel="noopener noreferrer">Give i.inc access to more repos<span class="muted" aria-hidden="true">&nbsp;↗</span><span class="sr"> (opens GitHub)</span></a>
        ${
          d.status && !d.status.configured
            ? html`<a class="link" href=${install} target="_blank" rel="noopener noreferrer">Install the bot on GitHub<span aria-hidden="true">&nbsp;↗</span></a>`
            : ""
        }
        <span class="spacer"></span>
        <button class="btn ghost" type="button" ?disabled=${this.refreshing} @click=${() => this.refreshRepos()}>
          ${this.refreshing ? "Checking GitHub…" : "Refresh repos"}</button>
      </div>
      ${this.refreshNote ? html`<p class=${this.refreshNote.ok ? "hint" : "error-line"} role=${this.refreshNote.ok ? "status" : "alert"}>${this.refreshNote.text}</p>` : ""}
    </section>`;
  }

  private project(p: ProjectStatus, lost: boolean) {
    const shown = p.checks.slice(0, 3);
    const more = p.checks.length - shown.length;
    return html`<article class="card project" aria-label=${p.id}>
      <div class="p-head">
        <h3><a href=${projectHref(p.id)}>${p.id}</a></h3>
        ${
          p.repoUrl
            ? html`<a class="repo" href=${p.repoUrl} target="_blank" rel="noopener noreferrer" aria-label="${p.repo} on GitHub (opens GitHub)">${p.repo}</a>`
            : html`<span class="repo">${p.repo}</span>`
        }
      </div>
      <dl class="facts">
        <dt>Mode</dt>
        <dd><span class="chip">${p.mode === "direct" ? "Direct" : "Owner merges"}</span></dd>
        <dt>Checks</dt>
        <dd>${
          shown.length
            ? html`${shown.map((c) => html`<code>${c}</code>`)}${more > 0 ? html`<span class="muted">+${more} more</span>` : ""}`
            : html`<span class="muted">None yet</span>`
        }</dd>
        <dt>Last ticket</dt>
        <dd>${
          p.lastTicket
            ? html`<a href="#/ticket/${encodeURIComponent(p.lastTicket.id)}">#${p.lastTicket.id} ${p.lastTicket.title}</a>
                <span class="muted">· ${p.lastTicket.status} · ${ago(p.lastTicket.at)}</span>`
            : html`<span class="muted">No tickets yet</span>`
        }</dd>
        ${
          p.openPrs.length
            ? html`<dt>Open PRs</dt>
              <dd>${p.openPrs.slice(0, 4).map((pr, i) => html`${i ? ", " : ""}<a href=${pr.url} target="_blank" rel="noopener noreferrer">${pr.number ? `#${pr.number}` : `ticket #${pr.ticketId}`}</a>`)}${p.openPrs.length > 4 ? html` <span class="muted">+${p.openPrs.length - 4} more</span>` : ""}</dd>`
            : ""
        }
      </dl>
      ${lost ? html`<p class="warn-repo small" role="status">The bot can't see this repo any more. Give i.inc access to it, then refresh.</p>` : ""}
      <div class="actions">
        <a class="btn ghost" href=${projectHref(p.id)} aria-label="Open ${p.id}">Open</a>
      </div>
    </article>`;
  }

  private teach() {
    return html`<section class="card teach" aria-label="What a project is">
      <h3>No projects yet</h3>
      <p>A project is a GitHub repository that i.inc employees work on. Each one has:</p>
      <ul>
        <li><b>Checks</b>: the commands every change must pass before it counts as done.</li>
        <li><b>A mode</b>: <i>Direct</i> pushes finished work to the main branch after review; <i>Owner merges</i> leaves it as a pull request for you to merge.</li>
      </ul>
      <p>Add a repo that already exists, or start a new one from a template.</p>
      <div class="actions">
        <a class="btn" href=${NEW_PROJECT_HREF}>New project</a>
        <a class="btn ghost" href=${ADD_PROJECT_HREF}>Add a repo</a>
      </div>
    </section>`;
  }

  private repos(d: ListData) {
    if (d.repos === null) return "";
    const open = d.repos.filter((r) => !r.alreadyRegistered);
    const q = this.filter.trim().toLowerCase();
    const shown = q ? open.filter((r) => r.fullName.toLowerCase().includes(q)) : open;
    return html`<section class="block" aria-label="Repos to add">
      <h2>Repos you can add</h2>
      ${
        open.length === 0
          ? html`<p class="muted">${
              d.repos.length === 0
                ? "The i.inc bot can't see any repos yet. Give it access on GitHub, then press Refresh repos."
                : "Every repo the bot can see is a project already. To work on another, give i.inc access to it on GitHub, then press Refresh repos."
            }</p>`
          : html`<div class="card">
              ${
                open.length > FILTER_FROM
                  ? html`<label>Find a repo
                      <input type="search" .value=${this.filter} placeholder="Part of a name" autocomplete="off"
                        @input=${(e: InputEvent) => {
                          this.filter = (e.target as HTMLInputElement).value;
                        }} /></label>`
                  : ""
              }
              ${
                shown.length === 0
                  ? html`<p class="muted">No repo matches “${this.filter}”.</p>`
                  : shown.map(
                      (r) => html`<div class="repo-row">
                        <div class="repo-info">
                          <span class="name">${r.fullName}</span>
                          <span class="meta">
                            <span class="tag">${r.private ? "Private" : "Public"}</span>
                            ${r.language ? html`<span class="tag">${r.language}</span>` : ""}
                            ${r.empty ? html`<span class="tag">Empty</span>` : ""}
                          </span>
                          ${r.description ? html`<span class="desc small muted">${r.description}</span>` : ""}
                        </div>
                        <a class="btn ghost" href=${addRepoHref(r.fullName)} aria-label="Add ${r.fullName} as a project">Add</a>
                      </div>`,
                    )
              }
            </div>`
      }
    </section>`;
  }

  override render() {
    if (this.error) {
      return html`<div class="stack"><p class="callout problem" role="alert">Couldn't load the projects: ${this.error}</p>
        <div><button class="btn ghost" type="button" @click=${() => this.reload()}>Try again</button></div></div>`;
    }
    const d = this.data;
    if (!d) return html`<p class="muted" role="status">Loading projects…</p>`;
    const visible = d.repos ? new Set(d.repos.map((r) => r.fullName.toLowerCase())) : null;
    return html`<div class="stack">
      ${
        d.draft
          ? html`<div class="callout needs" role="status">
              <span><b>${d.draft.name}</b> is half way through being started.</span>
              <div class="row"><a class="btn" href=${NEW_PROJECT_HREF}>Carry on</a></div>
            </div>`
          : ""
      }
      ${this.connection(d)}
      <section class="block" aria-label="Your projects">
        <h2>Your projects</h2>
        ${
          d.projects.length === 0
            ? this.teach()
            : d.projects.map((p) =>
                this.project(
                  p,
                  !!visible && d.status?.configured !== false && !visible.has(p.repo.toLowerCase()),
                ),
              )
        }
      </section>
      ${this.repos(d)}
    </div>`;
  }
}

customElements.define("inc-setup-projects", IncSetupProjects);
