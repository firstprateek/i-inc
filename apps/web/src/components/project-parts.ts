// Pieces the three projects screens share (T62): their styles, the mode choice and a problem callout.
import { css, html } from "lit";
import { type ApiProblem, MODE_WORDS } from "../github-projects.ts";
import type { MergeMode } from "../setup-api.ts";

export const projectStyles = css`
  :host { display: block; }
  .stack { display: flex; flex-direction: column; gap: var(--layout-section-gap, 20px); min-width: 0; }
  section.block { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  h2 { font-size: 20px; }
  h3 { font-size: 18px; overflow-wrap: anywhere; }
  p { margin: 0; line-height: 1.45; }
  .card { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .muted { color: var(--ink-2); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .small { font-size: 14px; }
  code, .mono { font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
  a.link { color: var(--ink); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
  a.link, .tap { display: inline-flex; align-items: center; min-height: 44px; }
  a.btn, button.btn { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; box-sizing: border-box; }
  .btn:disabled { opacity: 0.55; cursor: default; }
  .row { display: flex; align-items: center; gap: 10px 14px; flex-wrap: wrap; min-width: 0; }
  .spacer { flex: 1 1 auto; }
  .actions { display: flex; align-items: center; gap: 10px 14px; flex-wrap: wrap; }

  /* Forms. 16px text and 44px controls, as the layout rules ask. */
  label, .field, fieldset { font-size: 13px; font-weight: 600; color: var(--ink-2); display: flex; flex-direction: column; gap: 4px;
    border: 0; padding: 0; margin: 0; min-width: 0; }
  legend { padding: 0; font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 6px; }
  input[type="text"], input[type="search"], textarea {
    font: 16px var(--body); color: var(--ink); background: var(--surface); box-sizing: border-box; width: 100%; min-width: 0;
    min-height: 44px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--control-edge); }
  input.mono { font-family: var(--mono); font-size: 16px; }
  input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 1px; }
  .hint { font-size: 14px; font-weight: 400; color: var(--ink-2); line-height: 1.4; }
  .error-line { font-size: 14px; font-weight: 600; color: var(--alarm-fg); }

  /* A choice you can tap anywhere on: a real radio inside a bordered label. */
  .choices { display: grid; gap: 8px; }
  .choices.cols { grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
  .choice { flex-direction: row; align-items: flex-start; gap: 12px; padding: 12px 14px; min-height: 44px; box-sizing: border-box;
    border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); cursor: pointer; color: var(--ink);
    font-size: 15px; font-weight: 400; }
  .choice:has(input:checked) { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
  .choice:has(input:focus-visible) { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
  .choice input { width: 22px; height: 22px; margin: 1px 0 0; flex: none; accent-color: var(--ink); }
  .choice-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .choice-text b { font-size: 15px; font-weight: 700; }
  .choice-text span { font-size: 14px; color: var(--ink-2); line-height: 1.35; }
  .seg { display: flex; border: 1px solid var(--line-strong); border-radius: 999px; overflow: hidden; }
  .seg label { flex: 1; position: relative; color: var(--ink); font-size: 15px; font-weight: 600; }
  .seg input { position: absolute; opacity: 0; inset: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .seg span { display: flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 14px; }
  .seg input:checked + span { background: var(--ink); color: var(--on-ink); }
  .seg input:focus-visible + span { outline: 3px solid var(--reviewing-mark); outline-offset: -3px; }
  .check { flex-direction: row; align-items: center; gap: 10px; font-size: 15px; font-weight: 400; color: var(--ink); min-height: 44px; }
  .check input { width: 22px; height: 22px; margin: 0; accent-color: var(--ink); }
  .list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .list li { display: flex; gap: 6px; align-items: center; }
  .list li > .step { width: 22px; flex-shrink: 0; text-align: right; font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .icon { width: 44px; height: 44px; flex-shrink: 0; border-radius: 50%; border: 1px solid var(--line); background: transparent;
    color: var(--ink); cursor: pointer; font-size: 16px; display: inline-flex; align-items: center; justify-content: center; }
  .icon:disabled { opacity: 0.35; cursor: default; }

  /* Notes. Amber is "this needs you"; a problem has the alarm edge; neutral is information. */
  .callout { padding: 12px 14px; border-radius: 12px; font-size: 15px; line-height: 1.45; background: var(--sunken); color: var(--ink);
    display: flex; flex-direction: column; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
  .callout.needs { background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--needs-edge); }
  .callout.problem { background: var(--surface); border: 1px solid var(--line-strong); border-left: 4px solid var(--alarm); }
  .callout b { font-weight: 700; }
  .callout a { color: inherit; font-weight: 700; }
  .callout .row { gap: 8px 14px; }

  @media (max-width: 560px) {
    .card { padding: 14px 16px; }
    .row.stack-narrow { flex-direction: column; align-items: stretch; }
  }
`;

/** The two modes as radios, each with its one plain sentence. */
export function modePicker(name: string, mode: MergeMode, onChange: (m: MergeMode) => void) {
  const one = (m: MergeMode) => html`<label class="choice">
    <input type="radio" name=${name} value=${m} .checked=${mode === m} @change=${() => onChange(m)} />
    <span class="choice-text"><b>${MODE_WORDS[m].label}</b><span>${MODE_WORDS[m].sentence}</span></span>
  </label>`;
  return html`<fieldset class="field">
    <legend>How finished work reaches the main branch</legend>
    <div class="choices">${one("owner-merges")}${one("direct")}</div>
  </fieldset>`;
}

/** A GitHub or daemon problem in words, with anything to wait for or do. */
export function problemBox(e: unknown, actions?: unknown) {
  const text = e instanceof Error ? e.message : String(e);
  const wait = (e as ApiProblem | undefined)?.extra?.retryAfter;
  return html`<div class="callout problem" role="alert">
    <span>${text}</span>
    ${wait && !/\bseconds?\b|\bminutes?\b/.test(text) ? html`<span class="hint">Try again in about ${wait} seconds.</span>` : ""}
    ${actions ?? ""}
  </div>`;
}
