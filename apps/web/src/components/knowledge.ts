// A brain or the handbook (spec §5, "The brain"): its pages, what changed and who taught it, with a
// revert for anything learned. The handbook also holds policy changes waiting for the owner.
import { css, html, type TemplateResult } from "lit";
import { api, type KnowledgeView, type NamedChange, type Page, refreshNow } from "../api.ts";
import { Loader } from "./loader.ts";
import { avatar, base } from "./shared.ts";

export class IncKnowledge extends Loader<KnowledgeView> {
  static override properties = { ...Loader.properties, repo: {}, page: { state: true } };
  /** "handbook", or an employee id for their brain. */
  declare repo: string;
  declare page: string;

  constructor() {
    super();
    this.repo = "handbook";
    this.page = "INDEX.md";
  }

  protected fetch = () => (this.repo === "handbook" ? api.handbook() : api.brain(this.repo));

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
      @media (max-width: 800px) { .wrap { grid-template-columns: 1fr; } nav { flex-direction: row; overflow-x: auto; } }
    `,
  ];

  override render() {
    if (this.error) return html`<p role="alert">${this.error}</p>`;
    if (!this.data)
      return html`<p class="muted">Opening ${this.repo === "handbook" ? "the handbook" : "the brain"}…</p>`;
    const d = this.data;
    const page = d.pages.find((p) => p.path === this.page) ?? d.pages[0];
    return html`
      <div class="head">
        ${d.employee ? avatar(d.employee, 52) : ""}
        <div><h1>${d.employee ? `${d.employee.name}'s brain` : "Handbook"}</h1>
          <span class="muted">${d.employee ? d.employee.role : "What every employee knows"}</span></div>
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
              ? html`<article class="card">${page.path === "INDEX.md" ? "" : html`<span class="path">${page.path}</span>`}${this.markdown(page.text)}</article>`
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
