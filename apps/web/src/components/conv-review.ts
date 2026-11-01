// The review pane: what a conversation's working copy changes, read from git, so changes made by shell commands
// show too. A file list and a large diff, in the width of the thread and the context panel; one column when
// that is narrow. Pick a line to comment on it: comments stay in this browser until they go with a message.
// Everything shown came from a sandbox, so it is rendered as text, through `visible`.
import { type DiffRow, diffStats, diffWithContext } from "@i-inc/core";
import { css, html, LitElement, nothing } from "lit";
import { ahp } from "../ahp/hub.ts";
import { api, type ChangesView, type Conversation, type FileView, type ReviewFile } from "../api.ts";
import { visible } from "../conversations/model.ts";
import { COMMENT_MAX, fileNote, type LineComment, reviewComments } from "../conversations/review.ts";
import { cardStyles } from "../conversations/styles.ts";
import { base } from "./shared.ts";

/** Rows drawn before "Show all": a whole new file can be tens of thousands. */
const SHOW_ROWS = 1000;

const STATUS_WORD: Record<ReviewFile["status"], string> = {
  added: "new",
  modified: "edited",
  deleted: "deleted",
  "type-changed": "type changed",
};

type LineRow = Exclude<DiffRow, { kind: "gap" }>;

/** The side and number a comment on this row is about. */
const place = (r: LineRow): { side: "new" | "old"; line: number } =>
  r.kind === "del" ? { side: "old", line: r.oldNo ?? 0 } : { side: "new", line: r.newNo ?? 0 };

export class IncConvReview extends LitElement {
  static override properties = {
    conv: { attribute: false },
    name: { type: String },
    phone: { type: Boolean },
    path: { type: String },
    changes: { state: true },
    loadError: { state: true },
    loading: { state: true },
    selected: { state: true },
    reading: { state: true },
    file: { state: true },
    fileError: { state: true },
    fileLoading: { state: true },
    rows: { state: true },
    showAll: { state: true },
    comments: { state: true },
    editing: { state: true },
    running: { state: true },
  };
  declare conv: Conversation | undefined;
  /** The employee's name, for sentences. */
  declare name: string;
  declare phone: boolean;
  /** The file to open with, when the pane was opened from one. */
  declare path: string;
  declare changes: ChangesView | undefined;
  declare loadError: string | null;
  declare loading: boolean;
  declare selected: string | null;
  /** One column: the diff is showing rather than the list. */
  declare reading: boolean;
  declare file: FileView | undefined;
  declare fileError: string | null;
  declare fileLoading: boolean;
  declare rows: DiffRow[];
  declare showAll: boolean;
  declare comments: LineComment[];
  /** The line whose comment box is open. */
  declare editing: { side: "new" | "old"; line: number } | null;
  declare running: boolean;

  private listToken = 0;
  private fileToken = 0;
  private offs: (() => void)[] = [];

  constructor() {
    super();
    this.name = "";
    this.phone = false;
    this.path = "";
    this.loadError = null;
    this.loading = false;
    this.selected = null;
    this.reading = false;
    this.fileError = null;
    this.fileLoading = false;
    this.rows = [];
    this.showAll = false;
    this.comments = [];
    this.editing = null;
    this.running = false;
  }

  static override styles = [
    base,
    cardStyles,
    css`
      :host { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--ground); container-type: inline-size; }
      .head { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 4px 10px; border-bottom: 1px solid var(--line); min-width: 0; }
      .head h2 { margin: 0; font: 700 18px/1.25 var(--display); }
      .sum { flex: 1 1 auto; min-width: 0; color: var(--ink-2); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .x { flex: none; width: 44px; height: 44px; border-radius: 50%; border: 1px solid var(--line-strong); background: transparent; color: var(--ink); cursor: pointer; display: inline-grid; place-items: center; }
      .x:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .x svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
      .say { flex: none; margin: 8px 0 0; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--line); background: var(--sunken); color: var(--ink-2); font-size: 14px; line-height: 1.4; }
      .state { margin: 12vh auto 0; max-width: 46ch; padding: 0 16px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; }
      .state p { margin: 0; color: var(--ink-2); line-height: 1.5; }
      .body { flex: 1 1 0; min-height: 0; display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 12px; padding-top: 10px; }
      .side { min-height: 0; min-width: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 14px; padding-right: 4px; }
      .main { min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
      h3 { font: 800 12px var(--body); text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink-2); margin: 0 0 6px; }
      ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
      .f { all: unset; box-sizing: border-box; width: 100%; min-height: 44px; display: flex; align-items: center; gap: 8px; cursor: pointer; border-radius: 10px; padding: 2px 8px; }
      .f:hover { background: var(--sunken); }
      .f[aria-current="true"] { background: var(--sunken); box-shadow: inset 0 0 0 1px var(--line-strong); }
      .f:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -2px; }
      .f .n { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
      .f .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12.5px var(--mono); direction: rtl; text-align: left; }
      .f .p bdi { direction: ltr; }
      .f small { color: var(--ink-2); font-size: 12px; }
      .plus { color: var(--diff-add-fg); background: var(--diff-add-bg); border-radius: 4px; padding: 0 5px; font: 700 11.5px var(--mono); }
      .minus { color: var(--diff-del-fg); background: var(--diff-del-bg); border-radius: 4px; padding: 0 5px; font: 700 11.5px var(--mono); }
      .c { display: flex; flex-direction: column; gap: 3px; padding: 8px 2px 8px 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); font-size: 14px; line-height: 1.4; min-width: 0; }
      .c + .c { margin-top: 6px; }
      .c .top { display: flex; align-items: center; gap: 4px; min-width: 0; }
      .c .where { flex: 1 1 auto; min-width: 0; text-align: left; font: 600 12.5px var(--mono); overflow-wrap: anywhere; }
      .c blockquote { margin: 0 8px 0 0; color: var(--ink-2); font: 12.5px var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
      .c p { margin: 0 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .rm { flex: none; width: 44px; height: 44px; border: 0; border-radius: 50%; background: transparent; color: var(--ink-2); cursor: pointer; display: inline-grid; place-items: center; }
      .rm:hover { background: var(--sunken); color: var(--ink); }
      .rm:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -3px; }
      .rm svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
      .send { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
      .diff { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 12px; background: var(--code-bg); overflow: hidden; }
      .dh { flex: none; display: flex; align-items: center; gap: 10px; padding: 6px 12px; min-height: 36px; box-sizing: border-box; border-bottom: 1px solid var(--line); font: 600 12.5px var(--mono); min-width: 0; }
      .dh .path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rows { flex: 1 1 0; min-height: 0; overflow: auto; overscroll-behavior: contain; font: 13px/1.55 var(--mono); font-variant-ligatures: none; container-type: inline-size; }
      .rows:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -3px; }
      .in { display: inline-block; min-width: 100%; vertical-align: top; }
      .row { display: grid; grid-template-columns: 7.6em 1.4em minmax(0, 1fr); min-width: max-content; width: 100%; cursor: pointer; }
      .row > span { padding: 0 6px; white-space: pre; }
      .row:hover .no { color: var(--ink); text-decoration: underline; }
      .no { all: unset; box-sizing: border-box; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 0 6px; text-align: right; color: var(--ink-2); cursor: pointer; user-select: none; -webkit-user-select: none; }
      .no:focus-visible { outline: 2px solid var(--reviewing-mark); outline-offset: -2px; }
      .sign { text-align: center; user-select: none; -webkit-user-select: none; }
      .row.add { background: var(--diff-add-bg); color: var(--diff-add-fg); }
      .row.del { background: var(--diff-del-bg); color: var(--diff-del-fg); }
      .row.add .no, .row.del .no { color: inherit; }
      .gap { padding: 2px 12px; color: var(--ink-2); font: 12px var(--body); background: var(--sunken); }
      .more, .note { padding: 10px 12px; color: var(--ink-2); font-size: 14px; }
      .under { position: sticky; left: 0; box-sizing: border-box; width: min(640px, 100cqw); padding: 6px 10px; font: 14px/1.4 var(--body); color: var(--ink); }
      .under .c { background: var(--surface); }
      .box { display: flex; flex-direction: column; gap: 6px; }
      .box textarea { box-sizing: border-box; width: 100%; min-height: 76px; resize: vertical; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--control-edge); background: var(--surface); color: var(--ink); font: 16px/1.4 var(--body); }
      .box textarea:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      .box .acts { display: flex; gap: 8px; flex-wrap: wrap; }
      .back { display: none; }
      @media (pointer: coarse) { .row { line-height: 2; } }
      /* Narrow: one column, the list or the diff. */
      @container (max-width: 680px) {
        .body { grid-template-columns: minmax(0, 1fr); }
        .body.reading .side, .body:not(.reading) .main { display: none; }
        .back { display: inline-flex; align-items: center; align-self: flex-start; }
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("keydown", this.onKey);
    const c = ahp();
    this.running = this.chatRunning();
    this.offs = [
      c.onChange((uris) => {
        const conv = this.conv;
        if (!conv || !uris.has(conv.ahpChat)) return;
        const now = this.chatRunning();
        const ended = this.running && !now;
        this.running = now;
        if (ended) void this.refresh();
      }),
      reviewComments.subscribe((id) => {
        if (id === this.conv?.id) this.comments = reviewComments.list(id);
      }),
    ];
    if (this.conv) this.comments = reviewComments.list(this.conv.id);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("keydown", this.onKey);
    for (const off of this.offs) off();
    this.offs = [];
    super.disconnectedCallback();
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("conv") && (changed.get("conv") as Conversation | undefined)?.id !== this.conv?.id) {
      this.comments = this.conv ? reviewComments.list(this.conv.id) : [];
      this.running = this.chatRunning();
      void this.refresh();
    }
  }

  private chatRunning(): boolean {
    return this.conv ? !!ahp().chat(this.conv.ahpChat)?.activeTurn : false;
  }

  /** Escape closes the pane. A comment box in the way takes it first (its own handler stops it reaching here). */
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    this.close();
  };

  private close() {
    this.dispatchEvent(new CustomEvent("conv-review-close", { bubbles: true, composed: true }));
  }

  focusClose(): void {
    this.renderRoot.querySelector<HTMLElement>(".x")?.focus();
  }

  /** Reads the list again and, when a file is open, that file. Nothing here wakes a machine. */
  async refresh(): Promise<void> {
    const conv = this.conv;
    if (!conv) return;
    const token = ++this.listToken;
    this.loading = true;
    try {
      const changes = await api.changes(conv.id);
      if (token !== this.listToken) return;
      this.changes = changes;
      this.loadError = null;
      if (changes.state !== "ok") return;
      const wanted = this.selected ?? (this.path || null);
      const there = changes.files.some((f) => f.path === wanted);
      if (there && wanted) {
        if (wanted === this.path && !this.selected) this.reading = true;
        await this.open(wanted);
      } else if (!this.phone && changes.files[0]) await this.open(changes.files[0].path);
      else {
        this.selected = null;
        this.file = undefined;
        this.reading = false;
      }
    } catch (e) {
      if (token === this.listToken) this.loadError = e instanceof Error ? e.message : String(e);
    } finally {
      if (token === this.listToken) this.loading = false;
    }
  }

  private async open(path: string): Promise<void> {
    const conv = this.conv;
    if (!conv) return;
    const token = ++this.fileToken;
    if (path !== this.selected) {
      this.file = undefined;
      this.rows = [];
      this.showAll = false;
      this.editing = null;
    }
    this.selected = path;
    this.fileLoading = true;
    this.fileError = null;
    try {
      const file = await api.changedFile(conv.id, path);
      if (token !== this.fileToken) return;
      this.file = file;
      this.rows =
        file.state === "ok" && !fileNote(file)
          ? diffWithContext(file.before.text ?? "", file.after.text ?? "", 3)
          : [];
    } catch (e) {
      if (token === this.fileToken) this.fileError = e instanceof Error ? e.message : String(e);
    } finally {
      if (token === this.fileToken) this.fileLoading = false;
    }
  }

  private pick(path: string) {
    this.reading = true;
    void this.open(path);
    // In one column the button pressed has gone, so focus goes to the way back.
    void this.updateComplete.then(() => {
      const back = this.renderRoot.querySelector<HTMLElement>(".back");
      if (back && getComputedStyle(back).display !== "none") back.focus();
    });
  }

  private backToList() {
    const from = this.selected;
    this.reading = false;
    void this.updateComplete.then(() =>
      [...this.renderRoot.querySelectorAll<HTMLElement>(".f")].find((b) => b.dataset.path === from)?.focus(),
    );
  }

  /** A click on a line opens its comment box, unless it ended a text selection. */
  private onRows = (e: Event) => {
    if (!getSelection()?.isCollapsed) return;
    const row = (e.target as HTMLElement).closest?.<HTMLElement>("[data-i]");
    const r = this.rows[Number(row?.dataset.i)];
    if (!row || !r || r.kind === "gap") return;
    this.editing = place(r);
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(".box textarea")?.focus());
  };

  private cancelEdit(at: { side: string; line: number }) {
    this.editing = null;
    void this.updateComplete.then(() =>
      this.renderRoot.querySelector<HTMLElement>(`[data-at="${at.side}-${at.line}"] .no`)?.focus(),
    );
  }

  private addComment(r: LineRow, text: string) {
    const conv = this.conv;
    const path = this.selected;
    if (!conv || !path || !text.trim()) return;
    const at = place(r);
    reviewComments.add(conv.id, { path, ...at, quote: r.text.trim(), text });
    this.cancelEdit(at);
  }

  private box(r: LineRow) {
    const at = place(r);
    const submit = (ta: HTMLTextAreaElement | null | undefined) => this.addComment(r, ta?.value ?? "");
    return html`<div class="under"><div class="box">
      <textarea aria-label="Comment on line ${at.line}" maxlength=${COMMENT_MAX} placeholder="Your comment"
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            e.preventDefault();
            this.cancelEdit(at);
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit(e.target as HTMLTextAreaElement);
          }
        }}></textarea>
      <div class="acts"><button class="cbtn primary" type="button" @click=${(e: Event) =>
        submit((e.target as HTMLElement).closest(".box")?.querySelector("textarea"))}>Add comment</button>
        <button class="cbtn" type="button" @click=${() => this.cancelEdit(at)}>Cancel</button></div>
    </div></div>`;
  }

  private comment(c: LineComment, jump: boolean) {
    return html`<div class="c"><div class="top">
        ${
          jump
            ? html`<button class="link-btn where" type="button" @click=${() => this.pick(c.path)}>${visible(c.path)}:${c.line}${c.side === "old" ? " (removed)" : ""}</button>`
            : html`<span class="where">${c.side === "old" ? "Removed line" : "Line"} ${c.line}</span>`
        }
        <button class="rm" type="button" aria-label="Remove comment on ${visible(c.path)} ${c.side === "old" ? "removed line" : "line"} ${c.line}"
          @click=${() => this.conv && reviewComments.remove(this.conv.id, [c.id])}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg></button></div>
      ${jump ? html`<blockquote>${visible(c.quote)}</blockquote>` : nothing}
      <p>${c.text}</p></div>`;
  }

  private line(r: LineRow, i: number) {
    const at = place(r);
    const here = this.comments.filter(
      (c) => c.path === this.selected && c.side === at.side && c.line === at.line,
    );
    const editing = this.editing?.side === at.side && this.editing.line === at.line;
    return html`<div class="row ${r.kind}" data-i=${i} data-at="${at.side}-${at.line}">
        <button class="no" type="button" aria-label="Comment on line ${at.line}"><span>${r.oldNo ?? ""}</span><span>${r.newNo ?? ""}</span></button>
        <span class="sign" aria-label=${r.kind === "add" ? "added" : r.kind === "del" ? "removed" : "unchanged"}>${r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
        <span class="text">${visible(r.text)}</span></div>
      ${here.length ? html`<div class="under">${here.map((c) => this.comment(c, false))}</div>` : nothing}
      ${editing ? this.box(r) : nothing}`;
  }

  private diff() {
    const f = this.file;
    const path = this.selected;
    if (!path) return html`<p class="note">Pick a file to see its changes.</p>`;
    const stats = diffStats(this.rows);
    const note = f ? fileNote(f) : null;
    const shown = this.showAll ? this.rows : this.rows.slice(0, SHOW_ROWS);
    return html`<div class="diff" role="group" aria-label="Changes to ${visible(path)}">
      <div class="dh"><span class="path" title=${visible(path)}>${visible(path)}</span>
        ${this.rows.length ? html`<span class="plus" aria-label="${stats.added} lines added">+${stats.added}</span><span class="minus" aria-label="${stats.removed} lines removed">−${stats.removed}</span>` : nothing}</div>
      ${
        this.fileError
          ? html`<p class="note">Couldn't load this file (${this.fileError}). <button class="link-btn" type="button" @click=${() => void this.open(path)}>Try again</button></p>`
          : f && f.state !== "ok"
            ? html`<p class="note" role="status">${f.reason} <button class="link-btn" type="button" @click=${() => void this.open(path)}>Try again</button></p>`
            : !f
              ? html`<p class="note" role="status">Loading the file…</p>`
              : note
                ? html`<p class="note">${note}</p>`
                : !this.rows.length
                  ? html`<p class="note">No line changes.</p>`
                  : html`<div class="rows" tabindex="0" aria-label="Diff. Pick a line number to comment on it." @click=${this.onRows}><div class="in">
                      ${shown.map((r, i) =>
                        r.kind === "gap"
                          ? html`<div class="gap">${r.count} unchanged ${r.count === 1 ? "line" : "lines"}</div>`
                          : this.line(r, i),
                      )}
                      ${
                        this.rows.length > SHOW_ROWS && !this.showAll
                          ? html`<div class="more"><button class="link-btn" type="button" @click=${(
                              e: Event,
                            ) => {
                              e.stopPropagation();
                              this.showAll = true;
                            }}>Show all ${this.rows.length} lines</button></div>`
                          : nothing
                      }
                    </div></div>`
      }
    </div>`;
  }

  private list(files: ReviewFile[]) {
    const n = (path: string) => this.comments.filter((c) => c.path === path).length;
    return html`<section aria-labelledby="h-files"><h3 id="h-files">Files · ${files.length}</h3>
      <ul>${files.map(
        (
          f,
        ) => html`<li><button class="f" type="button" data-path=${f.path} aria-current=${f.path === this.selected ? "true" : "false"} @click=${() => this.pick(f.path)}>
          <span class="n"><span class="p" title=${visible(f.path)}><bdi>${visible(f.path)}</bdi></span>
            <small>${STATUS_WORD[f.status]}${n(f.path) ? ` · ${n(f.path)} ${n(f.path) === 1 ? "comment" : "comments"}` : ""}</small></span>
          ${f.added ? html`<span class="plus">+${f.added}</span>` : nothing}${f.removed ? html`<span class="minus">−${f.removed}</span>` : nothing}</button></li>`,
      )}</ul></section>`;
  }

  private commentList() {
    const list = this.comments;
    if (!list.length) return nothing;
    return html`<section aria-labelledby="h-comments"><h3 id="h-comments">Comments · ${list.length}</h3>
      ${list.map((c) => this.comment(c, true))}
      <div class="send"><button class="cbtn primary" type="button" @click=${() =>
        this.dispatchEvent(
          new CustomEvent("conv-send-comments", { bubbles: true, composed: true }),
        )}>${this.running ? "Queue comments" : "Send comments"}</button></div></section>`;
  }

  private content() {
    const c = this.changes;
    if (this.loadError) {
      return html`<div class="state" role="alert"><p>Couldn't read the changes (${this.loadError}).</p>
        <button class="cbtn" type="button" @click=${() => void this.refresh()}>Try again</button></div>`;
    }
    if (!c) return html`<div class="state" role="status"><p>Reading the changes…</p></div>`;
    if (c.state === "asleep" || c.state === "busy" || c.state === "failed") {
      return html`<div class="state" role="status"><p>${c.reason}</p>
        <button class="cbtn" type="button" ?disabled=${this.loading} @click=${() => void this.refresh()}>Try again</button></div>${this.comments.length ? html`<div class="side">${this.commentList()}</div>` : nothing}`;
    }
    if (!c.files.length) {
      const empty =
        c.reason ?? (c.noProject ? "Nothing in this conversation's folder yet." : "Nothing has changed yet.");
      return html`<div class="state"><p>${empty}</p></div>${this.comments.length ? html`<div class="side">${this.commentList()}</div>` : nothing}`;
    }
    return html`<div class="body ${this.reading ? "reading" : ""}">
      <div class="side">
        ${this.list(c.files)}
        ${c.skipped ? html`<p class="say">${c.skipped === 1 ? "1 file has" : `${c.skipped} files have`} a name that isn't safe to show.</p>` : nothing}
        ${c.truncated ? html`<p class="say">Only the first ${c.files.length} files are listed.</p>` : nothing}
        ${this.commentList()}
      </div>
      <div class="main"><button class="cbtn back" type="button" @click=${() => this.backToList()}>All files</button>${this.diff()}</div>
    </div>`;
  }

  override render() {
    const files = this.changes?.files ?? [];
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    return html`<div class="head"><h2>Changes</h2>
        <span class="sum">${files.length ? `${files.length} ${files.length === 1 ? "file" : "files"} · +${added} −${removed}` : ""}</span>
        <button class="cbtn" type="button" ?disabled=${this.loading} @click=${() => void this.refresh()}>${this.loading ? "Reading…" : "Refresh"}</button>
        <button class="x" type="button" aria-label="Close changes" @click=${() => this.close()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      ${this.running ? html`<p class="say" role="status">${this.name || "The agent"} is working, so this can change. It refreshes when the turn ends.</p>` : nothing}
      ${this.content()}`;
  }
}

customElements.define("inc-conv-review", IncConvReview);
