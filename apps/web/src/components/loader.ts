// A view that loads its data on connect and again on every refresh.
//
// A failed request never takes the view away. The data (and anything typed into the view) stays on
// screen: a refresh that fails only tells the shell (`load-stale`), which shows a banner with a retry
// above the view, and the next refresh or reconnect fills the data in again. `error` is only for a
// view that has nothing to show yet because its first load failed, and `failure()` draws that with a
// retry button too. An answer that arrives out of order (a slow response to an older request) is dropped.
import { html, LitElement, nothing } from "lit";
import { ApiError, type RefreshScope, refresh, refreshNow } from "../api.ts";
import { isOffline } from "../connection.ts";

/** What a view tells the shell, so one banner covers every view: `detail` is the message, or null once it's fine. */
export const LOAD_STATE = "load-state";
export interface LoadState {
  source: EventTarget;
  message: string | null;
}

export abstract class Loader<T> extends LitElement {
  static override properties = {
    data: { state: true },
    error: { state: true },
    actionError: { state: true },
    pressing: { state: true },
  };
  declare data: T | null;
  /** The first load failed and there is nothing to show. A later failed refresh keeps `data` and sets no error. */
  declare error: string | null;
  /** The last button press failed: shown inline above the data, which stays. */
  declare actionError: string | null;
  /** A button press (`press`) is in flight; views disable their action buttons while it is. */
  declare pressing: boolean;
  /** Set by a view of one ticket: it refetches for live events about that ticket only. */
  declare ticketId?: string;
  /** The HTTP status behind `error` (404: nothing there), when it was the daemon that refused. */
  protected errorStatus: number | null = null;
  private loadSeq = 0;

  constructor() {
    super();
    this.data = null;
    this.error = null;
    this.actionError = null;
    this.pressing = false;
  }

  protected abstract fetch(): Promise<T>;

  private onRefresh = (e: Event) => {
    const scope = (e as CustomEvent<RefreshScope | undefined>).detail;
    if (scope && this.ticketId !== undefined && !scope.tickets.has(this.ticketId)) return;
    void this.reload();
  };

  async reload(): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      const data = await this.fetch();
      if (seq !== this.loadSeq) return; // a newer request has been made: this answer is out of date
      this.data = data;
      this.error = null;
      this.errorStatus = null;
      this.report(null);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      const message = e instanceof Error ? e.message : String(e);
      if (this.data === null) {
        this.error = message;
        this.errorStatus = e instanceof ApiError ? e.status : null;
      } else this.report(message);
    }
  }

  /** Forgets what's loaded and any failure, for a view that is now about something else (another ticket). */
  protected resetLoad(): void {
    this.loadSeq++; // an answer to the old request must not land
    this.data = null;
    this.error = null;
    this.errorStatus = null;
    this.actionError = null;
    this.report(null);
  }

  private report(message: string | null): void {
    this.dispatchEvent(
      new CustomEvent<LoadState>(LOAD_STATE, {
        bubbles: true,
        composed: true,
        detail: { source: this, message },
      }),
    );
  }

  /**
   * A button press: one at a time, with the failure shown inline (`actionNotice`) and the data left alone.
   * Refreshes on success, unless `fn` says otherwise by resolving to `false`.
   */
  protected async press(fn: () => Promise<unknown>): Promise<boolean> {
    if (this.pressing) return false;
    this.pressing = true;
    this.actionError = null;
    try {
      const result = await fn();
      if (result !== false) refreshNow();
      return true;
    } catch (e) {
      this.actionError = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      this.pressing = false;
    }
  }

  /** The failed button press, above the view's data. */
  protected actionNotice() {
    return this.actionError ? html`<div class="load-error" role="alert">${this.actionError}</div>` : nothing;
  }

  /**
   * What a view shows when its first load failed: the reason and a way to try again. Offline, the shell
   * already says so in its banner, so this only says nothing has loaded yet.
   */
  protected failure(what = "this page") {
    const offline = isOffline();
    const cap = `${what[0]?.toUpperCase()}${what.slice(1)}`;
    // A view with a page of its own for "no such thing" (the ticket, a brain) shows that before it gets here;
    // for any other 404 the daemon's raw sentence ("no such employee") is not shown.
    const text = offline
      ? `Nothing has loaded yet. ${cap} loads when i.inc answers.`
      : this.errorStatus === 404
        ? `${cap} isn't there. It may have been removed.`
        : `Couldn't load ${what}: ${this.error}`;
    return html`<div class="load-error" role="alert">
      <span>${text}</span>
      <button class="btn ghost" type="button" @click=${() => void this.reload()}>Try again</button>
    </div>`;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    refresh.addEventListener("refresh", this.onRefresh);
    void this.reload();
  }

  override disconnectedCallback(): void {
    refresh.removeEventListener("refresh", this.onRefresh);
    // Answers that land after the view is gone are dropped. (The shell forgets this view's failure itself:
    // an event from a detached element reaches no one.)
    this.loadSeq++;
    super.disconnectedCallback();
  }
}
