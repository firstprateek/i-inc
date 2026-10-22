// The "OK it" card for a ticket that touches protected paths: the same words and buttons in the
// inbox and on the board. The caller supplies the styles (.q, .actions) and runs the action.
// The card shows what the OK is for (T68): the commit, and the diff of the protected paths. The OK covers exactly
// that change: other content in the same paths, or the same content in another commit, asks again.
import { html } from "lit";
import { api, type TicketView } from "../api.ts";

/** What the card shows of a protected-paths ask. */
export interface ProtectedAsk {
  paths: string[];
  sha?: string | undefined;
  diff?: string | undefined;
  diffTruncated?: boolean | undefined;
}

/** How much of the diff is on the card before "Show all". */
export const DIFF_PREVIEW = 3000;

/** The commit and the diff, for the card: a preview, the rest behind "Show all". */
export function protectedDiff(ask: ProtectedAsk) {
  const diff = ask.diff ?? "";
  return html`${ask.sha ? html`<p class="muted">This OK is for commit <code>${ask.sha.slice(0, 7)}</code> and the change below: anything else asks again.</p>` : ""}
    ${
      diff
        ? html`<pre class="diff" style="white-space:pre-wrap;overflow:auto;max-height:24em;font-size:12px">${diff.slice(0, DIFF_PREVIEW)}</pre>
      ${diff.length > DIFF_PREVIEW ? html`<details><summary>Show all</summary><pre class="diff" style="white-space:pre-wrap;overflow:auto;max-height:60em;font-size:12px">${diff.slice(DIFF_PREVIEW)}</pre></details>` : ""}
      ${ask.diffTruncated ? html`<p class="muted">The diff is longer than can be shown here; the rest is cut.</p>` : ""}`
        : ""
    }`;
}

export function protectedOk(
  t: Pick<TicketView, "id" | "title">,
  ask: ProtectedAsk,
  act: (fn: () => Promise<unknown>) => void,
  busy = false,
) {
  return html`<div class="q">“${t.title}” changes protected paths: ${ask.paths.join(", ")}. It reaches main once you OK it.</div>
    ${protectedDiff(ask)}
    <div class="actions">
      <button type="button" class="btn" ?disabled=${busy} @click=${() => act(() => api.answer(t.id, "approve"))}>OK it</button>
      <button type="button" class="btn ghost" ?disabled=${busy} @click=${() => act(() => api.answer(t.id, "reject"))}>Decline</button>
    </div>`;
}
