// A view that loads its data on connect and again on every refresh.
import { LitElement } from "lit";
import { refresh } from "../api.ts";

export abstract class Loader<T> extends LitElement {
  static override properties = { data: { state: true }, error: { state: true } };
  declare data: T | null;
  declare error: string | null;

  constructor() {
    super();
    this.data = null;
    this.error = null;
  }

  protected abstract fetch(): Promise<T>;

  private onRefresh = () => void this.reload();

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
