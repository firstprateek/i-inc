// The Files and Search tabs of the review pane: the working copy as it is, whether or not it changed. A tree with a
// filter or a list of search results beside a read-only viewer; one column when that is narrow. Everything shown came
// from a sandbox, so it is rendered as text, through `visible`. Nothing here wakes a machine.
import { css, html, LitElement, nothing } from "lit";
import { api, type FilesView, type OpenFileView, type SearchView } from "../api.ts";
import {
  buildTree,
  codeLines,
  foldersOf,
  groupHits,
  langOf,
  matchParts,
  matchPaths,
  openNote,
  type TreeNode,
  type TreeRow,
  treeRows,
} from "../conversations/files.ts";
import type { Token } from "../conversations/highlight.ts";
import { visible } from "../conversations/model.ts";
import { cardStyles, markdownStyles } from "../conversations/styles.ts";
import { base } from "./shared.ts";

/** Rows of the tree or matches drawn at a time: a list can be 20,000 paths. */
export const LIST_ROWS = 400;
/** A file's lines drawn at a time, around the line asked for. */
export const VIEW_LINES = 1000;

export interface FileTarget {
  path: string;
  line?: number;
}

export class IncConvFiles extends LitElement {
  static override properties = {
    conversationId: { type: String },
    mode: { type: String },
    target: { attribute: false },
    list: { state: true },
    listError: { state: true },
    listLoading: { state: true },
    filter: { state: true },
    open: { state: true },
    shown: { state: true },
    focused: { state: true },
    selected: { state: true },
    file: { state: true },
    fileError: { state: true },
    fileLoading: { state: true },
    from: { state: true },
    to: { state: true },
    line: { state: true },
    reading: { state: true },
    query: { state: true },
    matchCase: { state: true },
    result: { state: true },
    searched: { state: true },
    searchError: { state: true },
    searching: { state: true },
  };
  declare conversationId: string;
  declare mode: "files" | "search";
  /** The file to open, and the line to open it at. */
  declare target: FileTarget | null;
  declare list: FilesView | undefined;
  declare listError: string | null;
  declare listLoading: boolean;
  declare filter: string;
  /** The folders open in the tree. */
  declare open: Set<string>;
  declare shown: number;
  /** The tree row that holds the tab stop. */
  declare focused: string;
  declare selected: string | null;
  declare file: OpenFileView | undefined;
  declare fileError: string | null;
  declare fileLoading: boolean;
  declare from: number;
  declare to: number;
  /** The line asked for, 1-based. */
  declare line: number;
  /** One column: the file is showing rather than the list. */
  declare reading: boolean;
  declare query: string;
  declare matchCase: boolean;
  declare result: SearchView | undefined;
  /** What `result` is the answer to: the box may have moved on. */
  declare searched: { query: string; matchCase: boolean } | undefined;
  declare searchError: string | null;
  declare searching: boolean;

  private tree: TreeNode = buildTree([]);
  private lines: Token[][] = [];
  private fileToken = 0;
  private listToken = 0;
  private searchToken = 0;

  constructor() {
    super();
    this.conversationId = "";
    this.mode = "files";
    this.target = null;
    this.listError = null;
    this.listLoading = false;
    this.filter = "";
    this.open = new Set();
    this.shown = LIST_ROWS;
    this.focused = "";
    this.selected = null;
    this.fileError = null;
    this.fileLoading = false;
    this.from = 0;
    this.to = VIEW_LINES;
    this.line = 0;
    this.reading = false;
    this.query = "";
    this.matchCase = false;
    this.searchError = null;
    this.searching = false;
  }

  static override styles = [
    base,
    cardStyles,
    markdownStyles,
    css`
      :host { display: flex; flex-direction: column; flex: 1 1 0; min-width: 0; min-height: 0; container-type: inline-size; }
      .body { flex: 1 1 0; min-height: 0; display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 12px; padding-top: 10px; }
      .side { min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
      .main { min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
      .tools { flex: none; display: flex; gap: 8px; align-items: center; min-width: 0; }
      .tools input[type="search"], .tools input[type="text"] { flex: 1 1 auto; min-width: 0; box-sizing: border-box; min-height: 44px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--control-edge); background: var(--surface); color: var(--ink); font: 16px var(--body); }
      .tools input:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
      .case { flex: none; display: flex; align-items: center; gap: 8px; min-height: 44px; font-size: 14px; color: var(--ink-2); }
      .case input { width: 18px; height: 18px; margin: 0; accent-color: var(--ink); }
      .scroll { flex: 1 1 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 2px; padding-right: 4px; }
      .say { margin: 0; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--line); background: var(--sunken); color: var(--ink-2); font-size: 14px; line-height: 1.4; }
      .quiet { margin: 0; padding: 8px 4px; color: var(--ink-2); font-size: 14px; line-height: 1.4; }
      .state { margin: 12vh auto 0; max-width: 46ch; padding: 0 16px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; }
      .state p { margin: 0; color: var(--ink-2); line-height: 1.5; }
      .t { all: unset; box-sizing: border-box; width: 100%; min-height: 34px; display: flex; align-items: center; gap: 6px; cursor: pointer; border-radius: 8px; padding: 2px 8px; font: 13px var(--mono); min-width: 0; }
      @media (pointer: coarse) { .t { min-height: 44px; } }
      .t:hover { background: var(--sunken); }
      .t[aria-current="true"], .t[aria-selected="true"] { background: var(--sunken); box-shadow: inset 0 0 0 1px var(--line-strong); }
      .t:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -2px; }
      .t .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .t .p { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
      .t .p bdi { direction: ltr; }
      .chev { flex: none; width: 14px; height: 14px; color: var(--ink-2); fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
      [aria-expanded="true"] > .chev { transform: rotate(90deg); }
      .pad { flex: none; width: 14px; }
      ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
      h3 { font: 600 12.5px var(--mono); margin: 8px 0 2px; padding: 0 4px; overflow-wrap: anywhere; color: var(--ink); }
      .hit { all: unset; box-sizing: border-box; width: 100%; min-height: 34px; display: grid; grid-template-columns: 3.4em minmax(0, 1fr); gap: 6px; align-items: baseline; cursor: pointer; border-radius: 8px; padding: 4px 8px; font: 12.5px/1.5 var(--mono); }
      @media (pointer: coarse) { .hit { min-height: 44px; } }
      .hit:hover { background: var(--sunken); }
      .hit[aria-current="true"] { background: var(--sunken); box-shadow: inset 0 0 0 1px var(--line-strong); }
      .hit:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -2px; }
      .hit .no { text-align: right; color: var(--ink-2); }
      .hit .x { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
      mark { background: var(--needs-surface); color: var(--needs-fg); border-radius: 3px; box-shadow: inset 0 0 0 1px var(--needs-edge); }
      .view { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 12px; background: var(--code-bg); overflow: hidden; }
      .vh { flex: none; display: flex; align-items: center; gap: 10px; padding: 6px 12px; min-height: 36px; box-sizing: border-box; border-bottom: 1px solid var(--line); font: 600 12.5px var(--mono); min-width: 0; }
      .vh .path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .code { flex: 1 1 0; min-height: 0; overflow: auto; overscroll-behavior: contain; font: 13px/1.55 var(--mono); font-variant-ligatures: none; }
      .code:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -3px; }
      .in { display: inline-block; min-width: 100%; vertical-align: top; }
      .ln { display: grid; grid-template-columns: 4.6em minmax(0, 1fr); min-width: max-content; width: 100%; }
      .ln > span { padding: 0 8px; white-space: pre; }
      .ln .no { text-align: right; color: var(--ink-2); user-select: none; -webkit-user-select: none; }
      .ln[aria-current="true"] { background: var(--sunken); box-shadow: inset 3px 0 0 var(--reviewing-mark); }
      .ln[aria-current="true"] .no { color: var(--ink); font-weight: 700; }
      @media (pointer: coarse) { .ln { line-height: 2; } }
      .note, .more { padding: 10px 12px; margin: 0; color: var(--ink-2); font-size: 14px; }
      .back { display: none; }
      /* Narrow: one column, the list or the file. */
      @container (max-width: 680px) {
        .body { grid-template-columns: minmax(0, 1fr); }
        .body.reading .side, .body:not(.reading) .main { display: none; }
        .back { display: inline-flex; align-items: center; align-self: flex-start; }
      }
    `,
  ];

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("conversationId") && changed.get("conversationId") !== undefined) this.reset();
    if (this.mode === "files" && !this.list && !this.listLoading && !this.listError) void this.load();
    if (changed.has("target") && this.target) void this.openAt(this.target);
  }

  private reset() {
    this.listToken++;
    this.fileToken++;
    this.searchToken++;
    this.list = undefined;
    this.listError = null;
    this.tree = buildTree([]);
    this.filter = "";
    this.open = new Set();
    this.shown = LIST_ROWS;
    this.selected = null;
    this.file = undefined;
    this.fileError = null;
    this.lines = [];
    this.reading = false;
    this.result = undefined;
    this.searched = undefined;
    this.searchError = null;
    this.query = "";
  }

  /** Reads the list again and the open file, as a turn's end does. Nothing here wakes a machine. */
  async refresh(): Promise<void> {
    if (this.list || this.listError) await this.load();
    if (this.selected) await this.read(this.selected, this.line);
  }

  private async load(): Promise<void> {
    const id = this.conversationId;
    if (!id) return;
    const token = ++this.listToken;
    this.listLoading = true;
    try {
      const list = await api.files(id);
      if (token !== this.listToken) return;
      this.list = list;
      this.listError = null;
      this.tree = buildTree(list.paths);
    } catch (e) {
      if (token === this.listToken) this.listError = e instanceof Error ? e.message : String(e);
    } finally {
      if (token === this.listToken) this.listLoading = false;
    }
  }

  private async retryList() {
    await this.load();
    await this.updateComplete;
    if (document.activeElement === document.body) {
      this.renderRoot.querySelector<HTMLElement>('.t[tabindex="0"], .tools input')?.focus();
    }
  }

  private async read(path: string, line: number): Promise<void> {
    const id = this.conversationId;
    if (!id) return;
    const token = ++this.fileToken;
    if (path !== this.selected) {
      this.file = undefined;
      this.lines = [];
    }
    this.selected = path;
    this.line = line;
    this.fileLoading = true;
    this.fileError = null;
    try {
      const file = await api.readFile(id, path);
      if (token !== this.fileToken) return;
      this.lines =
        file.state === "ok" && !openNote(file) ? codeLines(file.side.text ?? "", langOf(path)) : [];
      this.file = file;
      this.place(line);
    } catch (e) {
      if (token === this.fileToken) this.fileError = e instanceof Error ? e.message : String(e);
    } finally {
      if (token === this.fileToken) this.fileLoading = false;
    }
  }

  /** The lines to draw: from the top, or around the line asked for. */
  private place(line: number) {
    const half = VIEW_LINES / 2;
    const at = line > VIEW_LINES ? Math.min(line - half, Math.max(0, this.lines.length - VIEW_LINES)) : 0;
    this.from = Math.max(0, Math.floor(at));
    this.to = Math.min(this.lines.length, this.from + VIEW_LINES);
  }

  /** Opens a file, and goes to the line. Focus moves to the file: the way to read it is from there. */
  async openAt(t: FileTarget): Promise<void> {
    this.reading = true;
    const open = new Set(this.open);
    for (const d of foldersOf(t.path)) open.add(d);
    this.open = open;
    this.focused = t.path;
    await this.read(t.path, t.line ?? 0);
    if (this.selected !== t.path) return;
    await this.updateComplete;
    const sc = this.renderRoot.querySelector<HTMLElement>(".code");
    const row = this.renderRoot.querySelector<HTMLElement>(`.ln[data-line="${t.line ?? 0}"]`);
    if (sc && row) {
      // By hand: scrollIntoView would move every scroller around it, and nothing in the app scrolls the page.
      const a = row.getBoundingClientRect();
      const b = sc.getBoundingClientRect();
      sc.scrollTop += a.top - b.top - Math.max(0, (b.height - a.height) / 2);
    }
    (sc ?? this.renderRoot.querySelector<HTMLElement>(".vh"))?.focus({ preventScroll: true });
  }

  private async retryFile(path: string) {
    await this.read(path, this.line);
    await this.updateComplete;
    if (document.activeElement === document.body) this.focusFile();
  }

  private focusFile() {
    (
      this.renderRoot.querySelector<HTMLElement>(".code") ?? this.renderRoot.querySelector<HTMLElement>(".vh")
    )?.focus();
  }

  private backToList() {
    this.reading = false;
    const from = this.selected;
    void this.updateComplete.then(() => {
      const all = [...this.renderRoot.querySelectorAll<HTMLElement>("[data-path]")];
      (all.find((b) => b.dataset.path === from) ?? all[0])?.focus();
    });
  }

  private rows(): TreeRow[] {
    return treeRows(this.tree, this.open);
  }

  private setOpen(path: string, on: boolean) {
    const next = new Set(this.open);
    if (on) next.add(path);
    else next.delete(path);
    this.open = next;
  }

  private focusRow(path: string) {
    this.focused = path;
    void this.updateComplete.then(() =>
      [...this.renderRoot.querySelectorAll<HTMLElement>('[role="treeitem"]')]
        .find((r) => r.dataset.path === path)
        ?.focus(),
    );
  }

  private activate(r: TreeRow) {
    this.focused = r.path;
    if (r.kind === "dir") this.setOpen(r.path, !this.open.has(r.path));
    else void this.openAt({ path: r.path });
  }

  /** The tree's keys, as the WAI tree pattern has them. */
  private onTreeKey = (e: KeyboardEvent) => {
    const rows = this.rows().slice(0, this.shown);
    const i = rows.findIndex((r) => r.path === (e.target as HTMLElement).dataset.path);
    const r = rows[i];
    if (!r) return;
    const go = (to: TreeRow | undefined) => to && this.focusRow(to.path);
    if (e.key === "ArrowDown") go(rows[i + 1]);
    else if (e.key === "ArrowUp") go(rows[i - 1]);
    else if (e.key === "Home") go(rows[0]);
    else if (e.key === "End") go(rows.at(-1));
    else if (e.key === "ArrowRight" && r.kind === "dir") {
      if (this.open.has(r.path)) go(rows[i + 1]);
      else this.setOpen(r.path, true);
    } else if (e.key === "ArrowLeft") {
      if (r.kind === "dir" && this.open.has(r.path)) this.setOpen(r.path, false);
      else go(rows.find((x) => x.path === foldersOf(r.path).at(-1)));
    } else if (e.key === "Enter" || e.key === " ") this.activate(r);
    else return;
    e.preventDefault();
  };

  /** Escape in a box with words in it clears the words: the pane stays. */
  private clearOnEscape(e: KeyboardEvent, clear: () => void, had: string) {
    if (e.key !== "Escape" || !had) return;
    e.preventDefault();
    e.stopPropagation();
    clear();
  }

  private treeView() {
    const all = this.rows();
    const rows = all.slice(0, this.shown);
    const stop = rows.some((r) => r.path === this.focused) ? this.focused : (rows[0]?.path ?? "");
    return html`<div class="scroll" role="tree" aria-label="Files" @keydown=${this.onTreeKey}>
      ${rows.map(
        (
          r,
        ) => html`<button class="t" type="button" role="treeitem" tabindex=${r.path === stop ? "0" : "-1"} data-path=${r.path} aria-level=${r.level}
          aria-expanded=${r.kind === "dir" ? (this.open.has(r.path) ? "true" : "false") : nothing}
          aria-selected=${r.path === this.selected ? "true" : "false"}
          style="padding-left: ${8 + (r.level - 1) * 14}px" @click=${() => this.activate(r)}>
          ${r.kind === "dir" ? html`<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>` : html`<span class="pad"></span>`}
          <span class="nm" title=${visible(r.path)}>${visible(r.name)}</span></button>`,
      )}
      ${all.length > rows.length ? this.moreRows(all.length - rows.length) : nothing}
    </div>`;
  }

  private moreRows(left: number) {
    return html`<div class="more"><button class="link-btn" type="button" @click=${() => {
      this.shown += LIST_ROWS;
    }}>Show ${Math.min(left, LIST_ROWS)} more</button></div>`;
  }

  private matchList(paths: string[]) {
    const found = matchPaths(paths, this.filter);
    const rows = found.slice(0, this.shown);
    if (!found.length) return html`<p class="quiet" role="status">No file's path has that in it.</p>`;
    return html`<p class="sr-only" role="status">${found.length} ${found.length === 1 ? "file" : "files"}</p>
      <ul class="scroll" aria-label="Matching files">${rows.map(
        (p) =>
          html`<li><button class="t" type="button" data-path=${p} aria-current=${p === this.selected ? "true" : "false"} @click=${() => void this.openAt({ path: p })}><span class="p" title=${visible(p)}><bdi>${visible(p)}</bdi></span></button></li>`,
      )}${found.length > rows.length ? html`<li>${this.moreRows(found.length - rows.length)}</li>` : nothing}</ul>`;
  }

  private filesSide() {
    const v = this.list;
    return html`<div class="tools"><input type="search" aria-label="Filter files by path" placeholder="Filter files" autocomplete="off" autocapitalize="off" spellcheck="false" .value=${this.filter}
        @input=${(e: Event) => {
          this.filter = (e.target as HTMLInputElement).value;
          this.shown = LIST_ROWS;
        }}
        @keydown=${(e: KeyboardEvent) =>
          this.clearOnEscape(
            e,
            () => {
              this.filter = "";
            },
            this.filter,
          )} />
        <button class="cbtn" type="button" aria-disabled=${this.listLoading ? "true" : "false"} @click=${() => {
          if (!this.listLoading) void this.retryList();
        }}>${this.listLoading ? "Reading…" : "Refresh"}</button></div>
      ${this.filter.trim() ? this.matchList(v?.paths ?? []) : this.treeView()}
      ${v?.skipped ? html`<p class="say">${v.skipped === 1 ? "1 file has" : `${v.skipped} files have`} a name that isn't safe to show.</p>` : nothing}
      ${v?.truncated ? html`<p class="say">Only the first ${v.paths.length} files are listed.</p>` : nothing}`;
  }

  private filesTab() {
    const v = this.list;
    const again = html`<button class="cbtn" type="button" aria-disabled=${this.listLoading ? "true" : "false"} @click=${() => {
      if (!this.listLoading) void this.retryList();
    }}>Try again</button>`;
    if (this.listError && !v) {
      return html`<div class="state" role="alert"><p>Couldn't read the files (${this.listError}).</p>${again}</div>`;
    }
    if (!v) return html`<div class="state" role="status"><p>Reading the files…</p></div>`;
    if (v.state === "asleep" || v.state === "busy" || v.state === "failed") {
      return html`<div class="state" role="status"><p>${v.reason}</p>${again}</div>`;
    }
    if (!v.paths.length && !v.skipped) {
      return html`<div class="state"><p>${v.reason ?? "There are no files here yet."}</p></div>`;
    }
    return this.split(this.filesSide());
  }

  private async search(e: Event) {
    e.preventDefault();
    const id = this.conversationId;
    const query = this.query;
    const matchCase = this.matchCase;
    if (!id || !query.trim() || this.searching) return;
    const token = ++this.searchToken;
    this.searching = true;
    this.searchError = null;
    try {
      const result = await api.searchFiles(id, query, matchCase);
      if (token !== this.searchToken) return;
      this.result = result;
      this.searched = { query, matchCase };
    } catch (err) {
      if (token === this.searchToken) this.searchError = err instanceof Error ? err.message : String(err);
    } finally {
      if (token === this.searchToken) this.searching = false;
    }
  }

  private results() {
    const r = this.result;
    const asked = this.searched;
    if (this.searchError) {
      return html`<p class="say" role="alert">Couldn't search (${this.searchError}).</p>`;
    }
    if (!r || !asked) return html`<p class="quiet">Finds the exact words in every file, changed or not.</p>`;
    if (r.state !== "ok") return html`<p class="say" role="status">${r.reason}</p>`;
    const groups = groupHits(r.hits);
    const left = html`${r.skipped ? html`<p class="say">${r.skipped === 1 ? "1 match is" : `${r.skipped} matches are`} in a file whose name isn't safe to show.</p>` : nothing}
      ${r.withheld ? html`<p class="say">${r.withheld === 1 ? "1 match isn't" : `${r.withheld} matches aren't`} shown: secrets, or too far along a line.</p>` : nothing}
      ${r.truncated ? html`<p class="say">There are more matches than this. Try fewer files or longer words.</p>` : nothing}`;
    if (!r.hits.length) {
      return html`<p class="quiet" role="status">No matches.</p>${left}`;
    }
    const files = groups.length === 1 ? "1 file" : `${groups.length} files`;
    return html`<p class="quiet" role="status">${r.hits.length === 1 ? "1 match" : `${r.hits.length} matches`} in ${files}.</p>
      <div class="scroll">${left}${groups.map(
        (g) =>
          html`<section><h3 title=${visible(g.path)}>${visible(g.path)}</h3><ul>${g.hits.map(
            (
              h,
            ) => html`<li><button class="hit" type="button" data-path=${g.path} aria-label="${visible(g.path)} line ${h.line}: ${visible(h.text)}"
            aria-current=${g.path === this.selected && h.line === this.line ? "true" : "false"} @click=${() => void this.openAt({ path: g.path, line: h.line })}>
            <span class="no">${h.line}</span><span class="x">${matchParts(h.text.trimStart(), asked.query, asked.matchCase).map((p) => (p.hit ? html`<mark>${visible(p.s)}</mark>` : visible(p.s)))}</span></button></li>`,
          )}</ul></section>`,
      )}</div>`;
  }

  private searchSide() {
    return html`<form class="tools" role="search" @submit=${(e: Event) => void this.search(e)}>
        <input type="text" aria-label="Search the files for" placeholder="Search the files" maxlength="200" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" .value=${this.query}
          @input=${(e: Event) => {
            this.query = (e.target as HTMLInputElement).value;
          }}
          @keydown=${(e: KeyboardEvent) =>
            this.clearOnEscape(
              e,
              () => {
                this.query = "";
              },
              this.query,
            )} />
        <button class="cbtn primary" type="submit" aria-disabled=${this.searching || !this.query.trim() ? "true" : "false"}>${this.searching ? "Searching…" : "Search"}</button>
      </form>
      <label class="case"><input type="checkbox" .checked=${this.matchCase} @change=${(e: Event) => {
        this.matchCase = (e.target as HTMLInputElement).checked;
      }} />Match case</label>
      ${this.results()}`;
  }

  private row(tokens: Token[], n: number) {
    return html`<div class="ln" data-line=${n} aria-current=${n === this.line ? "true" : "false"}><span class="no">${n}</span><span>${tokens.map((t) => (t.t ? html`<span class="tk-${t.t}">${visible(t.s)}</span>` : visible(t.s)))}</span></div>`;
  }

  private more(side: "up" | "down") {
    if (side === "up") this.from = Math.max(0, this.from - VIEW_LINES);
    else this.to = Math.min(this.lines.length, this.to + VIEW_LINES);
    void this.updateComplete.then(() => this.focusFile());
  }

  private viewer() {
    const path = this.selected;
    const f = this.file;
    if (!path) return html`<div class="view"><p class="note">Pick a file to read it.</p></div>`;
    const note = f ? openNote(f) : null;
    const title = visible(path);
    let inner: unknown;
    if (this.fileError) {
      inner = html`<p class="note">Couldn't load this file (${this.fileError}). <button class="link-btn" type="button" @click=${() => void this.retryFile(path)}>Try again</button></p>`;
    } else if (f && f.state !== "ok") {
      inner = html`<p class="note" role="status">${f.reason} <button class="link-btn" type="button" @click=${() => void this.retryFile(path)}>Try again</button></p>`;
    } else if (!f) inner = html`<p class="note" role="status">Loading the file…</p>`;
    else if (note) inner = html`<p class="note">${visible(note)}</p>`;
    else {
      inner = html`<div class="code" tabindex="0" role="group" aria-label="Contents of ${title}"><div class="in">
        ${this.from > 0 ? html`<div class="more"><button class="link-btn" type="button" @click=${() => this.more("up")}>Show earlier lines</button></div>` : nothing}
        ${this.lines.slice(this.from, this.to).map((l, i) => this.row(l, this.from + i + 1))}
        ${this.to < this.lines.length ? html`<div class="more"><button class="link-btn" type="button" @click=${() => this.more("down")}>Show ${Math.min(VIEW_LINES, this.lines.length - this.to)} more lines</button></div>` : nothing}
      </div></div>`;
    }
    return html`<div class="view" role="group" aria-label="File ${title}"><div class="vh" tabindex="-1"><span class="path" title=${title}>${title}</span></div>${inner}</div>`;
  }

  private split(side: unknown) {
    return html`<div class="body ${this.reading ? "reading" : ""}">
      <div class="side">${side}</div>
      <div class="main"><button class="cbtn back" type="button" @click=${() => this.backToList()}>${this.mode === "search" ? "All matches" : "All files"}</button>${this.viewer()}</div>
    </div>`;
  }

  override render() {
    return this.mode === "search" ? this.split(this.searchSide()) : this.filesTab();
  }
}

customElements.define("inc-conv-files", IncConvFiles);
