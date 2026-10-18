// Setup > Engines and accounts: which models the company can use, and the subscriptions behind them.
import { css, html } from "lit";
import { refreshNow } from "../api.ts";
import { type AccountCost, type Engine, type Harness, harnesses, setupApi } from "../setup-api.ts";
import { message, type Note, noteLine, setupStyles } from "../setup-shared.ts";
import { Loader } from "./loader.ts";
import { base } from "./shared.ts";

interface EnginesData {
  engines: Engine[];
  accounts: AccountCost[];
}

const idPattern = /^[a-z0-9-]{1,40}$/;
const money = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

/** "Claude Opus · claude-code · local": the engine as a single line (the same label hiring uses). */
export const engineLabel = (e: Engine) => `${e.model} · ${e.harness}${e.local ? " · local" : ""}`;

const feeLine = (a: AccountCost) =>
  a.monthlyFee !== undefined
    ? `${money(a.monthlyFee)} a month`
    : a.pricePerMillionTokens !== undefined
      ? `${money(a.pricePerMillionTokens)} per million tokens`
      : "No fee";

export class IncSetupEngines extends Loader<EnginesData> {
  static override properties = {
    ...Loader.properties,
    caps: { state: true },
    notes: { state: true },
    engine: { state: true },
    account: { state: true },
    busy: { state: true },
  };
  declare caps: Record<string, string>;
  declare notes: Record<string, Note>;
  declare engine: { id: string; harness: Harness; model: string; accountId: string; local: boolean };
  declare account: { id: string; name: string; fee: string; cap: string };
  declare busy: string | null;

  constructor() {
    super();
    this.caps = {};
    this.notes = {};
    this.engine = { id: "", harness: "claude-code", model: "", accountId: "", local: false };
    this.account = { id: "", name: "", fee: "", cap: "" };
    this.busy = null;
  }

  protected fetch = async (): Promise<EnginesData> => {
    const [engines, accounts] = await Promise.all([setupApi.engines(), setupApi.accounts()]);
    return { engines, accounts };
  };

  static override styles = [
    base,
    setupStyles,
    css`
      .engines { padding: 0; margin: 0; list-style: none; display: flex; flex-direction: column; }
      .engines li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 0; border-top: 1px solid var(--line); }
      .engines li:first-child { border-top: none; }
      .engines .sub { flex-basis: 100%; }
      .account { padding: 10px 0; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
      .account:first-of-type { border-top: none; }
      .capline { display: flex; gap: 10px; align-items: end; }
      .capline label { flex: 1; }
      @media (max-width: 480px) {
        .capline { flex-wrap: wrap; }
        .capline .btn { width: 100%; min-height: 44px; }
      }
      .working { background: var(--working-bg); color: var(--working-fg); }
      form { display: flex; flex-direction: column; gap: 12px; }
    `,
  ];

  private setNote(key: string, n: Note | undefined) {
    const { [key]: _gone, ...rest } = this.notes;
    this.notes = n ? { ...rest, [key]: n } : rest;
  }

  private async run(key: string, work: () => Promise<void>, ok: string) {
    this.busy = key;
    try {
      await work();
      this.setNote(key, { ok: true, text: ok });
      await this.reload();
      refreshNow();
    } catch (e) {
      this.setNote(key, { ok: false, text: message(e) });
    } finally {
      this.busy = null;
    }
  }

  private capOf(a: AccountCost): string {
    return this.caps[a.id] ?? (a.monthlyCap !== undefined ? String(a.monthlyCap) : "");
  }

  private saveCap(a: AccountCost) {
    const raw = this.capOf(a).trim();
    const cap = Number(raw);
    if (raw === "" || !Number.isFinite(cap) || cap < 0) {
      this.setNote(`cap-${a.id}`, { ok: false, text: "The cap is an amount of money, 0 or more." });
      return Promise.resolve();
    }
    return this.run(
      `cap-${a.id}`,
      async () => {
        await setupApi.saveAccount({ ...a, monthlyCap: cap });
        const { [a.id]: _gone, ...rest } = this.caps;
        this.caps = rest;
      },
      "Saved",
    );
  }

  private addAccount(ev: Event) {
    ev.preventDefault();
    const f = this.account;
    const id = f.id.trim();
    if (!idPattern.test(id)) {
      this.setNote("new-account", {
        ok: false,
        text: "An account id is lowercase letters, digits and dashes.",
      });
      return;
    }
    if (!f.name.trim()) {
      this.setNote("new-account", { ok: false, text: "Name the account." });
      return;
    }
    const fee = f.fee.trim() === "" ? undefined : Number(f.fee);
    const cap = f.cap.trim() === "" ? undefined : Number(f.cap);
    if ((fee !== undefined && !(fee >= 0)) || (cap !== undefined && !(cap >= 0))) {
      this.setNote("new-account", { ok: false, text: "Fee and cap are amounts of money, 0 or more." });
      return;
    }
    void this.run(
      "new-account",
      async () => {
        await setupApi.saveAccount({
          id,
          name: f.name.trim(),
          ...(fee !== undefined ? { monthlyFee: fee } : {}),
          ...(cap !== undefined ? { monthlyCap: cap } : {}),
        });
        this.account = { id: "", name: "", fee: "", cap: "" };
      },
      `Added ${f.name.trim()}`,
    );
  }

  private addEngine(ev: Event) {
    ev.preventDefault();
    const f = this.engine;
    const id = f.id.trim();
    const accountId = f.accountId || this.data?.accounts[0]?.id || "";
    if (!idPattern.test(id)) {
      this.setNote("new-engine", {
        ok: false,
        text: "An engine id is lowercase letters, digits and dashes.",
      });
      return;
    }
    if (!f.model.trim()) {
      this.setNote("new-engine", { ok: false, text: "Name the model." });
      return;
    }
    if (!accountId) {
      this.setNote("new-engine", {
        ok: false,
        text: "Add an account first: an engine signs in through one.",
      });
      return;
    }
    void this.run(
      "new-engine",
      async () => {
        await setupApi.saveEngine({
          id,
          harness: f.harness,
          model: f.model.trim(),
          accountId,
          local: f.local,
        });
        this.engine = { id: "", harness: "claude-code", model: "", accountId: "", local: false };
      },
      `Added ${f.model.trim()}`,
    );
  }

  override render() {
    if (this.error) return html`<p role="alert">The daemon isn't answering: ${this.error}</p>`;
    if (!this.data) return html`<p class="muted">Loading engines…</p>`;
    const { engines, accounts } = this.data;
    const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
    const e = this.engine;
    const a = this.account;
    return html`<div class="stack">
      <section class="card" aria-label="Engines">
        <h2>Engines</h2>
        ${
          engines.length
            ? html`<ul class="engines">${engines.map(
                (x) => html`<li title=${engineLabel(x)}>
                  <b>${x.model}</b><span class="muted">· ${x.harness}</span>
                  ${x.local ? html`<span class="chip working" title="Runs on this machine">local</span>` : ""}
                  <span class="sub">Signs in with ${name(x.accountId)}</span>
                </li>`,
              )}</ul>`
            : html`<p class="muted">No engines yet.</p>`
        }
      </section>

      <section class="card" aria-label="Add an engine">
        <h3>Add an engine</h3>
        <form @submit=${(ev: Event) => this.addEngine(ev)}>
          <div class="row">
            <label>Id <input type="text" name="engine-id" autocomplete="off" autocapitalize="off" placeholder="opus"
              .value=${e.id} @input=${(ev: InputEvent) => {
                this.engine = { ...this.engine, id: (ev.target as HTMLInputElement).value };
              }} /></label>
            <label>Model <input type="text" name="engine-model" autocomplete="off" placeholder="Claude Opus"
              .value=${e.model} @input=${(ev: InputEvent) => {
                this.engine = { ...this.engine, model: (ev.target as HTMLInputElement).value };
              }} /></label>
            <label>Harness
              <select name="engine-harness" .value=${e.harness}
                @change=${(ev: Event) => {
                  this.engine = {
                    ...this.engine,
                    harness: (ev.target as HTMLSelectElement).value as Harness,
                  };
                }}>
                ${harnesses.map((h) => html`<option value=${h} ?selected=${h === e.harness}>${h}</option>`)}
              </select></label>
            <label>Account
              <select name="engine-account" .value=${e.accountId || accounts[0]?.id || ""}
                @change=${(ev: Event) => {
                  this.engine = { ...this.engine, accountId: (ev.target as HTMLSelectElement).value };
                }}>
                ${accounts.map((x) => html`<option value=${x.id} ?selected=${x.id === (e.accountId || accounts[0]?.id)}>${x.name}</option>`)}
              </select></label>
          </div>
          <label class="check"><input type="checkbox" .checked=${e.local}
            @change=${(ev: Event) => {
              this.engine = { ...this.engine, local: (ev.target as HTMLInputElement).checked };
            }} />
            Runs on this machine (may see home data)</label>
          <div class="actions">
            <button class="btn" type="submit" ?disabled=${this.busy === "new-engine"}>Add engine</button>
            ${noteLine(this.notes["new-engine"])}
          </div>
        </form>
      </section>

      <section class="card" aria-label="Accounts">
        <h2>Accounts</h2>
        ${accounts.map(
          (x) => html`<div class="account">
            <div class="head"><b>${x.name}</b><span class="tag">${x.id}</span><span class="spacer"></span><span class="sub">${feeLine(x)}</span></div>
            <p class="sub">Used by ${
              engines
                .filter((n) => n.accountId === x.id)
                .map((n) => n.model)
                .join(", ") || "no engine yet"
            }</p>
            <div class="capline">
              <label>Monthly cap
                <input type="number" inputmode="decimal" min="0" step="any" placeholder="No cap" .value=${this.capOf(x)}
                  aria-label="Monthly cap for ${x.name}"
                  @input=${(ev: InputEvent) => {
                    this.caps = { ...this.caps, [x.id]: (ev.target as HTMLInputElement).value };
                    this.setNote(`cap-${x.id}`, undefined);
                  }} /></label>
              <button class="btn ghost" type="button" ?disabled=${this.caps[x.id] === undefined || this.busy === `cap-${x.id}`}
                @click=${() => this.saveCap(x)}>Save cap</button>
            </div>
            ${noteLine(this.notes[`cap-${x.id}`])}
          </div>`,
        )}
      </section>

      <section class="card" aria-label="Add an account">
        <h3>Add an account</h3>
        <form @submit=${(ev: Event) => this.addAccount(ev)}>
          <div class="row">
            <label>Id <input type="text" name="account-id" autocomplete="off" autocapitalize="off" placeholder="claude-pro"
              .value=${a.id} @input=${(ev: InputEvent) => {
                this.account = { ...this.account, id: (ev.target as HTMLInputElement).value };
              }} /></label>
            <label>Name <input type="text" name="account-name" autocomplete="off" placeholder="Claude Pro"
              .value=${a.name} @input=${(ev: InputEvent) => {
                this.account = { ...this.account, name: (ev.target as HTMLInputElement).value };
              }} /></label>
            <label>Monthly fee <input type="number" name="account-fee" inputmode="decimal" min="0" step="any" placeholder="20"
              .value=${a.fee} @input=${(ev: InputEvent) => {
                this.account = { ...this.account, fee: (ev.target as HTMLInputElement).value };
              }} /></label>
            <label>Monthly cap <input type="number" name="account-cap" inputmode="decimal" min="0" step="any" placeholder="No cap"
              .value=${a.cap} @input=${(ev: InputEvent) => {
                this.account = { ...this.account, cap: (ev.target as HTMLInputElement).value };
              }} /></label>
          </div>
          <div class="actions">
            <button class="btn" type="submit" ?disabled=${this.busy === "new-account"}>Add account</button>
            ${noteLine(this.notes["new-account"])}
          </div>
        </form>
      </section>
    </div>`;
  }
}

customElements.define("inc-setup-engines", IncSetupEngines);
