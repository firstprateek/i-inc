// Chat (spec §10): one thread per employee. Questions get answers; asks become draft tickets you put
// on the board with one tap (a PA's asks become errands at once); notes reach a working employee at
// the next stage boundary.
import { css, html, LitElement } from "lit";
import { refreshNow } from "../api.ts";
import { avatar, base } from "./shared.ts";

type Entry =
  | { from: "owner"; at: number; text: string; urgent?: boolean }
  | { from: "employee"; at: number; text: string }
  | { from: "employee"; at: number; kind: "draft"; ticketId: string; title: string; confirmed: boolean }
  | { from: "employee"; at: number; kind: "errand"; ticketId: string; title: string }
  | { from: "system"; at: number; text: string };

interface Thread {
  id: string;
  name: string;
  role: string;
  last: Entry | null;
}

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

export class IncChat extends LitElement {
  static override properties = {
    employeeId: {},
    threads: { state: true },
    entries: { state: true },
    draft: { state: true },
    urgent: { state: true },
    busy: { state: true },
    error: { state: true },
  };
  declare employeeId: string;
  declare threads: Thread[];
  declare entries: Entry[];
  declare draft: string;
  declare urgent: boolean;
  declare busy: boolean;
  declare error: string | null;

  constructor() {
    super();
    this.employeeId = "";
    this.threads = [];
    this.entries = [];
    this.draft = "";
    this.urgent = false;
    this.busy = false;
    this.error = null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("employeeId") && changed.get("employeeId") !== undefined) void this.load();
  }

  private async load() {
    try {
      this.threads = (await json<{ threads: Thread[] }>("GET", "/api/chat")).threads;
      if (!this.employeeId && this.threads[0]) this.employeeId = this.threads[0].id;
      if (this.employeeId) {
        this.entries = (await json<{ entries: Entry[] }>("GET", `/api/chat/${this.employeeId}`)).entries;
      }
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private async send(e: Event) {
    e.preventDefault();
    const text = this.draft.trim();
    if (!text) return;
    this.busy = true;
    try {
      this.entries = (
        await json<{ entries: Entry[] }>("POST", `/api/chat/${this.employeeId}`, {
          text,
          ...(this.urgent ? { urgent: true } : {}),
        })
      ).entries;
      this.draft = "";
      this.urgent = false;
      refreshNow();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  private async confirm(ticketId: string) {
    await json("POST", `/api/chat/${this.employeeId}/drafts/${ticketId}`);
    await this.load();
    refreshNow();
  }

  static override styles = [
    base,
    css`
      .wrap { display: flex; gap: 20px; align-items: stretch; min-height: 70vh; }
      nav { width: 280px; flex-shrink: 0; padding: 10px; display: flex; flex-direction: column; gap: 2px; }
      nav a { display: flex; gap: 12px; align-items: center; padding: 10px; border-radius: 14px; text-decoration: none; }
      nav a[aria-current="true"] { background: var(--sunken); }
      nav small { display: block; font-size: 13px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
      .thread { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; }
      .head { padding: 16px 22px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 12px; }
      .msgs { flex-grow: 1; padding: 20px 22px; display: flex; flex-direction: column; gap: 12px; }
      .me { align-self: flex-end; max-width: 520px; padding: 11px 14px; border-radius: 16px 4px 16px 16px; background: var(--ink); color: var(--on-ink); }
      .them { align-self: flex-start; max-width: 620px; padding: 11px 14px; border-radius: 4px 16px 16px 16px; background: var(--sunken); }
      .sys { align-self: center; font-size: 13px; color: var(--ink-2); }
      .ticket { align-self: flex-start; max-width: 620px; border: 2px dashed var(--line-strong); border-radius: 16px; padding: 14px;
        display: flex; flex-direction: column; gap: 8px; background: var(--surface); }
      form { padding: 12px 16px 16px; border-top: 1px solid var(--line); display: flex; gap: 10px; }
      input { flex-grow: 1; min-width: 0; font: 15px var(--body); min-height: 46px; padding: 0 16px; border-radius: 999px;
        border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); }
      .empty { color: var(--ink-2); }
      .me .tag { display: inline-block; margin-bottom: 4px; }
      .urgent[aria-pressed="true"] { border: 2px solid var(--ink); padding: 0 17px; }
      @media (max-width: 800px) { .wrap { flex-direction: column; } nav { width: auto; flex-direction: row; overflow-x: auto; } nav small { display: none; } }
    `,
  ];

  override render() {
    const me = this.threads.find((t) => t.id === this.employeeId);
    return html`<div class="wrap">
      <nav class="card" aria-label="Chats">
        ${this.threads.map(
          (t) => html`<a href="#/chat/${t.id}" aria-current=${t.id === this.employeeId ? "true" : "false"}>
            ${avatar(t.id, t.name, 40)}<span><b>${t.name}</b><small>${this.preview(t.last) ?? t.role}</small></span></a>`,
        )}
      </nav>
      <section class="card thread" aria-label="Chat with ${me?.name ?? "the team"}">
        ${me ? html`<div class="head">${avatar(me.id, me.name, 44)}<div><h2>${me.name}</h2><span class="muted" style="font-size:13px">${me.role}</span></div></div>` : ""}
        <div class="msgs">
          ${this.entries.length ? this.entries.map((e) => this.entry(e)) : html`<p class="empty">Ask ${me?.name ?? "them"} anything, or ask for something new.</p>`}
          ${this.error ? html`<p role="alert">${this.error}</p>` : ""}
        </div>
        <form @submit=${this.send}>
          <input aria-label="Message ${me?.name ?? ""}" placeholder="Message ${me?.name ?? ""}" .value=${this.draft}
            @input=${(e: InputEvent) => {
              this.draft = (e.target as HTMLInputElement).value;
            }}>
          <button class="btn ghost urgent" type="button" aria-pressed=${this.urgent ? "true" : "false"}
            title=${me ? `Stop ${me.name}'s current session to read this now` : "Stop their current session to read this now"}
            @click=${() => {
              this.urgent = !this.urgent;
            }}>${this.urgent ? "✓ Urgent" : "Urgent"}</button>
          <button class="btn" type="submit" ?disabled=${this.busy || !this.draft.trim()}>Send</button>
        </form>
      </section>
    </div>`;
  }

  private preview(e: Entry | null): string | null {
    if (!e) return null;
    if ("kind" in e) return e.kind === "draft" ? `Drafted: ${e.title}` : `Errand: ${e.title}`;
    return e.text;
  }

  private entry(e: Entry) {
    if (e.from === "owner") {
      return html`<div class="me">${e.urgent ? html`<span class="tag">urgent</span><br>` : ""}${e.text}</div>`;
    }
    if (e.from === "system") return html`<div class="sys">${e.text}</div>`;
    if ("kind" in e && e.kind === "draft") {
      return html`<div class="ticket">
        <span class="tag" style="align-self:flex-start">draft ticket</span>
        <b>${e.title}</b>
        ${
          e.confirmed
            ? html`<a href="#/ticket/${e.ticketId}">On the board as #${e.ticketId}</a>`
            : html`<div style="display:flex;gap:8px"><button class="btn" @click=${() => this.confirm(e.ticketId)}>Put on the board</button>
              <a class="btn ghost" href="#/ticket/${e.ticketId}" style="display:inline-flex;align-items:center;text-decoration:none">Open</a></div>`
        }
      </div>`;
    }
    if ("kind" in e && e.kind === "errand") {
      return html`<div class="ticket"><span class="tag" style="align-self:flex-start">errand</span><b>${e.title}</b>
        <a href="#/ticket/${e.ticketId}">On the Home lane as #${e.ticketId}</a></div>`;
    }
    return html`<div class="them">${"text" in e ? e.text : ""}</div>`;
  }
}

customElements.define("inc-chat", IncChat);
