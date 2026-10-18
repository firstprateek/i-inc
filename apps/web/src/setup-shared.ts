// Pieces the Setup sections share: form styles and the list editor for paths and commands.
import { css, html } from "lit";
import { layoutStyles } from "./components/layout.ts";

export const setupStyles = css`${layoutStyles}
  .stack { display: flex; flex-direction: column; gap: var(--layout-section-gap, 20px); }
  .card { padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }
  .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .head h3 { font-size: 20px; overflow-wrap: anywhere; }
  .spacer { flex-grow: 1; }
  .sub { font-size: 14px; color: var(--ink-2); overflow-wrap: anywhere; }
  .note { font-size: 13px; color: var(--ink-2); margin: 0; }
  h2 { font-size: 22px; }
  label, .field { font-size: 13px; font-weight: 600; color: var(--ink-2); display: flex; flex-direction: column; gap: 4px; border: 0;
    padding: 0; margin: 0; min-width: 0; }
  legend { padding: 0; font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 4px; }
  input[type="text"], input[type="number"], select { font: 16px var(--body); min-height: 44px; padding: 0 12px; border-radius: 10px;
    border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); min-width: 0; box-sizing: border-box; width: 100%; }
  input.mono { font-family: var(--mono); font-size: 16px; }
  .row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .seg { display: flex; border: 1px solid var(--line-strong); border-radius: 999px; overflow: hidden; }
  .seg button { flex: 1; font: 600 14px var(--body); min-height: 44px; padding: 0 14px; border: none; background: transparent;
    color: var(--ink); cursor: pointer; }
  .seg button[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); }
  .check { flex-direction: row; align-items: center; gap: 10px; font-size: 15px; color: var(--ink); min-height: 44px; }
  .check input { width: 22px; height: 22px; margin: 0; }
  .list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .list li { display: flex; gap: 6px; align-items: center; }
  .list li > .step { width: 22px; flex-shrink: 0; text-align: right; font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .icon { width: 44px; height: 44px; flex-shrink: 0; border-radius: 50%; border: 1px solid var(--line); background: transparent;
    color: var(--ink); cursor: pointer; font-size: 16px; display: inline-flex; align-items: center; justify-content: center; }
  .icon:disabled { opacity: 0.35; cursor: default; }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .ok { color: var(--working-fg); font-size: 14px; font-weight: 600; }
  .bad { color: var(--alarm-fg); font-size: 14px; font-weight: 600; }
  .alarm { background: var(--alarm); color: #fff; }
  @media (max-width: 560px) {
    .row { grid-template-columns: 1fr; }
    .card { padding: 16px; }
  }
`;

interface ListOptions {
  label: string;
  items: string[];
  noun: string;
  ordered?: boolean;
  mono?: boolean;
  placeholder?: string;
  onChange: (items: string[]) => void;
}

/** An editable list: one text input per entry, with remove (and move, when order matters). */
export function listEditor(o: ListOptions) {
  const set = (i: number, v: string) => o.onChange(o.items.map((x, j) => (j === i ? v : x)));
  const move = (i: number, d: number) => {
    const next = [...o.items];
    const [it] = next.splice(i, 1);
    next.splice(i + d, 0, it as string);
    o.onChange(next);
  };
  return html`<fieldset class="field">
    <legend>${o.label}</legend>
    <ul class="list">
      ${o.items.map(
        (v, i) => html`<li>
          ${o.ordered ? html`<span class="step" aria-hidden="true">${i + 1}</span>` : ""}
          <input type="text" class=${o.mono ? "mono" : ""} .value=${v} placeholder=${o.placeholder ?? ""}
            aria-label="${o.noun} ${i + 1}" autocomplete="off" autocapitalize="off" spellcheck="false"
            @input=${(e: InputEvent) => set(i, (e.target as HTMLInputElement).value)} />
          ${
            o.ordered
              ? html`<button class="icon" type="button" aria-label="Move ${o.noun} ${i + 1} up" ?disabled=${i === 0}
                    @click=${() => move(i, -1)}>↑</button>
                  <button class="icon" type="button" aria-label="Move ${o.noun} ${i + 1} down"
                    ?disabled=${i === o.items.length - 1} @click=${() => move(i, 1)}>↓</button>`
              : ""
          }
          <button class="icon" type="button" aria-label="Remove ${o.noun} ${i + 1}"
            @click=${() => o.onChange(o.items.filter((_, j) => j !== i))}>×</button>
        </li>`,
      )}
    </ul>
    <div><button class="btn ghost" type="button" @click=${() => o.onChange([...o.items, ""])}>Add ${o.noun}</button></div>
  </fieldset>`;
}

/** Status of the last save on one card. */
export interface Note {
  ok: boolean;
  text: string;
}

export const noteLine = (n: Note | undefined) =>
  n ? html`<span class=${n.ok ? "ok" : "bad"} role=${n.ok ? "status" : "alert"}>${n.text}</span>` : "";

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
