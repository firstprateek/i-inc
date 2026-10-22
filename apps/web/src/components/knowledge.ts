import { css, html, type TemplateResult } from "lit";
import { ApiError, api, type KnowledgeView, type NamedChange, type Page } from "../api.ts";
import { safeHref } from "../conversations/markdown.ts";
import { brainHash } from "../routes.ts";
import { setupApi } from "../setup-api.ts";
import { friendlyWhen } from "../time.ts";
import { LAYOUT_BREAKPOINTS, layoutStyles } from "./layout.ts";
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
  static override properties = {
    ...Loader.properties,
    repo: {},
    /** The page open, from the address (`?page=`); empty is the map. */
    page: {},
    missing: { state: true },
    confirming: { state: true },
  };
  /** The commit whose Revert was pressed and waits for a yes. */
  declare confirming: string | null;
  /** "handbook", or an employee id for their brain. */
  declare repo: string;
  /** The page open, as the address says (`?page=`); empty is the map (INDEX.md). */
  declare page: string;
  /** The daemon says there is no such brain (an employee who isn't here). */
  declare missing: boolean;

  constructor() {
    super();
    this.repo = "handbook";
    this.page = "";
    this.missing = false;
    this.confirming = null;
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
    try {
      const brain = await api.brain(this.repo);
      this.missing = false;
      return brain;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) this.missing = true;
      throw e;
    }
  };

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("repo") && changed.get("repo") !== undefined) {
      this.missing = false;
      this.confirming = null;
      this.resetLoad();
      void this.reload();
    }
  }

  private get key() {
    return this.repo === "handbook" ? "handbook" : `brain:${this.repo}`;
  }

  static override styles = [
    base,
    layoutStyles,
    css`
      :host { display: block; height: 100%; min-height: 0; }
      .head { display: flex; align-items: center; gap: 14px; margin: 4px 0 18px; }
      .spacer { flex-grow: 1; }
      .company-link, .changes-link { white-space: nowrap; }
      .company-callout {
        padding: 12px 16px;
        background: var(--sunken);
        border-radius: 8px;
        font-size: 14px;
        color: var(--ink-2);
        line-height: 1.4;
      }
      .company-callout a { color: var(--ink); font-weight: 600; text-decoration: underline; }
      .awaiting-note { margin: 0; font-size: 14px; }
      .awaiting-note a { color: var(--ink); font-weight: 600; }
      /* A phone or a finger: the link to Needs you is a 44px target. */
      @media (max-width: 900px), (pointer: coarse) {
        .awaiting-note { display: flex; flex-wrap: wrap; align-items: center; column-gap: 4px; }
        .awaiting-note a { display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; }
      }
      .wrap { grid-template-rows: auto minmax(0, 1fr); gap: var(--layout-section-gap, 20px) var(--layout-gap, 24px); align-items: stretch; }
      .head { grid-column: 1 / -1; margin: 0; }
      nav { padding: 10px; display: flex; flex-direction: column; gap: 2px; border-right: 1px solid var(--line); }
      nav button { all: unset; box-sizing: border-box; padding: 10px 12px; border-radius: 12px; cursor: pointer; font-size: 14px; min-height: 44px;
        display: flex; align-items: center; }
      nav button[aria-current="true"] { background: var(--sunken); font-weight: 700; }
      nav button:focus-visible { outline: 3px solid var(--reviewing-mark); }
      .col { display: flex; flex-direction: column; gap: 20px; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px 4px 20px 0; scrollbar-gutter: stable; }
      .work-state { grid-column: 1 / -1; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; }
      .wrap:has(.work-state) { grid-template-rows: minmax(0, 1fr); }
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
      /* A link to Settings is a 44px target of its own, not a phrase inside a sentence. */
      .settings-link { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; width: fit-content; box-sizing: border-box; text-decoration: none; }
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
      @media (max-width: ${LAYOUT_BREAKPOINTS.split - 1}px) {
        .head { flex-wrap: wrap; }
        .company-link, .changes-link { min-height: 44px; }
        .wrap { grid-template-rows: auto auto minmax(0, 1fr); gap: var(--layout-section-gap, 20px); }
        .head { grid-column: auto; }
        nav { flex-direction: row; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; }
        nav { border-right: 0; border-bottom: 1px solid var(--line); padding: 4px 0 8px; }
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
    location.hash = "#/company/brain";
  };

  override render() {
    if (this.missing) {
      return html`<div class="wrap layout-split"><div class="work-state card" role="alert" style="padding:20px 22px">
        <h2>There is no ${this.repo === "handbook" ? "handbook" : `brain for ${this.repo}`}</h2>
        <p class="muted">${this.repo === "handbook" ? "The handbook isn't here." : "Nobody called that works here, or they were let go."}</p>
        <div><a class="btn" href="#/company/team">See the team</a></div></div></div>`;
    }
    if (this.error)
      return html`<div class="wrap layout-split"><div class="work-state">${this.failure(this.repo === "handbook" ? "the handbook" : "the brain")}</div></div>`;
    if (!this.data)
      return html`<div class="wrap layout-split"><div class="work-state muted" role="status">Opening ${this.repo === "handbook" ? "the handbook" : "the brain"}…</div></div>`;
    const d = this.data;
    const page = d.pages.find((p) => p.path === (this.page || "INDEX.md")) ?? d.pages[0];
    const isHandbook = this.repo === "handbook";
    return html`<div class="wrap layout-split">
      <div class="head">
        ${d.employee ? avatar(d.employee, 52) : ""}
        <div>
          <span class="muted">${isHandbook ? "Organisation-wide knowledge: facts, policies, and team guidelines" : (d.employee?.role ?? "")}</span>
        </div>
        <span class="spacer"></span>
        <a class="btn ghost changes-link" href="#/company/brain/changes"
          style="display:inline-flex;align-items:center;text-decoration:none">Changes</a>
        ${
          !isHandbook
            ? html`<a
                class="btn ghost company-link"
                href="#/company/brain"
                style="display:inline-flex;align-items:center;text-decoration:none"
                @click=${this.onCompanyLinkClick}
                >Company brain →</a
              >`
            : ""
        }
      </div>
        <nav class="card layout-split-sidebar" aria-label="Pages">
          ${d.pages.map(
            (p) => html`<button type="button" aria-current=${p.path === page?.path ? "true" : "false"}
              @click=${() => this.open(p.path)}>${title(p)}</button>`,
          )}
        </nav>
        <div class="col layout-split-work">
          ${this.actionNotice()}
          ${
            (d.awaiting ?? []).length
              ? html`<p class="muted awaiting-note" role="status">${(d.awaiting ?? []).length} policy ${(d.awaiting ?? []).length === 1 ? "change waits" : "changes wait"} for your answer in <a href="#/needs-you">Needs you</a>.</p>`
              : ""
          }
          ${
            page
              ? html`<article class="card">
                  ${
                    !isHandbook && page.path === "INDEX.md"
                      ? html`<div class="company-callout">Part of the organisation. See <a href="#/company/brain" @click=${this.onCompanyLinkClick}>Company brain</a> for shared policies and facts.</div>`
                      : ""
                  }
                  ${page.path === "INDEX.md" ? "" : html`<span class="path">${page.path}</span>`}
                  ${this.markdown(page.text, page.path)}
                </article>`
              : !isHandbook
                ? html`<article class="card">
                    <div class="company-callout">Part of the organisation. See <a href="#/company/brain" @click=${this.onCompanyLinkClick}>Company brain</a> for shared policies and facts.</div>
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
                                      html`<li><a class="member-brain-link" href="#/company/brain/${m.id}">${m.name}</a></li>`,
                                  )}
                                </ul>`
                                : html`<p class="muted">No members yet. Add someone in Company → Settings → Teams.</p>
                                  <a class="btn ghost settings-link" href="#/company/settings/teams">Open Settings → Teams</a>`
                            }
                          </section>`;
                        })}
                      </div>`
                      : html`<p class="muted">No teams yet. Create one in Settings → Teams.</p>
                        <a class="btn ghost settings-link" href="#/company/settings/teams">Open Settings → Teams</a>`
                  }
                </section>`
              : ""
          }
          <section class="card log" aria-label="What changed">
            <h2>What changed</h2>
            ${d.history.map((c) => this.change(c))}
          </section>
        </div>
      </div>`;
  }

  private change(c: NamedChange) {
    const who = c.authorName ? `${c.authorName}${c.ticketId ? `, from #${c.ticketId}` : ""}` : "i.inc";
    return html`<div class="change">
      <span class=${c.reverted ? "undone" : ""}>${describe(c.subject)}</span>
      ${
        c.author && !c.reverted && !c.revert
          ? this.confirming === c.commit
            ? html`<span class="row"><button type="button" class="btn" ?disabled=${this.pressing} @click=${() =>
                this.press(async () => {
                  await api.revert(this.key, c.commit);
                  this.confirming = null;
                })}>Yes, revert</button><button type="button" class="btn ghost" @click=${() => {
                this.confirming = null;
              }}>Keep it</button></span>`
            : html`<button type="button" class="btn ghost" ?disabled=${this.pressing} aria-label="Revert: ${describe(c.subject)}" @click=${() => {
                this.confirming = c.commit;
              }}>Revert</button>`
          : html`<span></span>`
      }
      <small>${who} · ${when(c.at)}${c.reverted ? " · reverted" : ""}</small>
    </div>`;
  }

  /** Just enough markdown for brains: headings, lists, links between pages, and paragraphs. */
  private markdown(text: string, from: string): TemplateResult[] {
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
        list.push(html`<li>${this.inline(t.slice(2), from)}</li>`);
      } else {
        flush();
        out.push(html`<p>${this.inline(t, from)}</p>`);
      }
    }
    flush();
    return out;
  }

  /** Opens a page: it is in the address, so Back returns to the one before and a page can be linked to. */
  private open(path: string) {
    this.page = path;
    const hash = brainHash(this.repo, path);
    if (location.hash !== hash) location.hash = hash;
  }

  /** The page a link on the page being read points at, or null when it isn't one of this brain's pages. */
  private pageFor(target: string, from: string): string | null {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || !/\.md$/.test(target)) return null;
    const pages = this.data?.pages ?? [];
    const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    const resolve = (base: string) => {
      const out: string[] = [];
      for (const part of `${base ? `${base}/` : ""}${target}`.split("/")) {
        if (part === "..") out.pop();
        else if (part && part !== ".") out.push(part);
      }
      return out.join("/");
    };
    // Relative to the page it is on first, then to the brain's root.
    for (const path of [resolve(dir), resolve("")]) if (pages.some((p) => p.path === path)) return path;
    return null;
  }

  /** `[label](page.md)` links open that page, `[label](https://…)` links open in a new tab; the rest is text. */
  private inline(t: string, from = "INDEX.md") {
    const out: (string | ReturnType<typeof html>)[] = [];
    let last = 0;
    for (const m of t.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
      const [whole, label = "", target = ""] = m;
      const at = m.index ?? 0;
      const path = this.pageFor(target, from);
      const href = path ? null : safeHref(target);
      if (!path && !href) continue;
      out.push(t.slice(last, at));
      out.push(
        path
          ? html`<a href=${brainHash(this.repo, path)} @click=${(e: Event) => {
              e.preventDefault();
              this.open(path);
            }}>${label}</a>`
          : html`<a href=${href as string} target="_blank" rel="noopener noreferrer">${label}</a>`,
      );
      last = at + whole.length;
    }
    if (!out.length) return t;
    out.push(t.slice(last));
    return out;
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
  return friendlyWhen(at);
}

customElements.define("inc-knowledge", IncKnowledge);
