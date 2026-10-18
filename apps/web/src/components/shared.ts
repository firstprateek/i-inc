// Shared pieces every view uses: buttons, chips, cards and avatars. Colours come from tokens.css,
// each with one role (status, identity, action, alarm, neutral).
import { css, html } from "lit";

export const base = css`
  :host { display: block; color: var(--ink); font-family: var(--body); }
  h1, h2, h3 { font-family: var(--display); font-weight: 700; margin: 0; letter-spacing: -0.3px; }
  a { color: inherit; }
  a, button, summary, select, input, textarea { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
  /* Chrome, not content (T40): buttons, tabs and summaries are not selectable text and show the
     pointer; text, links inside prose, inputs and the transcripts stay selectable. */
  button, summary, [role="button"], [role="tab"] {
    cursor: pointer; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  }
  button:disabled, [aria-disabled="true"] { cursor: default; }
  /* One thin, themed scrollbar for every scroller in the app (scrollbar-color inherits from :root;
     the ::-webkit-scrollbar rules are for browsers without the standard properties). */
  * { scrollbar-width: thin; }
  @supports not (scrollbar-width: thin) {
    *::-webkit-scrollbar { width: 10px; height: 10px; }
    *::-webkit-scrollbar-track { background: transparent; }
    *::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }
    *::-webkit-scrollbar-thumb:hover { background: var(--scroll-thumb-hover); background-clip: content-box; }
  }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    -webkit-tap-highlight-color: transparent;
    box-shadow: var(--shadow-card);
    transition: transform 0.12s ease, box-shadow 0.12s ease;
  }
  a.card:active, button.card:active { transform: scale(0.98); opacity: 0.85; }
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
  .proj-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 6px;
    white-space: nowrap;
    max-width: 100%;
    box-sizing: border-box;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .proj-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .proj-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }
  .proj-0 { background: var(--proj-0-bg); color: var(--proj-0-fg); }
  .proj-0 .proj-dot { background: var(--proj-0-dot); }
  .proj-1 { background: var(--proj-1-bg); color: var(--proj-1-fg); }
  .proj-1 .proj-dot { background: var(--proj-1-dot); }
  .proj-2 { background: var(--proj-2-bg); color: var(--proj-2-fg); }
  .proj-2 .proj-dot { background: var(--proj-2-dot); }
  .proj-3 { background: var(--proj-3-bg); color: var(--proj-3-fg); }
  .proj-3 .proj-dot { background: var(--proj-3-dot); }
  .proj-4 { background: var(--proj-4-bg); color: var(--proj-4-fg); }
  .proj-4 .proj-dot { background: var(--proj-4-dot); }
  .proj-5 { background: var(--proj-5-bg); color: var(--proj-5-fg); }
  .proj-5 .proj-dot { background: var(--proj-5-dot); }
  .working { background: var(--working-bg); color: var(--working-fg); border: 1px solid var(--working-edge); }
  .reviewing { background: var(--reviewing-bg); color: var(--reviewing-fg); border: 1px solid var(--reviewing-edge); }
  .needs { background: var(--needs-bg); color: var(--needs-fg); border: 1px solid var(--needs-edge); }
  .done { background: var(--ink); color: var(--on-ink); }
  .alarm { background: var(--alarm); color: #fff; }
  .avatar { flex-shrink: 0; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
    font-family: var(--display); font-weight: 700; }
`;

// Identity tints: never a status colour (lessons 1-2). An employee's tint is an index into this list,
// chosen at hiring (pickTint in the core), so the order matters: neighbours are the most unlike.
export const tints: [string, string][] = [
  ["#DAE1E8", "#1F2D3A"], // slate
  ["#F3D6E1", "#5E1E37"], // rose
  ["#F0E1C2", "#52360E"], // sand
  ["#E3D4F4", "#3E1D61"], // lilac
  ["#F0DED2", "#5A2D18"], // clay
  ["#D8E2D4", "#20361D"], // stone
  ["#D6DCEE", "#1D2D56"], // periwinkle
];

/** Deterministic project hue index (0..5) from project name */
export function projectIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash % 6;
}

/** A project tag chip with a colored dot indicator */
export function projectBadge(name: string) {
  const idx = projectIndex(name);
  return html`<span class="proj-badge proj-${idx}" title=${name}><span class="proj-dot" aria-hidden="true"></span><span class="proj-name">${name}</span></span>`;
}

/** An employee's avatar, in the identity tint they were given at hiring. */
export function avatar(p: { name: string; tint: number }, size = 36) {
  const tintIdx = Math.abs(p.tint % tints.length);
  const name = p.name;
  return html`<span class="avatar" aria-hidden="true"
    style="width:${size}px;height:${size}px;background:var(--avatar-${tintIdx}-bg);color:var(--avatar-${tintIdx}-fg);font-size:${Math.round(size * 0.42)}px"
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
