import { css, html, type TemplateResult } from "lit";
import { api, type KnowledgeView, type NamedChange, type Page, refreshNow } from "../api.ts";
import { setupApi } from "../setup-api.ts";
import { Loader } from "./loader.ts";
import { avatar, base } from "./shared.ts";

export interface TeamMember {
  id: string;
  name?: string;
}

export interface TeamItem {
  id: string;
  name: string;
  members: (string | TeamMember)[];
}

export interface KnowledgeData extends KnowledgeView {
  teams?: TeamItem[];
  employeeNames?: Record<string, string>;
}

export class IncKnowledge extends Loader<KnowledgeData> {
  static override properties = { ...Loader.properties, repo: {}, page: { state: true } };
  /** "handbook", or an employee id for their brain. */
  declare repo: string;
  declare page: string;

  constructor() {
    super();
    this.repo = "handbook";
    this.page = "INDEX.md";
  }

  protected fetch = async (): Promise<KnowledgeData> => {
    if (this.repo === "handbook") {
      const [handbook, teamsData, officeData] = await Promise.all([
        api.handbook(),
        setupApi.teams().catch(() => []),
        api.office().catch(() => null),
      ]);
      const employeeNames: Record<string, string> = {};
      for (const e of officeData?.employees ?? []) {
        employeeNames[e.id] = e.name;
      }
      const teams = Array.isArray(teamsData)
        ? teamsData
        : ((teamsData as { teams?: TeamItem[] })?.teams ?? []);
      return {
        ...handbook,
        teams: teams as TeamItem[],
        employeeNames,
      };
    }
    return api.brain(this.repo);
  };

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("repo") && changed.get("repo") !== undefined) {
      this.page = "INDEX.md";
      this.data = null;
      void this.reload();
    }
  }

  private get key() {
    return this.repo === "handbook" ? "handbook" : `brain:${this.repo}`;
  }

  private async act(fn: () => Promise<unknown>) {
    try {
      await fn();
      refreshNow();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  static override styles = [
    base,
    css`
      .head { display: flex; align-items: center; gap: 14px; margin: 4px 0 18px; }
      .head h1 { font-size: 30px; }
      .spacer { flex-grow: 1; }
      .company-link { white-space: nowrap; }
      .company-callout {
        padding: 12px 16px;
        background: var(--sunken);
        border-radius: 8px;
        font-size: 14px;
        color: var(--ink-2);
        line-height: 1.4;
      }
      .company-callout a { color: var(--ink); font-weight: 600; text-decoration: underline; }
      .wrap { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 20px; align-items: start; }
      nav { padding: 10px; display: flex; flex-direction: column; gap: 2px; }
      nav button { all: unset; box-sizing: border-box; padding: 10px 12px; border-radius: 12px; cursor: pointer; font-size: 14px; min-height: 44px;
        display: flex; align-items: center; }
      nav button[aria-current="true"] { background: var(--sunken); font-weight: 700; }
      nav button:focus-visible { outline: 3px solid var(--reviewing-mark); }
      .col { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
      article { padding: 22px 26px; display: flex; flex-direction: column; gap: 10px; line-height: 1.5; }
      article h2 { font-size: 24px; }
      article h3 { font-size: 17px; margin-top: 8px; }
      article ul { margin: 0; padding-left: 20px; }
      article a { cursor: pointer; }
      .path { font-family: var(--mono); font-size: 12px; color: var(--ink-2); }
      section.teams { padding: 18px 22px; display: flex; flex-direction: column; gap: 14px; }
      section.teams h2 { font-size: 20px; }
      .teams-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
      .team-section { background: var(--sunken); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
      .team-section h3 { font-size: 16px; margin: 0; }
      .team-members { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
      .team-members li a { color: var(--ink); font-weight: 600; text-decoration: none; }
      .team-members li a:hover { text-decoration: underline; }
      section.log { padding: 18px 22px; display: flex; flex-direction: column; gap: 4px; }
      .change { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; padding: 10px 0;
        border-top: 1px solid var(--line); }
      .change:first-of-type { border-top: none; }
      .change small { color: var(--ink-2); font-size: 13px; }
      .change .btn { grid-row: span 2; }
      .change .undone { text-decoration: line-through; color: var(--ink-2); }
      .waiting { background: var(--needs-surface); border: 2px solid var(--needs-edge); padding: 16px 20px; display: flex;
        flex-direction: column; gap: 10px; }
      .waiting blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--line-strong); }
      .row { display: flex; gap: 8px; }
      article, .change > span, .waiting blockquote { overflow-wrap: anywhere; }
      @media (max-width: 800px) {
        .head { flex-wrap: wrap; }
        .head h1 { font-size: 26px; }
        .company-link { min-height: 44px; }
        .wrap { grid-template-columns: 1fr; gap: 16px; }
        nav { flex-direction: row; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; }
        nav::-webkit-scrollbar { display: none; }
        nav button { flex-shrink: 0; white-space: nowrap; }
        article { padding: 18px; }
        section.teams { padding: 16px 18px; }
        .teams-list { grid-template-columns: 1fr; }
        .team-members li a { display: inline-flex; align-items: center; min-height: 44px; }
        section.log { padding: 16px 18px; }
        /* Links inside a page get a 44px row, so they're easy to hit. */
        article li a, article p a { display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; }
        .waiting .row .btn { flex: 1; }
      }
    `,
  ];

  private onCompanyLinkClick = () => {
    location.hash = "#/handbook";
  };

  override render() {
    if (this.error) return html`<p role="alert">${this.error}</p>`;
    if (!this.data)
      return html`<p class="muted">Opening ${this.repo === "handbook" ? "the handbook" : "the brain"}…</p>`;
    const d = this.data;
    const page = d.pages.find((p) => p.path === this.page) ?? d.pages[0];
    const isHandbook = this.repo === "handbook";
    return html`
      <div class="head">
        ${d.employee ? avatar(d.employee, 52) : ""}
        <div>
          <h1>${isHandbook ? "Company brain / Handbook" : d.employee ? `${d.employee.name}'s brain` : "Brain"}</h1>
          <span class="muted">${isHandbook ? "Organisation-wide knowledge: facts, policies, and team guidelines" : (d.employee?.role ?? "")}</span>
        </div>
        ${
          !isHandbook
            ? html`<span class="spacer"></span>
              <a
                class="btn ghost company-link"
                href="#/handbook"
                style="display:inline-flex;align-items:center;text-decoration:none"
                @click=${this.onCompanyLinkClick}
                >Company brain / Handbook →</a
              >`
            : ""
        }
      </div>
      <div class="wrap">
        <nav class="card" aria-label="Pages">
          ${d.pages.map(
            (p) => html`<button type="button" aria-current=${p.path === page?.path ? "true" : "false"}
              @click=${() => {
                this.page = p.path;
              }}>${title(p)}</button>`,
          )}
        </nav>
        <div class="col">
          ${(d.awaiting ?? []).map(
            (p) => html`<section class="card waiting" aria-label="Policy change from ${p.author}">
              <b>${p.author} proposes a change to the ${p.page} policy</b>
              <blockquote>${p.text}</blockquote>
              <div class="row">
                <button class="btn" @click=${() => this.act(() => api.decidePolicy(p.id, true))}>Approve</button>
                <button class="btn ghost" @click=${() => this.act(() => api.decidePolicy(p.id, false))}>Decline</button>
              </div>
            </section>`,
          )}
          ${
            page
              ? html`<article class="card">
                  ${
                    !isHandbook && page.path === "INDEX.md"
                      ? html`<div class="company-callout">Part of the organisation. See <a href="#/handbook" @click=${this.onCompanyLinkClick}>Company brain / Handbook</a> for shared policies and facts.</div>`
                      : ""
                  }
                  ${page.path === "INDEX.md" ? "" : html`<span class="path">${page.path}</span>`}
                  ${this.markdown(page.text)}
                </article>`
              : !isHandbook
                ? html`<article class="card">
                    <div class="company-callout">Part of the organisation. See <a href="#/handbook" @click=${this.onCompanyLinkClick}>Company brain / Handbook</a> for shared policies and facts.</div>
                  </article>`
                : ""
          }
          ${
            isHandbook
              ? html`<section class="card teams" aria-label="Teams">
                  <h2>Teams</h2>
                  ${
                    d.teams && d.teams.length > 0
                      ? html`<div class="teams-list">
                        ${d.teams.map((t) => {
                          const members = (t.members ?? []).map((m) => normalizeMember(m, d.employeeNames));
                          return html`<section class="team-section" aria-label=${t.name}>
                            <h3>${t.name}</h3>
                            ${
                              members.length > 0
                                ? html`<ul class="team-members">
                                  ${members.map(
                                    (m) =>
                                      html`<li><a class="member-brain-link" href="#/brain/${m.id}">${m.name}</a></li>`,
                                  )}
                                </ul>`
                                : html`<p class="muted">No members</p>`
                            }
                          </section>`;
                        })}
                      </div>`
                      : html`<p class="muted">No teams configured</p>`
                  }
                </section>`
              : ""
          }
          <section class="card log" aria-label="What changed">
            <h2>What changed</h2>
            ${d.history.map((c) => this.change(c))}
          </section>
        </div>
      </div>
    `;
  }

  private change(c: NamedChange) {
    const who = c.authorName ? `${c.authorName}${c.ticketId ? `, from #${c.ticketId}` : ""}` : "i.inc";
    return html`<div class="change">
      <span class=${c.reverted ? "undone" : ""}>${describe(c.subject)}</span>
      ${
        c.author && !c.reverted && !c.revert
          ? html`<button class="btn ghost" @click=${() => this.act(() => api.revert(this.key, c.commit))}>Revert</button>`
          : html`<span></span>`
      }
      <small>${who} · ${when(c.at)}${c.reverted ? " · reverted" : ""}</small>
    </div>`;
  }

  /** Just enough markdown for brains: headings, lists, links between pages, and paragraphs. */
  private markdown(text: string): TemplateResult[] {
    const out: TemplateResult[] = [];
    let list: TemplateResult[] = [];
    const flush = () => {
      if (list.length) out.push(html`<ul>${list}</ul>`);
      list = [];
    };
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) {
        flush();
        continue;
      }
      if (t.startsWith("# ")) {
        flush();
        out.push(html`<h2>${t.slice(2)}</h2>`);
      } else if (t.startsWith("## ")) {
        flush();
        out.push(html`<h3>${t.slice(3)}</h3>`);
      } else if (t.startsWith("- ")) {
        list.push(html`<li>${this.inline(t.slice(2))}</li>`);
      } else {
        flush();
        out.push(html`<p>${this.inline(t)}</p>`);
      }
    }
    flush();
    return out;
  }

  /** A `[label](page.md)` link opens that page; anything else is text. */
  private inline(t: string) {
    const m = t.match(/^\[([^\]]+)\]\(([^)]+\.md)\)$/);
    if (!m) return t;
    const [, label, path] = m;
    return html`<a href=${`#/${this.repo === "handbook" ? "handbook" : `brain/${this.repo}`}`} @click=${(
      e: Event,
    ) => {
      e.preventDefault();
      this.page = path ?? "INDEX.md";
    }}>${label}</a>`;
  }
}

function normalizeMember(
  m: string | TeamMember,
  names: Record<string, string> = {},
): { id: string; name: string } {
  if (typeof m === "string") {
    return { id: m, name: names[m] || m };
  }
  if (typeof m === "object" && m !== null) {
    const id = m.id || "";
    return { id, name: m.name || names[id] || id };
  }
  return { id: String(m), name: String(m) };
}

/** "Add facts/duet-money.md" → "Added the fact “Duet money”". Other subjects read as they are. */
export function describe(subject: string): string {
  const m = subject.match(/^(Add|Update) (?:(\w+)\/)?([\w-]+)\.md$/);
  if (!m) return subject;
  const [, verb, folder, slug = ""] = m;
  const name = slug.replace(/-/g, " ");
  const kind = folder === "facts" ? "the fact" : folder === "policies" ? "the policy" : "the page";
  return `${verb === "Add" ? "Added" : "Updated"} ${kind} “${name.charAt(0).toUpperCase()}${name.slice(1)}”`;
}

function title(p: Page): string {
  if (p.path === "INDEX.md") return "Map";
  const h = p.text.match(/^# (.+)$/m)?.[1];
  return h ?? p.path;
}

function when(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toTimeString().slice(0, 5)}`;
}

customElements.define("inc-knowledge", IncKnowledge);
