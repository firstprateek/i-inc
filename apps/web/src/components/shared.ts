// Shared pieces every view uses: buttons, chips, cards and avatars. Colours come from tokens.css,
// each with one role (status, identity, action, alarm, neutral).
import { css, html } from "lit";

export const base = css`
  :host { display: block; color: var(--ink); font-family: var(--body); }
  h1, h2, h3 { font-family: var(--display); font-weight: 700; margin: 0; letter-spacing: -0.3px; }
  a { color: inherit; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
  .muted { color: var(--ink-2); }
  .btn {
    font: 700 15px var(--body); min-height: 44px; padding: 0 18px; border-radius: 999px; cursor: pointer; white-space: nowrap;
    border: none; background: var(--ink); color: var(--on-ink);
  }
  .btn.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line-strong); font-weight: 600; }
  .btn:focus-visible, a:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 700;
    padding: 3px 10px; border-radius: 999px; background: var(--neutral-bg); color: var(--neutral-fg); white-space: nowrap; }
  .tag { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 6px; background: var(--sunken); color: var(--neutral-fg); }
  .working { background: var(--working-bg); color: var(--working-fg); }
  .reviewing { background: var(--reviewing-bg); color: var(--reviewing-fg); }
  .needs { background: var(--needs-bg); color: var(--needs-fg); }
  .done { background: var(--ink); color: var(--on-ink); }
  .alarm { background: var(--alarm); color: #fff; }
  .avatar { flex-shrink: 0; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
    font-family: var(--display); font-weight: 700; }
`;

// Identity tints: never a status colour (lessons 1-2).
const tints: [string, string][] = [
  ["#DDE1E6", "#34404C"], // slate
  ["#F1DCE4", "#6B2B45"], // rose
  ["#E6DDF0", "#4B3366"], // lilac
  ["#E5E2DA", "#46423A"], // stone
  ["#EDE3D0", "#5A4524"], // sand
  ["#EADFD6", "#5B3E2E"], // clay
  ["#E3E1EC", "#3D3A5C"], // periwinkle
];

export function avatar(id: string, name: string, size = 36) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [bg, fg] = tints[h % tints.length] ?? tints[0] ?? ["#DDE1E6", "#34404C"];
  return html`<span class="avatar" aria-hidden="true"
    style="width:${size}px;height:${size}px;background:${bg};color:${fg};font-size:${Math.round(size * 0.42)}px"
    >${name.charAt(0)}</span>`;
}

export const stateLabel: Record<string, [string, string]> = {
  working: ["Working", "working"],
  reviewing: ["Reviewing", "reviewing"],
  "needs-you": ["Needs you", "needs"],
  "out-of-tokens": ["Coffee break", ""],
  done: ["Done", "done"],
  failed: ["Failed", "alarm"],
  off: ["Off", ""],
  idle: ["Idle", ""],
};

export const check = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"></path></svg>`;
