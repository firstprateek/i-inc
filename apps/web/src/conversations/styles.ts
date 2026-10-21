// Styles shared by the Conversations components (each Lit element has its own shadow root, so a component
// that renders markdown or a button row includes the sheet it needs).
import { css } from "lit";

/** Rendered markdown: prose, lists, quotes, tables and code with its syntax colours. */
export const markdownStyles = css`
  .md { font-size: 15.5px; line-height: 1.55; overflow-wrap: anywhere; min-width: 0; }
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p { margin: 0 0 0.8em; }
  .md .md-h { margin: 1.1em 0 0.4em; line-height: 1.25; }
  h3.md-h { font-size: 19px; } h4.md-h { font-size: 17px; } h5.md-h { font-size: 15.5px; }
  .md ul, .md ol { margin: 0 0 0.8em; padding-left: 1.5em; }
  .md li { margin: 0.15em 0; }
  .md li > .li-body > :last-child { margin-bottom: 0; }
  .md li > .li-body > ul, .md li > .li-body > ol { margin: 0.2em 0 0; }
  .md li.task { list-style: none; display: flex; gap: 8px; margin-left: -1.3em; }
  .md li.task input { margin: 0.35em 0 0; flex: none; }
  .md blockquote { margin: 0 0 0.8em; padding: 2px 0 2px 14px; border-left: 3px solid var(--line-strong); color: var(--ink-2); }
  .md hr { border: 0; border-top: 1px solid var(--line); margin: 1.2em 0; }
  .md a { color: var(--reviewing-fg); text-underline-offset: 2px; }
  .md a:focus-visible, .md .copy:focus-visible, .md pre:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
  .md code.ic { font: 0.88em var(--mono); background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px; padding: 1px 5px; }
  .md .table-wrap { overflow-x: auto; margin: 0 0 0.8em; max-width: 100%; }
  .md table { border-collapse: collapse; font-size: 14px; }
  .md th, .md td { border: 1px solid var(--line); padding: 6px 10px; vertical-align: top; }
  .md th { background: var(--sunken); text-align: left; }
  .md .code { margin: 0 0 0.9em; border: 1px solid var(--line); border-radius: 12px; background: var(--code-bg); overflow: hidden; }
  .md .code-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px 4px 12px;
    border-bottom: 1px solid var(--line); font-size: 12px; color: var(--ink-2); }
  .md .code-lang { font-family: var(--mono); }
  .md .copy { min-height: 32px; min-width: 44px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-2);
    font: 600 12px var(--body); cursor: pointer; }
  @media (pointer: coarse) { .md .copy { min-height: 44px; min-width: 56px; } }
  .md .copy:hover { background: var(--sunken); color: var(--ink); }
  .md pre { margin: 0; padding: 12px 14px; overflow-x: auto; white-space: pre; font: 13px/1.5 var(--mono); font-variant-ligatures: none; tab-size: 2; max-width: 100%; }
  .md pre code { font: inherit; }
  .tk-kw { color: var(--tk-kw); font-weight: 600; } .tk-str { color: var(--tk-str); } .tk-com { color: var(--tk-com); font-style: italic; }
  .tk-num { color: var(--tk-num); } .tk-fn { color: var(--tk-fn); } .tk-ty { color: var(--tk-ty); } .tk-pun { color: var(--ink-2); }
  .tk-tag { color: var(--tk-tag); } .tk-attr { color: var(--tk-attr); } .tk-meta { color: var(--tk-com); }
  .tk-add { color: var(--diff-add-fg); background: var(--diff-add-bg); } .tk-del { color: var(--diff-del-fg); background: var(--diff-del-bg); }
`;

/** Small buttons and chips used in cards. */
export const cardStyles = css`
  button { font-family: var(--body); }
  .cbtn { min-height: 44px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--line-strong); background: transparent; color: var(--ink);
    font: 700 14px var(--body); cursor: pointer; white-space: nowrap; }
  .cbtn.primary { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
  .cbtn.danger { color: var(--alarm-fg); border-color: var(--alarm); }
  .cbtn:disabled { opacity: 0.55; cursor: default; }
  .cbtn:focus-visible, .link-btn:focus-visible, summary:focus-visible { outline: 3px solid var(--reviewing-mark); outline-offset: 2px; }
  .link-btn { background: none; border: 0; padding: 0 4px; min-height: 32px; font: 600 13px var(--body); color: var(--reviewing-fg); text-decoration: underline;
    text-underline-offset: 2px; cursor: pointer; }
  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  /* A finger needs 44px (docs/layout.md): the small text buttons grow on a touch screen. */
  @media (pointer: coarse) { .link-btn { min-height: 44px; min-width: 44px; padding: 0 10px; } }
  @media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
`;
