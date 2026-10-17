// A view that loads its data on connect and again on every refresh.
import { LitElement } from "lit";
import { type RefreshScope, refresh } from "../api.ts";

export abstract class Loader<T> extends LitElement {
  static override properties = { data: { state: true }, error: { state: true } };
  declare data: T | null;
  declare error: string | null;
  /** Set by a view of one ticket: it refetches for live events about that ticket only. */
  declare ticketId?: string;

  constructor() {
    super();
    this.data = null;
    this.error = null;
  }

  protected abstract fetch(): Promise<T>;

  private onRefresh = (e: Event) => {
    const scope = (e as CustomEvent<RefreshScope | undefined>).detail;
    if (scope && this.ticketId !== undefined && !scope.tickets.has(this.ticketId)) return;
    void this.reload();
  };

  async reload(): Promise<void> {
    try {
      this.data = await this.fetch();
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    refresh.addEventListener("refresh", this.onRefresh);
    void this.reload();
  }

  override disconnectedCallback(): void {
    refresh.removeEventListener("refresh", this.onRefresh);
    super.disconnectedCallback();
  }
}
