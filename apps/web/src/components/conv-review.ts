// The review pane: what a conversation's working copy changes, read from git, so changes made by shell commands
// show too. A file list and a large diff, in the width of the thread and the context panel; one column when
// that is narrow. Pick a line's number to comment on it (the code itself is there to be selected): comments stay
// in this browser until they go with a message.
// Everything shown came from a sandbox, so it is rendered as text, through `visible`.
import { type DiffRow, diffStats, diffWithContext } from "@i-inc/core";
import { css, html, LitElement, nothing } from "lit";
import { ahp } from "../ahp/hub.ts";
import { api, type ChangesView, type Conversation, type FileView, type ReviewFile } from "../api.ts";
import { firstPending, turnEnding, visible } from "../conversations/model.ts";
import {
  anchor,
  COMMENT_MAX,
  commentDrafts,
  fileNote,
  type LineComment,
  type LineDraft,
  type LineSpot,
  placeOf,
  quoteOf,
  reviewComments,
} from "../conversations/review.ts";
import { cardStyles } from "../conversations/styles.ts";
import type { FileTarget, IncConvFiles } from "./conv-files.ts";
import "./conv-files.ts";
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

export type ReviewTab = "changes" | "files" | "search";
const TABS: { id: ReviewTab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "files", label: "Files" },
  { id: "search", label: "Search" },
];

const spot = (at: { side: string; line: number }) => `${at.side}-${at.line}`;
/** A comment box: two files can have one on the same line number, and both can be showing. */
const boxKey = (at: LineSpot) => `${at.path}|${spot(at)}`;
const unsafeNames = (n: number) =>
  `${n === 1 ? "1 file has" : `${n} files have`} a name that isn't safe to show.`;
const PARTIAL = "Some files couldn't be read, so this may not be everything.";
/** A line as a sentence: a removed one and an added one can have the same number. */
const lineName = (at: { side: string; line: number }) =>
  `${at.side === "old" ? "removed line" : "line"} ${at.line}`;

export class IncConvReview extends LitElement {
  static override properties = {
    conv: { attribute: false },
    name: { type: String },
    phone: { type: Boolean },
    path: { type: String },
    tab: { type: String },
    target: { attribute: false },
    shownTab: { state: true },
    filesUsed: { state: true },
    changes: { state: true },
    listNote: { state: true },
    loadError: { state: true },
    loading: { state: true },
    selected: { state: true },
    reading: { state: true },
    file: { state: true },
    fileError: { state: true },
    fileStale: { state: true },
    fileLoading: { state: true },
    rows: { state: true },
    showAll: { state: true },
    comments: { state: true },
    discarding: { state: true },
    running: { state: true },
    waiting: { state: true },
    spoken: { state: true },
  };
  declare conv: Conversation | undefined;
  /** The employee's name, for sentences. */
  declare name: string;
  declare phone: boolean;
  /** The file to open with, when the pane was opened from one. */
  declare path: string;
  /** The tab to open at. */
  declare tab: ReviewTab;
  /** The file to open in Files, when the pane was opened from one. */
  declare target: FileTarget | null;
  declare shownTab: ReviewTab;
  /** Files or Search has been open: until then nothing reads the copy for them. */
  declare filesUsed: boolean;
  declare changes: ChangesView | undefined;
  /** Why the list showing couldn't be read again. */
  declare listNote: string | null;
  declare loadError: string | null;
  declare loading: boolean;
  declare selected: string | null;
  /** One column: the diff is showing rather than the list. */
  declare reading: boolean;
  declare file: FileView | undefined;
  declare fileError: string | null;
  /** Why the file showing couldn't be read again. */
  declare fileStale: string | null;
  declare fileLoading: boolean;
  declare rows: DiffRow[];
  declare showAll: boolean;
  declare comments: LineComment[];
  /** The comment box asking whether to throw its text away. */
  declare discarding: string | null;
  declare running: boolean;
  /** The agent is stopped on a permission or a question. */
  declare waiting: boolean;
  /** What changed in the turn, for a screen reader: the thread's own live region is hidden behind the pane. */
  declare spoken: string;

  private listToken = 0;
  private fileToken = 0;
  private offs: (() => void)[] = [];
  /** The box a read found the owner in, until the read's update is drawn. */
  private typing: ReturnType<IncConvReview["boxInFocus"]>;

  constructor() {
    super();
    this.name = "";
    this.phone = false;
    this.path = "";
    this.tab = "changes";
    this.target = null;
    this.shownTab = "changes";
    this.filesUsed = false;
    this.listNote = null;
    this.loadError = null;
    this.loading = false;
    this.selected = null;
    this.reading = false;
    this.fileError = null;
    this.fileStale = null;
    this.fileLoading = false;
    this.rows = [];
    this.showAll = false;
    this.comments = [];
    this.discarding = null;
    this.running = false;
    this.waiting = false;
    this.spoken = "";
  }

  static override styles = [
    base,
    cardStyles,
    css`
      :host { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--ground); container-type: inline-size; }
      .head { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 4px 10px; border-bottom: 1px solid var(--line); min-width: 0; }
      .tabs { flex: 0 1 auto; min-width: 0; display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; }
      .tab { flex: none; }
      .refresh { flex: none; }
      .tab { min-height: 44px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; color: var(--ink-2); font: 700 15px var(--body); cursor: pointer; }
      .tab:hover { background: var(--sunken); color: var(--ink); }
      .tab[aria-selected="true"] { color: var(--ink); box-shadow: inset 0 -3px 0 var(--ink); border-radius: 10px 10px 0 0; }
      .tab:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -3px; }
      .panel { flex: 1 1 0; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
      .panel[hidden] { display: none; }
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
      .c p { margin: 0 8px 0 0; white-space: break-spaces; overflow-wrap: anywhere; }
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
      .row { display: grid; grid-template-columns: 7.6em 1.4em minmax(0, 1fr); min-width: max-content; width: 100%; }
      .row > span { padding: 0 6px; white-space: pre; }
      .row > .sign { padding: 0; }
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
      .box .acts { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .box .acts p { margin: 0; flex: 1 1 100%; }
      .moved { flex: none; max-height: 45%; overflow-y: auto; border-bottom: 1px solid var(--line); padding-bottom: 6px; font: 14px/1.4 var(--body); }
      .moved > p { margin: 0; padding: 8px 10px 2px; color: var(--ink-2); }
      .moved > .c { margin: 6px 10px 0; }
      .moved .c:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: -3px; }
      .aside { margin-top: 24px; }
      .stray { min-height: 44px; font: 600 12.5px var(--mono); text-align: left; overflow-wrap: anywhere; }
      .c .under { position: static; width: auto; padding: 4px 8px 0 0; }
      .back { display: none; }
      @media (pointer: coarse) { .row { line-height: 2; } }
      /* Narrow: one column, the list or the diff. */
      @container (max-width: 680px) {
        .sum { display: none; }
        .head { gap: 6px; }
        .tab { padding: 0 8px; }
        .refresh { padding: 0 12px; }
        .head .grow { flex: 1 1 auto; }
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
    this.syncChat();
    this.offs = [
      c.onChange((uris) => {
        const conv = this.conv;
        if (!conv || !uris.has(conv.ahpChat)) return;
        const was = this.running;
        this.syncChat(true);
        if (was && !this.running) {
          if (this.changes || this.loading) void this.refresh();
          void this.filesPane()?.refresh();
        }
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
    if (changed.has("tab")) this.shownTab = this.tab;
    if (this.shownTab !== "changes") {
      this.filesUsed = true;
      this.filesMode = this.shownTab;
    }
    if (changed.has("conv") && (changed.get("conv") as Conversation | undefined)?.id !== this.conv?.id) {
      this.comments = this.conv ? reviewComments.list(this.conv.id) : [];
      this.discarding = null;
      // What was kept through a failed read is another conversation's now.
      this.changes = undefined;
      this.listNote = null;
      this.selected = null;
      this.file = undefined;
      this.fileError = null;
      this.fileStale = null;
      this.rows = [];
      this.showAll = false;
      this.reading = false;
      this.syncChat();
      if (this.shownTab === "changes") void this.refresh();
    }
    const read = changed.has("rows") || changed.has("file") || changed.has("changes");
    this.typing = read ? this.boxInFocus() : undefined;
  }

  /** What a read brings can move the box being typed in, or take it away: focus, and the caret, go with it. */
  override updated(): void {
    const was = this.typing;
    this.typing = undefined;
    if (!was || this.boxInFocus()?.key === was.key) return;
    const ta = this.boxOf(was.key)?.querySelector("textarea");
    if (ta) {
      ta.focus({ preventScroll: true });
      if (was.caret) ta.setSelectionRange(was.caret[0], was.caret[1]);
      this.bringIntoView(ta);
      return;
    }
    // Its file has gone from the diff. A key pressed next lands here, so not on a button that would close the pane.
    (
      this.renderRoot.querySelector<HTMLElement>(".stray") ??
      this.renderRoot.querySelector<HTMLElement>(".refresh")
    )?.focus({ preventScroll: true });
  }

  private boxInFocus() {
    const on = (this.renderRoot as ShadowRoot).activeElement;
    const key = on?.closest<HTMLElement>("[data-box]")?.dataset.box;
    if (key === undefined) return undefined;
    const typed = on instanceof HTMLTextAreaElement ? on : null;
    return { key, caret: typed ? ([typed.selectionStart, typed.selectionEnd] as const) : null };
  }

  /** `tell`: this is a change, not what was already going on when the pane opened, which is not news. */
  private syncChat(tell = false) {
    const chat = this.conv ? ahp().chat(this.conv.ahpChat) : undefined;
    const was = { running: this.running, waiting: this.waiting };
    this.running = !!chat?.activeTurn;
    this.waiting = !!firstPending(chat);
    const who = this.name || "The agent";
    if (!tell) this.spoken = "";
    else if (this.waiting && !was.waiting) this.spoken = `${who} needs your answer`;
    else if (this.running && (!was.running || (was.waiting && !this.waiting))) {
      this.spoken = `${who} is working`;
    } else if (was.running && !this.running) this.spoken = turnEnding(who, chat);
  }

  /** The tab the Files and Search panel last showed: it stays that way behind Changes, and reads nothing new. */
  private filesMode: "files" | "search" = "files";

  private filesPane(): IncConvFiles | null {
    return this.renderRoot.querySelector<IncConvFiles>("inc-conv-files");
  }

  private pickTab(tab: ReviewTab) {
    this.shownTab = tab;
    if (tab === "changes" && !this.changes && !this.loading) void this.refresh();
  }

  /** The tabs' keys: arrows move and choose, as the WAI tabs pattern has them. */
  private onTabKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === this.shownTab);
    const to =
      e.key === "ArrowRight"
        ? (i + 1) % TABS.length
        : e.key === "ArrowLeft"
          ? (i + TABS.length - 1) % TABS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? TABS.length - 1
              : -1;
    const tab = TABS[to];
    if (!tab) return;
    e.preventDefault();
    this.pickTab(tab.id);
    void this.updateComplete.then(() =>
      this.renderRoot.querySelector<HTMLElement>(`#tab-${tab.id}`)?.focus(),
    );
  };

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
      this.loadError = null;
      // A read that didn't work says so above the list it has, and doesn't take that list away.
      const failed = changes.state === "asleep" || changes.state === "busy" || changes.state === "failed";
      if (failed && this.changes?.state === "ok") {
        this.listNote = changes.reason ?? "Couldn't read the changes.";
        return;
      }
      this.listNote = null;
      this.changes = changes;
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
      if (token !== this.listToken) return;
      this.listNote = null;
      this.loadError = e instanceof Error ? e.message : String(e);
    } finally {
      if (token === this.listToken) this.loading = false;
    }
  }

  /** A press of Refresh or Try again. The button may be gone when it ends: focus isn't left on nothing. */
  private retry = async () => {
    if (this.loading) return;
    await this.refresh();
    await this.updateComplete;
    if (document.activeElement === document.body) {
      this.renderRoot.querySelector<HTMLElement>(".refresh")?.focus();
    }
  };

  private async open(path: string): Promise<void> {
    const conv = this.conv;
    if (!conv) return;
    const token = ++this.fileToken;
    if (path !== this.selected) {
      this.file = undefined;
      this.rows = [];
      this.showAll = false;
      this.discarding = null;
      this.fileStale = null;
    }
    // A read again of what is showing that doesn't work says so over it, and doesn't take it away.
    const showing = this.file?.state === "ok";
    this.selected = path;
    this.fileLoading = true;
    this.fileError = null;
    try {
      const file = await api.changedFile(conv.id, path);
      if (token !== this.fileToken) return;
      if (showing && file.state !== "ok") {
        this.fileStale = file.reason ?? "This file couldn't be read again.";
        return;
      }
      this.fileStale = null;
      this.file = file;
      this.rows =
        file.state === "ok" && !fileNote(file)
          ? diffWithContext(file.before.text ?? "", file.after.text ?? "", 3)
          : [];
      // Nothing else says a comment being written is past the cut, so it isn't left there.
      const written = commentDrafts.list(conv.id).filter((d) => d.path === path && d.text.trim());
      if ([...anchor(this.rows, written).at.keys()].some((i) => i >= SHOW_ROWS)) this.showAll = true;
    } catch (e) {
      if (token !== this.fileToken) return;
      const words = e instanceof Error ? e.message : String(e);
      if (showing) this.fileStale = `Couldn't read this file again (${words}).`;
      else this.fileError = words;
    } finally {
      if (token === this.fileToken) this.fileLoading = false;
    }
  }

  /** A file's Try again. It goes when the file comes, so focus moves on to what took its place. */
  private async retryFile(path: string) {
    await this.open(path);
    await this.updateComplete;
    if (document.activeElement === document.body) {
      (
        this.renderRoot.querySelector<HTMLElement>(".rows") ??
        this.renderRoot.querySelector<HTMLElement>(".refresh")
      )?.focus();
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

  /** To a comment's line: the whole diff if it is past the cut, or the comment itself if its line has moved. */
  private async goTo(c: LineComment) {
    this.reading = true;
    if (c.path !== this.selected || !this.file) await this.open(c.path);
    if (this.selected !== c.path) return;
    const i = anchor(this.rows, [c]).at.keys().next().value;
    if (i !== undefined && i >= SHOW_ROWS) this.showAll = true;
    await this.updateComplete;
    const to =
      i !== undefined
        ? this.renderRoot.querySelector<HTMLElement>(`[data-at="${spot(c)}"] .no`)
        : this.renderRoot.querySelector<HTMLElement>(`[data-moved="${c.id}"]`);
    if (to) this.bringIntoView(to);
    to?.focus({ preventScroll: true });
  }

  /** By hand: scrollIntoView would move every scroller around it, and nothing in the app scrolls the page. */
  private bringIntoView(el: HTMLElement) {
    const sc = this.renderRoot.querySelector<HTMLElement>(".rows");
    if (!sc?.contains(el)) return;
    const a = el.getBoundingClientRect();
    const b = sc.getBoundingClientRect();
    sc.scrollTop += a.top - b.top - Math.max(0, (b.height - a.height) / 2);
  }

  /** A press of a line's number opens its comment box, or goes to the one already open there. */
  private onRows = (e: Event) => {
    const conv = this.conv;
    const path = this.selected;
    const no = (e.target as HTMLElement).closest?.<HTMLElement>(".no");
    const r = this.rows[Number(no?.closest<HTMLElement>("[data-i]")?.dataset.i)];
    if (!conv || !path || !r || r.kind === "gap") return;
    const at = { path, ...placeOf(r), quote: quoteOf(r.text) };
    commentDrafts.start(conv.id, at);
    this.requestUpdate();
    void this.updateComplete.then(() => this.boxOf(boxKey(at))?.querySelector("textarea")?.focus());
  };

  private boxOf(key: string) {
    return [...this.renderRoot.querySelectorAll<HTMLElement>("[data-box]")].find(
      (b) => b.dataset.box === key,
    );
  }

  private focusLine(at: LineSpot) {
    void this.updateComplete.then(() =>
      (
        this.renderRoot.querySelector<HTMLElement>(`[data-at="${spot(at)}"] .no`) ??
        this.renderRoot.querySelector<HTMLElement>(".x")
      )?.focus(),
    );
  }

  private closeBox(d: LineDraft) {
    if (!this.conv) return;
    commentDrafts.drop(this.conv.id, d);
    this.discarding = null;
    this.requestUpdate();
    this.focusLine(d);
  }

  /** Escape or Cancel. A box with nothing in it just closes; words are only thrown away when the owner says so. */
  private cancelBox(d: LineDraft) {
    const typed =
      commentDrafts.list(this.conv?.id ?? "").find((x) => x.path === d.path && spot(x) === spot(d))?.text ??
      "";
    if (this.discarding === boxKey(d)) this.keepWriting(d);
    else if (typed.trim()) {
      this.discarding = boxKey(d);
      void this.updateComplete.then(() =>
        this.boxOf(boxKey(d))?.querySelector<HTMLElement>(".keep")?.focus(),
      );
    } else this.closeBox(d);
  }

  private keepWriting(d: LineDraft) {
    this.discarding = null;
    void this.updateComplete.then(() => this.boxOf(boxKey(d))?.querySelector("textarea")?.focus());
  }

  private addComment(d: LineDraft, text: string) {
    const conv = this.conv;
    if (!conv || !text.trim()) return;
    reviewComments.add(conv.id, {
      path: d.path,
      side: d.side,
      line: d.line,
      quote: d.quote,
      text,
    });
    this.closeBox(d);
  }

  private box(d: LineDraft, name = lineName(d)) {
    const asking = this.discarding === boxKey(d);
    return html`<div class="under"><div class="box" data-box=${boxKey(d)} @keydown=${(e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        this.cancelBox(d);
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.addComment(d, (e.currentTarget as HTMLElement).querySelector("textarea")?.value ?? "");
      }
    }}>
      <textarea aria-label="Comment on ${name}" maxlength=${COMMENT_MAX} placeholder="Your comment" .value=${d.text}
        @input=${(e: Event) => this.conv && commentDrafts.write(this.conv.id, d, (e.target as HTMLTextAreaElement).value)}></textarea>
      ${
        asking
          ? html`<div class="acts"><p>Discard this comment?</p>
              <button class="cbtn keep" type="button" @click=${() => this.keepWriting(d)}>Keep writing</button>
              <button class="cbtn" type="button" @click=${() => this.closeBox(d)}>Discard</button></div>`
          : html`<div class="acts"><button class="cbtn primary" type="button" @click=${(e: Event) =>
              this.addComment(
                d,
                (e.target as HTMLElement).closest(".box")?.querySelector("textarea")?.value ?? "",
              )}>Add comment</button>
              <button class="cbtn" type="button" @click=${() => this.cancelBox(d)}>Cancel</button></div>`
      }
    </div></div>`;
  }

  /** Focus stays in the list: on the next comment's Remove, or wherever is nearest when that was the last. */
  private async removeComment(c: LineComment, e: Event) {
    if (!this.conv) return;
    const from = [...this.renderRoot.querySelectorAll(".rm")].indexOf(e.currentTarget as Element);
    reviewComments.remove(this.conv.id, [c.id]);
    await this.updateComplete;
    const left = [...this.renderRoot.querySelectorAll<HTMLElement>(".rm")];
    (
      left[Math.min(from, left.length - 1)] ??
      this.renderRoot.querySelector<HTMLElement>('.f[aria-current="true"]') ??
      this.renderRoot.querySelector<HTMLElement>(".x")
    )?.focus();
  }

  /**
   * `inline`: under its line, which says where it is. `link`: in the list, going to its line. `plain`: in the list
   * with no diff to go to. `moved`: above the diff, quoting the line that has changed.
   */
  private comment(c: LineComment, how: "inline" | "link" | "plain" | "moved") {
    const list = how === "link" || how === "plain";
    const where = `${visible(c.path)}:${c.line}${c.side === "old" ? " (removed)" : ""}`;
    return html`<div class="c" data-moved=${how === "moved" ? c.id : nothing} tabindex=${how === "moved" ? "-1" : nothing}><div class="top">
        ${
          how === "link"
            ? html`<button class="link-btn where" type="button" @click=${() => void this.goTo(c)}>${where}</button>`
            : html`<span class="where">${how === "plain" ? where : `${c.side === "old" ? "Removed line" : "Line"} ${c.line}`}</span>`
        }
        <button class="rm" type="button" aria-label="Remove comment on ${visible(c.path)} ${lineName(c)}"
          @click=${(e: Event) => void this.removeComment(c, e)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg></button></div>
      ${list || how === "moved" ? html`<blockquote>${visible(c.quote)}</blockquote>` : nothing}
      <p>${c.text}</p></div>`;
  }

  private line(r: LineRow, i: number, comments: LineComment[], drafts: LineDraft[]) {
    const at = placeOf(r);
    return html`<div class="row ${r.kind}" data-i=${i} data-at=${spot(at)}>
        <button class="no" type="button" aria-label="Comment on ${lineName(at)}"><span>${r.oldNo ?? ""}</span><span>${r.newNo ?? ""}</span></button>
        <span class="sign" role=${r.kind === "add" || r.kind === "del" ? "img" : nothing} aria-label=${r.kind === "add" ? "added" : r.kind === "del" ? "removed" : nothing}>${r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
        <span class="text">${visible(r.text)}</span></div>
      ${comments.length ? html`<div class="under">${comments.map((c) => this.comment(c, "inline"))}</div>` : nothing}
      ${drafts.map((d) => this.box(d))}`;
  }

  /** Shows the rest of the diff, and puts focus on the first line the button was hiding. */
  private showRest() {
    this.showAll = true;
    void this.updateComplete.then(() =>
      [...this.renderRoot.querySelectorAll<HTMLElement>(".row")]
        .find((r) => Number(r.dataset.i) >= SHOW_ROWS)
        ?.querySelector<HTMLElement>(".no")
        ?.focus(),
    );
  }

  private diff() {
    const f = this.file;
    const path = this.selected;
    if (!path) return html`<p class="note">Pick a file to see its changes.</p>`;
    const stats = diffStats(this.rows);
    const note = f ? fileNote(f) : null;
    const shown = this.showAll ? this.rows : this.rows.slice(0, SHOW_ROWS);
    const comments = anchor(
      this.rows,
      this.comments.filter((c) => c.path === path),
    );
    const drafts = anchor(
      this.rows,
      commentDrafts.list(this.conv?.id ?? "").filter((d) => d.path === path),
    );
    const moved = comments.moved.length + drafts.moved.length;
    const changed = moved
      ? html`<div class="moved"><p>${moved === 1 ? "This line has" : "These lines have"} changed since the comment was written.</p>
          ${comments.moved.map((c) => this.comment(c, "moved"))}${drafts.moved.map((d) => this.box(d))}</div>`
      : nothing;
    return html`<div class="diff" role="group" aria-label="Changes to ${visible(path)}">
      <div class="dh"><span class="path" title=${visible(path)}>${visible(path)}</span>
        ${this.rows.length ? html`<span class="plus" aria-label="${stats.added} lines added">+${stats.added}</span><span class="minus" aria-label="${stats.removed} lines removed">−${stats.removed}</span>` : nothing}</div>
      ${this.fileStale ? html`<p class="note" role="alert">${this.fileStale} <button class="link-btn" type="button" @click=${() => void this.retryFile(path)}>Try again</button></p>` : nothing}
      ${
        this.fileError
          ? html`<p class="note">Couldn't load this file (${this.fileError}). <button class="link-btn" type="button" @click=${() => void this.retryFile(path)}>Try again</button></p>`
          : f && f.state !== "ok"
            ? html`<p class="note" role="status">${f.reason} <button class="link-btn" type="button" @click=${() => void this.retryFile(path)}>Try again</button></p>`
            : !f
              ? html`<p class="note" role="status">Loading the file…</p>`
              : note
                ? html`${changed}<p class="note">${note}</p>`
                : !this.rows.length && !moved
                  ? html`<p class="note">No line changes.</p>`
                  : html`
                    ${changed}
                    ${
                      this.rows.length
                        ? html`<div class="rows" tabindex="0" aria-label="Diff. Pick a line number to comment on it." @click=${this.onRows}><div class="in">
                      ${shown.map((r, i) =>
                        r.kind === "gap"
                          ? html`<div class="gap">${r.count} unchanged ${r.count === 1 ? "line" : "lines"}</div>`
                          : this.line(r, i, comments.at.get(i) ?? [], drafts.at.get(i) ?? []),
                      )}
                      ${
                        this.rows.length > SHOW_ROWS && !this.showAll
                          ? html`<div class="more"><button class="link-btn" type="button" @click=${() => this.showRest()}>Show all ${this.rows.length} lines</button></div>`
                          : nothing
                      }
                    </div></div>`
                        : nothing
                    }`
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

  /** Half-written comments on files the list doesn't hold: their words stay, so the way to them stays too. */
  private strays(files: ReviewFile[]) {
    return commentDrafts
      .list(this.conv?.id ?? "")
      .filter((d) => d.text.trim() && !files.some((f) => f.path === d.path));
  }

  /** `link`: going to the box above that file's diff. `box`: the box itself, when no diff can be drawn to hold it. */
  private unfinished(left: LineDraft[], how: "link" | "box") {
    if (!left.length) return nothing;
    return html`<section aria-labelledby="h-unfinished"><h3 id="h-unfinished">Unfinished comments · ${left.length}</h3>
      ${
        how === "box"
          ? left.map(
              (
                d,
              ) => html`<div class="c"><div class="top"><span class="where">${visible(d.path)}:${d.line}${d.side === "old" ? " (removed)" : ""}</span></div>
                <blockquote>${visible(d.quote)}</blockquote>${this.box(d, `${visible(d.path)} ${lineName(d)}`)}</div>`,
            )
          : html`<ul>${left.map(
              (d) =>
                html`<li><button class="link-btn stray" type="button" @click=${() => this.pick(d.path)}>${visible(d.path)}:${d.line}</button></li>`,
            )}</ul>`
      }</section>`;
  }

  private commentList(how: "link" | "plain") {
    const list = this.comments;
    if (!list.length) return nothing;
    const unsaved = this.conv ? reviewComments.unsaved(this.conv.id) : 0;
    return html`<section aria-labelledby="h-comments"><h3 id="h-comments">Comments · ${list.length}</h3>
      ${list.map((c) => this.comment(c, how))}
      ${unsaved ? html`<p class="say">${unsaved === 1 ? "1 comment is" : `${unsaved} comments are`} too much to keep through a reload. Send them before you leave this page.</p>` : nothing}
      <div class="send"><button class="cbtn primary" type="button" @click=${() =>
        this.dispatchEvent(
          new CustomEvent("conv-send-comments", { bubbles: true, composed: true }),
        )}>${this.running ? "Queue comments" : "Send comments"}</button></div></section>`;
  }

  /** What is the owner's with no diff to go to: it, and the way to finish or send it, stays whatever the read did. */
  private asideComments() {
    const left = this.strays([]);
    if (!this.comments.length && !left.length) return nothing;
    return html`<div class="side aside">${this.unfinished(left, "box")}${this.commentList("plain")}</div>`;
  }

  private content() {
    const c = this.changes;
    const again = html`<button class="cbtn" type="button" aria-disabled=${this.loading ? "true" : "false"} @click=${this.retry}>Try again</button>`;
    if (this.loadError && c?.state !== "ok") {
      return html`<div class="state" role="alert"><p>Couldn't read the changes (${this.loadError}).</p>${again}</div>${this.asideComments()}`;
    }
    if (!c) return html`<div class="state" role="status"><p>Reading the changes…</p></div>`;
    if (c.state === "asleep" || c.state === "busy" || c.state === "failed") {
      return html`<div class="state" role="status"><p>${c.reason}</p>${again}</div>${this.asideComments()}`;
    }
    if (!c.files.length) {
      // An empty list isn't "nothing changed" when something was left out of it.
      const left = [c.skipped ? unsafeNames(c.skipped) : "", c.partial ? PARTIAL : ""].filter(Boolean);
      const empty =
        left.join(" ") ||
        (c.reason ??
          (c.noProject ? "Nothing in this conversation's folder yet." : "Nothing has changed yet."));
      return html`<div class="state"><p>${empty}</p>${c.partial ? again : nothing}</div>${this.asideComments()}`;
    }
    return html`<div class="body ${this.reading ? "reading" : ""}">
      <div class="side">
        ${this.list(c.files)}
        ${c.skipped ? html`<p class="say">${unsafeNames(c.skipped)}</p>` : nothing}
        ${c.truncated ? html`<p class="say">Only the first ${c.files.length} files are listed.</p>` : nothing}
        ${c.partial ? html`<p class="say">${PARTIAL}</p>` : nothing}
        ${this.unfinished(this.strays(c.files), "link")}
        ${this.commentList("link")}
      </div>
      <div class="main"><button class="cbtn back" type="button" @click=${() => this.backToList()}>All files</button>${this.diff()}</div>
    </div>`;
  }

  override render() {
    const files = this.changes?.files ?? [];
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const onChanges = this.shownTab === "changes";
    const failed = this.loadError ? `Couldn't read the changes (${this.loadError}).` : this.listNote;
    return html`<p class="sr-only" role="status">${this.spoken}</p>
      <div class="head"><div class="tabs" role="tablist" aria-label="Review" @keydown=${this.onTabKey}>${TABS.map(
        (t) =>
          html`<button class="tab" id="tab-${t.id}" type="button" role="tab" aria-selected=${t.id === this.shownTab ? "true" : "false"} aria-controls="panel-${t.id === "changes" ? "changes" : "files"}"
          tabindex=${t.id === this.shownTab ? "0" : "-1"} @click=${() => this.pickTab(t.id)}>${t.label}</button>`,
      )}</div>
        <span class="sum">${onChanges && files.length ? `${files.length} ${files.length === 1 ? "file" : "files"} · +${added} −${removed}` : ""}</span><span class="grow"></span>
        ${onChanges ? html`<button class="cbtn refresh" type="button" aria-disabled=${this.loading ? "true" : "false"} @click=${this.retry}>${this.loading ? "Reading…" : "Refresh"}</button>` : nothing}
        <button class="x" type="button" aria-label="Close review" @click=${() => this.close()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      ${
        this.waiting
          ? html`<p class="say">${this.name || "The agent"} is waiting for your answer.
              <button class="link-btn" type="button" @click=${() =>
                this.dispatchEvent(
                  new CustomEvent("conv-review-answer", { bubbles: true, composed: true }),
                )}>Answer</button></p>`
          : this.running
            ? html`<p class="say">${this.name || "The agent"} is working, so this can change.${this.shownTab === "search" ? "" : " It refreshes when the turn ends."}</p>`
            : nothing
      }
      <div class="panel" id="panel-changes" role="tabpanel" aria-labelledby="tab-changes" ?hidden=${!onChanges}>
      ${
        failed && this.changes?.state === "ok"
          ? html`<p class="say" role="alert">${failed} <button class="link-btn" type="button" @click=${this.retry}>Try again</button></p>`
          : nothing
      }
      ${this.content()}</div>
      <div class="panel" id="panel-files" role="tabpanel" aria-labelledby="tab-${this.shownTab === "search" ? "search" : "files"}" ?hidden=${onChanges}>
        ${this.filesUsed ? html`<inc-conv-files .conversationId=${this.conv?.id ?? ""} .mode=${this.filesMode} .target=${this.target}></inc-conv-files>` : nothing}</div>`;
  }
}

customElements.define("inc-conv-review", IncConvReview);
