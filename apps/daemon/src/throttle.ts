// Wrong-guess limits for the logins (password, token, setup code): per client, so one peer guessing can't
// lock the owner out for longer than its own window, and can't make the daemon do work for it.

/** Who is asking: the first `X-Forwarded-For` hop (a proxy such as `tailscale serve` sets it), else one shared "direct" client. */
export function clientKey(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || req.headers.get("x-real-ip")?.trim() || "direct";
}

export class GuessLimit {
  private fails = new Map<string, number[]>();

  /** `max` wrong guesses in any `windowMs` block a client until the oldest one ages out. */
  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number,
  ) {}

  private recent(key: string): number[] {
    const at = this.now();
    const live = (this.fails.get(key) ?? []).filter((t) => at - t < this.windowMs);
    if (live.length) this.fails.set(key, live);
    else this.fails.delete(key);
    return live;
  }

  /** Seconds until this client may guess again, or 0 when it may now. */
  retryAfter(key: string): number {
    const live = this.recent(key);
    if (live.length < this.max) return 0;
    return Math.max(1, Math.ceil(((live[0] as number) + this.windowMs - this.now()) / 1000));
  }

  /** Records a wrong guess. */
  fail(key: string): void {
    this.fails.set(key, [...this.recent(key), this.now()]);
    // A client map that only grows is a leak: forget the idle ones now and then.
    if (this.fails.size > 1000) for (const k of [...this.fails.keys()]) this.recent(k);
  }

  clear(key: string): void {
    this.fails.delete(key);
  }
}
