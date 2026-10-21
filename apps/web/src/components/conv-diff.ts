// A file edit as a diff: both sides are fetched from the host (`ahp-content:` blobs), diffed here, and shown
// with a few lines of context. Long diffs stop at a screenful with "Show all".
import type { FileEdit } from "@microsoft/agent-host-protocol";
import { css, html, LitElement, nothing } from "lit";
import { ahp } from "../ahp/hub.ts";
import { type DiffRow, diffStats, diffWithContext } from "../conversations/diff.ts";
import { pathOf } from "../conversations/model.ts";
import { cardStyles } from "../conversations/styles.ts";

const SHOW_ROWS = 40;

export class IncConvDiff extends LitElement {
  static override properties = {
    edit: { attribute: false },
    expandAll: { state: true },
    rows: { state: true },
    error: { state: true },
    loading: { state: true },
  };
  declare edit: FileEdit | undefined;
  declare expandAll: boolean;
  declare rows: DiffRow[] | undefined;
  declare error: string | null;
  declare loading: boolean;
  private loadedFor: FileEdit | undefined;

  constructor() {
    super();
    this.expandAll = false;
    this.error = null;
    this.loading = false;
  }

  static override styles = [
    cardStyles,
    css`
      :host { display: block; min-width: 0; }
      .diff { border: 1px solid var(--line); border-radius: 12px; background: var(--code-bg); overflow: hidden; }
      .head { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--line); font: 600 12.5px var(--mono); min-width: 0; }
      .head .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 auto; }
      .plus { color: var(--diff-add-fg); background: var(--diff-add-bg); border-radius: 4px; padding: 0 6px; }
      .minus { color: var(--diff-del-fg); background: var(--diff-del-bg); border-radius: 4px; padding: 0 6px; }
      .rows { overflow-x: auto; font: 12.5px/1.5 var(--mono); font-variant-ligatures: none; max-height: 60vh; overflow-y: auto; }
      .row { display: grid; grid-template-columns: 3.4em 3.4em 1.4em minmax(0, 1fr); min-width: max-content; width: 100%; }
      .row > span { padding: 0 6px; white-space: pre; }
      .no { color: var(--ink-2); text-align: right; user-select: none; -webkit-user-select: none; }
      .sign { text-align: center; user-select: none; -webkit-user-select: none; }
      .row.add { background: var(--diff-add-bg); color: var(--diff-add-fg); }
      .row.del { background: var(--diff-del-bg); color: var(--diff-del-fg); }
      .gap { padding: 2px 12px; color: var(--ink-2); font: 12px var(--body); background: var(--sunken); }
      .more { padding: 6px 12px; border-top: 1px solid var(--line); }
      .note { padding: 10px 12px; color: var(--ink-2); font-size: 13px; }
    `,
  ];

  override updated(): void {
    if (this.edit && this.edit !== this.loadedFor) void this.load();
  }

  private async load(): Promise<void> {
    const edit = this.edit;
    if (!edit) return;
    this.loadedFor = edit;
    this.loading = true;
    this.error = null;
    try {
      const conn = ahp();
      const [before, after] = await Promise.all([
        edit.before
          ? conn.readContent(edit.before.content.uri)
          : Promise.resolve({ text: "", contentType: undefined }),
        edit.after
          ? conn.readContent(edit.after.content.uri)
          : Promise.resolve({ text: "", contentType: undefined }),
      ]);
      if (this.edit !== edit) return;
      this.rows = diffWithContext(before.text ?? "", after.text ?? "", 3);
    } catch (e) {
      if (this.edit !== edit) return;
      this.error = e instanceof Error ? e.message : String(e);
      this.loadedFor = undefined;
    } finally {
      if (this.edit === edit) this.loading = false;
    }
  }

  override render() {
    const edit = this.edit;
    if (!edit) return nothing;
    const uri = edit.after?.uri ?? edit.before?.uri ?? "";
    const stats = this.rows
      ? diffStats(this.rows)
      : { added: edit.diff?.added ?? 0, removed: edit.diff?.removed ?? 0 };
    const rows = this.rows ?? [];
    const shown = this.expandAll ? rows : rows.slice(0, SHOW_ROWS);
    return html`<div class="diff" role="group" aria-label="Changes to ${pathOf(uri)}">
      <div class="head"><span class="path" title=${pathOf(uri)}>${pathOf(uri)}</span>
        <span class="plus" aria-label="${stats.added} lines added">+${stats.added}</span>
        <span class="minus" aria-label="${stats.removed} lines removed">−${stats.removed}</span></div>
      ${
        this.error
          ? html`<div class="note">Couldn't load the diff (${this.error}). <button class="link-btn" type="button" @click=${() => void this.load()}>Try again</button></div>`
          : this.loading && !this.rows
            ? html`<div class="note" role="status">Loading the diff…</div>`
            : rows.length === 0
              ? html`<div class="note">No line changes.</div>`
              : html`<div class="rows" tabindex="0" aria-label="Diff">
                  ${shown.map((r) =>
                    r.kind === "gap"
                      ? html`<div class="gap">${r.count} unchanged ${r.count === 1 ? "line" : "lines"}</div>`
                      : html`<div class="row ${r.kind}"><span class="no" aria-hidden="true">${r.oldNo ?? ""}</span><span class="no" aria-hidden="true">${r.newNo ?? ""}</span><span class="sign" aria-label=${r.kind === "add" ? "added" : r.kind === "del" ? "removed" : "unchanged"}>${r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span><span class="text">${r.text}</span></div>`,
                  )}
                </div>
                ${
                  rows.length > SHOW_ROWS && !this.expandAll
                    ? html`<div class="more"><button class="link-btn" type="button" @click=${() => {
                        this.expandAll = true;
                      }}>Show all ${rows.length} lines</button></div>`
                    : nothing
                }`
      }
    </div>`;
  }
}

customElements.define("inc-conv-diff", IncConvDiff);
