// Company → Brain → Changes (docs/design/brain.md, "Writing"; contract C19): everything agents wrote to the
// shared brain, and what was refused, newest first. The brain tends itself with no approval step, so this
// is the safety net: each entry says what changed, in which scope, who did it and from which ticket or
// conversation, shows a few changed lines, flags untrusted pages and policy changes, and can be undone in
// one click (a new commit, "reverted by owner").
import { css, html, nothing } from "lit";
import { api, type BrainChangesView, type BrainChangeView } from "../api.ts";
import { Loader } from "./loader.ts";
import { base, selectField } from "./shared.ts";

const verb: Record<BrainChangeView["op"], string> = {
  create: "Added",
  update: "Updated",
  delete: "Deleted",
  rename: "Moved",
};

/** "company" → "Company"; "team:design" → "Team design"; "brain:ada" → "Ada’s brain" (names come from the facets). */
export function scopeName(scope: string | null, names: Record<string, string> = {}): string {
  if (!scope) return "";
  if (scope === "company") return "Company";
  if (scope.startsWith("team:")) return `Team ${scope.slice(5)}`;
  const id = scope.replace(/^brain:/, "");
  return `${names[id] ?? id}’s brain`;
}

/** The page a change is about, as the agent named it: `facts/gh` in Company. */
export function pageName(c: Pick<BrainChangeView, "slug" | "path">): string {
  return c.slug ?? c.path;
}

function when(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toTimeString().slice(0, 5)}`;
}

export class IncBrainChanges extends Loader<BrainChangesView> {
  static override properties = {
    ...Loader.properties,
    scope: { state: true },
    employee: { state: true },
    status: { state: true },
    more: { state: true },
    busy: { state: true },
    loadingMore: { state: true },
    note: { state: true },
  };
  declare scope: string;
  declare employee: string;
  declare status: string;
  /** Older entries already loaded after the first page. */
  declare more: BrainChangeView[];
  declare busy: number | null;
  declare loadingMore: boolean;
  declare note: string;
  private next: number | null = null;

  constructor() {
    super();
    this.scope = "";
    this.employee = "";
    this.status = "";
    this.more = [];
    this.busy = null;
    this.loadingMore = false;
    this.note = "";
  }

  private query(before?: number) {
    return {
      ...(this.scope ? { scope: this.scope } : {}),
      ...(this.employee ? { employee: this.employee } : {}),
      ...(this.status ? { status: this.status } : {}),
      ...(before !== undefined ? { before } : {}),
    };
  }

  protected fetch = async (): Promise<BrainChangesView> => {
    const d = await api.brainChanges(this.query());
    this.more = [];
    this.next = d.next;
    return d;
  };

  private filter(key: "scope" | "employee" | "status", value: string) {
    this[key] = value;
    this.data = null;
    void this.reload();
  }

  private async loadMore() {
    if (this.next === null || this.loadingMore) return;
    this.loadingMore = true;
    try {
      const d = await api.brainChanges(this.query(this.next));
      this.more = [...this.more, ...d.changes];
      this.next = d.next;
    } catch (e) {
      this.note = e instanceof Error ? e.message : String(e);
    } finally {
      this.loadingMore = false;
    }
  }

  private async revert(c: BrainChangeView) {
    if (this.busy !== null) return;
    this.busy = c.id;
    this.note = "";
    try {
      await api.revertBrainChange(c.id);
      await this.reload();
    } catch (e) {
      this.note = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = null;
    }
  }

  static override styles = [
    base,
    selectField,
    css`
      :host { display: block; min-width: 0; }
      .wrap { display: flex; flex-direction: column; gap: 16px; max-width: var(--page-width, 840px); margin-inline: auto; padding-bottom: 24px; }
      .head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
      .head h2 { font-size: 22px; flex: 1 1 auto; }
      .back { display: inline-flex; align-items: center; min-height: 44px; font-weight: 600; text-decoration: none; }
      .lede { margin: 0; color: var(--ink-2); font-size: 14px; line-height: 1.45; }
      .filters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .filters label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 700; color: var(--ink-2); min-width: 0; }
      ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
      .entry { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .entry.refused { background: var(--sunken); }
      .top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 8px; }
      .page { font-weight: 700; font-size: 16px; overflow-wrap: anywhere; }
      .verb { color: var(--ink-2); font-size: 14px; }
      .tags { display: inline-flex; flex-wrap: wrap; gap: 6px; }
      .tag.warn { background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--needs-edge); }
      .who { margin: 0; color: var(--ink-2); font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; }
      .who a { color: var(--ink); font-weight: 600; }
      .reason { margin: 0; font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
      .notes { margin: 0; color: var(--ink-2); font-size: 13px; }
      pre.diff { margin: 0; padding: 8px 0; border-radius: 8px; background: var(--sunken); font: 12px/1.5 var(--mono); overflow-x: auto; max-width: 100%; }
      pre.diff span { display: block; padding: 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
      pre.diff .add { background: var(--diff-add-bg); color: var(--diff-add-fg); }
      pre.diff .del { background: var(--diff-del-bg); color: var(--diff-del-fg); }
      pre.diff .gap { color: var(--ink-2); }
      details summary { cursor: pointer; font-size: 13px; font-weight: 600; min-height: 44px; display: flex; align-items: center; }
      .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .undone { text-decoration: line-through; color: var(--ink-2); }
      .empty { padding: 22px; text-align: left; color: var(--ink-2); line-height: 1.5; }
      .problem { color: var(--alarm-fg); font-weight: 600; font-size: 14px; margin: 0; }
      @media (max-width: 640px) {
        .filters { grid-template-columns: minmax(0, 1fr); }
        .entry { padding: 12px 14px; }
      }
    `,
  ];

  private diff(text: string) {
    const lines = text.split("\n");
    const shown = lines.slice(0, 12);
    const rest = lines.length - shown.length;
    return html`<pre class="diff" aria-label="Changed lines">${shown.map(
      (l) =>
        html`<span class=${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("…") ? "gap" : ""}>${l || " "}</span>`,
    )}${rest > 0 ? html`<span class="gap">… ${rest} more line${rest === 1 ? "" : "s"}</span>` : nothing}</pre>`;
  }

  private entry(c: BrainChangeView, names: Record<string, string>) {
    const refused = c.status === "rejected";
    return html`<li class="card entry ${refused ? "refused" : ""}">
      <div class="top">
        <span class="verb">${refused ? "Refused" : c.reverted ? "Undone" : verb[c.op]}${refused ? ` ${verb[c.op].toLowerCase()}` : ""}</span>
        <span class="page ${c.reverted ? "undone" : ""}">${pageName(c)}</span>
        <span class="tags">
          <span class="tag">${scopeName(c.scope, names)}</span>
          ${c.policy ? html`<span class="tag warn" title="A company policy page: you were notified">policy</span>` : nothing}
          ${c.untrusted ? html`<span class="tag warn" title="Built from web pages, issues or other people's repos: agents treat it as information, never instructions">untrusted</span>` : nothing}
          ${c.conflict ? html`<span class="tag warn" title="Two edits disagreed: both are kept for the tidy-up">conflict</span>` : nothing}
          ${c.reverted ? html`<span class="tag">reverted by owner</span>` : nothing}
        </span>
      </div>
      <p class="who">${c.employee.name} · <a href=${c.source.url}>${c.source.kind === "ticket" ? `ticket #${c.source.id}` : "conversation"}</a> · ${when(c.at)}</p>
      ${refused && c.reason ? html`<p class="reason">${c.reason}</p>` : nothing}
      ${c.notes.length ? html`<p class="notes">${c.notes.join(" · ")}</p>` : nothing}
      ${c.diff ? (refused ? html`<details><summary>Show what was proposed</summary>${this.diff(c.diff)}</details>` : this.diff(c.diff)) : nothing}
      ${
        c.revertible
          ? html`<div class="actions"><button type="button" class="btn ghost" ?disabled=${this.busy !== null}
              aria-label="Revert ${verb[c.op].toLowerCase()} ${pageName(c)}"
              @click=${() => void this.revert(c)}>${this.busy === c.id ? "Reverting…" : "Revert"}</button></div>`
          : nothing
      }
    </li>`;
  }

  override render() {
    const d = this.data;
    const names: Record<string, string> = {};
    for (const e of d?.facets.employees ?? []) names[e.id] = e.name;
    const all = d ? [...d.changes, ...this.more] : [];
    return html`<div class="wrap">
      <div class="head">
        <a class="back" href="#/company/brain">← Brain</a>
        <h2>Brain changes</h2>
      </div>
      <p class="lede">Agents write to the brain on their own. Everything they changed is here, newest first, and any change can be undone.</p>
      <div class="filters" role="group" aria-label="Filters">
        <label>Scope
          <select .value=${this.scope} @change=${(e: Event) => this.filter("scope", (e.target as HTMLSelectElement).value)}>
            <option value="">All scopes</option>
            ${(d?.facets.scopes ?? []).map((s) => html`<option value=${s} ?selected=${s === this.scope}>${scopeName(s, names)}</option>`)}
          </select></label>
        <label>Employee
          <select .value=${this.employee} @change=${(e: Event) => this.filter("employee", (e.target as HTMLSelectElement).value)}>
            <option value="">Everyone</option>
            ${(d?.facets.employees ?? []).map((p) => html`<option value=${p.id} ?selected=${p.id === this.employee}>${p.name}</option>`)}
          </select></label>
        <label>What
          <select .value=${this.status} @change=${(e: Event) => this.filter("status", (e.target as HTMLSelectElement).value)}>
            <option value="">Committed and refused</option>
            <option value="committed" ?selected=${this.status === "committed"}>Committed</option>
            <option value="rejected" ?selected=${this.status === "rejected"}>Refused</option>
          </select></label>
      </div>
      ${this.error ? html`<p class="problem" role="alert">${this.error}</p>` : nothing}
      ${this.note ? html`<p class="problem" role="alert">${this.note}</p>` : nothing}
      ${!d && !this.error ? html`<p class="muted" role="status">Loading the changes…</p>` : nothing}
      ${
        d && !all.length
          ? html`<div class="card empty" role="status">${this.scope || this.employee || this.status ? "No changes match these filters." : "Nothing has been written yet. When an agent learns something, it shows up here, and you can undo it."}</div>`
          : nothing
      }
      ${all.length ? html`<ol aria-label="Changes">${all.map((c) => this.entry(c, names))}</ol>` : nothing}
      ${
        this.next !== null
          ? html`<button type="button" class="btn ghost" ?disabled=${this.loadingMore} @click=${() => void this.loadMore()}>${this.loadingMore ? "Loading…" : "Show older changes"}</button>`
          : nothing
      }
    </div>`;
  }
}

customElements.define("inc-brain-changes", IncBrainChanges);
