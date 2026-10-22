// The "Sessions" section of a ticket: each agent session that worked on it, and (when opened) what
// the agent said and which tools it ran (contract C4). Tool calls start collapsed. The section
// hides itself when the daemon has no transcripts to give (404, empty, or unreachable).
import { css, html, LitElement, nothing } from "lit";
import { api, refresh, type TicketSession, type TranscriptItem } from "../api.ts";
import { brainHref, brainScopeLabel } from "../conversations/model.ts";
import { base } from "./shared.ts";

/** Output past this many lines or characters is cut, with a "Show all" button. */
export const MAX_LINES = 12;
export const MAX_CHARS = 800;

export function isLong(s: string): boolean {
  return s.length > MAX_CHARS || s.split("\n").length > MAX_LINES;
}

export function truncate(s: string): string {
  const cut = s.split("\n").slice(0, MAX_LINES).join("\n");
  return cut.length > MAX_CHARS ? cut.slice(0, MAX_CHARS) : cut;
}

/** Splits agent text into prose and ``` fenced code blocks; an unclosed fence runs to the end. */
export function splitBlocks(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const parts = text.split("```");
  parts.forEach((part, i) => {
    const code = i % 2 === 1;
    // The first line after an opening fence is the language tag.
    const body = code ? part.replace(/^[^\n]*\n/, "").replace(/\n$/, "") : part.trim();
    if (body) out.push({ code, text: body });
  });
  return out;
}

const failed = (status?: string) => !!status && /fail|error|denied|cancel/i.test(status);

export function sessionHasError(s: TicketSession): boolean {
  return s.items.some((i) => i.kind === "tool" && failed(i.status));
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function span(s: TicketSession): string {
  if (s.endedAt === null) return `${clock(s.startedAt)} to now`;
  const mins = Math.max(1, Math.round((s.endedAt - s.startedAt) / 60_000));
  return `${clock(s.startedAt)} to ${clock(s.endedAt)} (${mins} min)`;
}

export class IncTranscript extends LitElement {
  static override properties = {
    ticketId: {},
    sessions: { state: true },
    openSessions: { state: true },
    openTools: { state: true },
    showAll: { state: true },
  };
  declare ticketId: string;
  declare sessions: TicketSession[] | null;
  declare openSessions: Set<number>;
  declare openTools: Set<string>;
  declare showAll: Set<string>;

  constructor() {
    super();
    this.ticketId = "";
    this.sessions = null;
    this.openSessions = new Set();
    this.openTools = new Set();
    this.showAll = new Set();
  }

  private onRefresh = () => void this.load();

  override connectedCallback(): void {
    super.connectedCallback();
    refresh.addEventListener("refresh", this.onRefresh);
  }

  override disconnectedCallback(): void {
    refresh.removeEventListener("refresh", this.onRefresh);
    super.disconnectedCallback();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("ticketId") && this.ticketId) {
      this.openSessions = new Set();
      this.openTools = new Set();
      this.showAll = new Set();
      void this.load();
    }
  }

  private async load(): Promise<void> {
    const id = this.ticketId;
    try {
      const s = await api.sessions(id);
      if (id === this.ticketId) this.sessions = s;
    } catch {
      // Keep what we have; a failed refresh is not worth an alarm in a secondary section.
    }
  }

  private flip(set: "openSessions" | "openTools" | "showAll", key: number | string) {
    const next = new Set<number | string>(this[set]);
    if (!next.delete(key)) next.add(key);
    (this as unknown as Record<string, unknown>)[set] = next;
  }

  static override styles = [
    base,
    css`
      :host { display: block; min-width: 0; }
      :host([hidden]) { display: none; }
      section { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
      h2 { font-size: 20px; }
      ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      li { min-width: 0; }
      .head, .tool > button { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; box-sizing: border-box;
        padding: 8px 12px; text-align: left; font: 14px/1.35 var(--body); color: var(--ink); background: var(--sunken);
        border: 1px solid var(--line); border-radius: 12px; cursor: pointer; }
      .head:focus-visible, .tool > button:focus-visible, .more:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
      .head .what { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .head b { font-size: 15px; overflow-wrap: anywhere; }
      .head small { color: var(--ink-2); font-size: 12.5px; overflow-wrap: anywhere; }
      .caret { flex: 0 0 auto; width: 10px; height: 10px; border-right: 2px solid var(--ink-2); border-bottom: 2px solid var(--ink-2);
        transform: rotate(-45deg); transition: transform 0.12s; }
      [aria-expanded="true"] > .caret { transform: rotate(45deg); }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .items { margin: 8px 0 4px; padding-left: 10px; border-left: 2px solid var(--line); display: flex; flex-direction: column; gap: 10px; }
      .text { display: flex; flex-direction: column; gap: 8px; min-width: 0; font-size: 15px; line-height: 1.5; }
      .text p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .text time, .tool time { font-size: 12px; color: var(--ink-2); }
      pre.code, pre.out { margin: 0; padding: 10px 12px; border-radius: 10px; background: var(--screen); color: var(--screen-text);
        border: 1px solid var(--screen-edge); font: 12.5px/1.5 var(--mono); white-space: pre; overflow: auto; max-width: 100%;
        max-height: 320px; box-sizing: border-box; }
      .tool > button .t { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 13px; }
      .tool .detail { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .tool .full { margin: 0; font: 13px/1.45 var(--mono); white-space: pre-line; overflow-wrap: anywhere; }
      .tool.err > button { background: var(--needs-surface); border-color: var(--alarm); }
      .tool.err .st { color: var(--alarm-fg); font-weight: 700; }
      .st { flex: 0 0 auto; font-size: 12px; font-weight: 700; color: var(--ink-2); }
      .more { min-height: 44px; align-self: flex-start; padding: 0 14px; font: 600 14px var(--body); color: var(--ink);
        background: transparent; border: 1px solid var(--line-strong); border-radius: 999px; cursor: pointer; }
      .empty { color: var(--ink-2); font-size: 14px; margin: 0; }
      .brain { display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
      .brain ul { gap: 2px; }
      .brain a { color: var(--ink); overflow-wrap: anywhere; }
      .tag { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--line); color: var(--ink-2); font-size: 11.5px; font-weight: 600; }
      .tag.warn { border-color: var(--alarm); color: var(--alarm-fg); }
    `,
  ];

  override render() {
    const sessions = this.sessions;
    if (!sessions || sessions.length === 0) return nothing;
    return html`<section aria-label="Sessions">
      <h2>Sessions</h2>
      <ul>${sessions.map((s, i) => this.session(s, i))}</ul>
    </section>`;
  }

  private session(s: TicketSession, i: number) {
    const open = this.openSessions.has(i);
    const running = s.endedAt === null;
    const bad = sessionHasError(s);
    return html`<li>
      <button class="head" aria-expanded=${open} aria-controls="s${i}" @click=${() => this.flip("openSessions", i)}>
        <span class="what">
          <b>${s.stage} · ${s.employeeId}</b>
          <small>${s.engineId} · ${span(s)}${s.brain?.length ? ` · ${s.brain.length} brain page${s.brain.length === 1 ? "" : "s"}` : ""}</small>
        </span>
        <span class="chips">
          <span class="chip ${running ? "working" : "done"}">${running ? "Running" : "Finished"}</span>
          ${bad ? html`<span class="chip alarm">Errors</span>` : nothing}
        </span>
        <span class="caret" aria-hidden="true"></span>
      </button>
      ${
        open
          ? html`<div class="items" id="s${i}">
            ${
              s.brain?.length
                ? html`<div class="brain"><b>Brain pages used</b>
              <ul>${s.brain.map(
                (p) => html`<li><a href=${brainHref(p.scope)} title=${p.slug}>${p.title}</a>
                <span class="tag">${brainScopeLabel(p.scope)}</span>
                ${p.via === "read" ? html`<span class="tag">opened</span>` : nothing}
                ${p.untrusted ? html`<span class="tag warn" title="Built from web pages, issues or other people's repos">untrusted</span>` : nothing}</li>`,
              )}</ul></div>`
                : nothing
            }
            ${s.items.length === 0 ? html`<p class="empty">Nothing recorded for this session.</p>` : nothing}
            ${s.items.map((it, j) => this.item(it, `${i}:${j}`))}
          </div>`
          : nothing
      }
    </li>`;
  }

  private item(it: TranscriptItem, key: string) {
    return it.kind === "tool" ? this.tool(it, key) : this.say(it);
  }

  private say(it: TranscriptItem) {
    return html`<div class="text">
      <time>${clock(it.at)}</time>
      ${splitBlocks(it.text ?? "").map((b) =>
        b.code ? html`<pre class="code" tabindex="0"><code>${b.text}</code></pre>` : html`<p>${b.text}</p>`,
      )}
    </div>`;
  }

  private tool(it: TranscriptItem, key: string) {
    const open = this.openTools.has(key);
    const err = failed(it.status);
    const title = (it.title ?? "Tool call").split("\n")[0] ?? "";
    const out = it.text ?? "";
    const long = isLong(out);
    const all = this.showAll.has(key);
    return html`<div class="tool ${err ? "err" : ""}">
      <button aria-expanded=${open} @click=${() => this.flip("openTools", key)}>
        <span class="t">${title}</span>
        ${it.status ? html`<span class="st">${err ? "Failed" : it.status}</span>` : nothing}
        <span class="caret" aria-hidden="true"></span>
      </button>
      ${
        open
          ? html`<div class="detail">
            <time>${clock(it.at)}</time>
            <p class="full">${it.title ?? "Tool call"}</p>
            ${
              out
                ? html`<pre class="out" tabindex="0" aria-label="Tool output"><code>${long && !all ? `${truncate(out)}\n…` : out}</code></pre>
                  ${
                    long
                      ? html`<button class="more" @click=${() => this.flip("showAll", key)}>${all ? "Show less" : "Show all"}</button>`
                      : nothing
                  }`
                : nothing
            }
          </div>`
          : nothing
      }
    </div>`;
  }
}

customElements.define("inc-transcript", IncTranscript);
