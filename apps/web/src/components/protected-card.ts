// The "OK it" card for a ticket that touches protected paths: the same words and buttons in the
// inbox and on the board. The caller supplies the styles (.q, .actions) and runs the action.
import { html } from "lit";
import { api, type TicketView } from "../api.ts";

export function protectedOk(
  t: Pick<TicketView, "id" | "title">,
  paths: string[],
  act: (fn: () => Promise<unknown>) => void,
  busy = false,
) {
  return html`<div class="q">“${t.title}” changes protected paths: ${paths.join(", ")}. It reaches main once you OK it.</div>
    <div class="actions">
      <button type="button" class="btn" ?disabled=${busy} @click=${() => act(() => api.answer(t.id, "approve"))}>OK it</button>
      <button type="button" class="btn ghost" ?disabled=${busy} @click=${() => act(() => api.answer(t.id, "reject"))}>Decline</button>
    </div>`;
}
