// How full an agent's context is, while a turn runs. An agent reports it at every step (ACP `usage_update`), and each
// reading that goes out is a row in the chat's action log, so the owner's meter gets the newest one at most every few
// seconds, and only when it changed. It is safe to send a turn's usage again and again: the reducer replaces it, so
// nothing adds up, and the turn's state stays the same size.

/** A chat gets a context reading at most this often (ms). */
export const CONTEXT_EVERY_MS = 5000;

/** What a turn's usage keeps in `_meta`, as the agent said it. */
export type ContextReading = { contextUsed: unknown; contextSize: unknown };

export class ContextMeter {
  /** The newest reading, sent or not. */
  latest: ContextReading | undefined;
  private sent: ContextReading | undefined;
  private sentAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** @param send Sends the turn's usage, with `latest`. False when it was dropped: the turn is over. */
  constructor(
    private readonly send: () => boolean,
    private readonly now: () => number,
  ) {}

  /** The agent reported. It goes out now, or when the wait is over, so a quiet agent's last reading isn't left behind. */
  note(used: unknown, size: unknown): void {
    this.latest = { contextUsed: used, contextSize: size };
    const wait = this.sentAt + CONTEXT_EVERY_MS - this.now();
    if (wait <= 0) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), wait);
      this.timer.unref?.();
    }
  }

  /** Sends what is being held back, if it says something new. */
  flush(): void {
    this.stop();
    const { latest, sent } = this;
    if (!latest || (latest.contextUsed === sent?.contextUsed && latest.contextSize === sent?.contextSize))
      return;
    if (!this.send()) return;
    this.sent = latest;
    this.sentAt = this.now();
  }

  /** The turn is over: nothing more goes out. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
