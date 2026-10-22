// Wrong-guess limits for the logins (password, token, setup code): per client, so one peer guessing can't
// lock the owner out for longer than its own window, and can't make the daemon do work for it.

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/**
 * Who is asking. A client controls `X-Forwarded-For` (it can send any list), so only the hop the daemon's
 * own proxy appended counts, and only when the connection really came from that proxy on loopback
 * (`tailscale serve`, one hop): the LAST entry. Any other peer is identified by its socket address and its
 * headers are ignored. Identity headers such as `Tailscale-User-Login` are NOT part of the key: whatever a
 * proxy passes through from the client could be varied to dodge the limit. No `peer` (tests, calling the
 * handler directly) is taken to be the proxy.
 */
export function clientKey(req: Request, peer?: string): string {
  if (peer !== undefined && !LOOPBACK_PEERS.has(peer)) return `peer:${peer}`;
  const hops = req.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops?.at(-1) ?? "local";
}

export class GuessLimit {
  private fails = new Map<string, number[]>();

  private lockedUntil = new Map<string, number>();

  /**
   * `max` wrong guesses in any `windowMs` block a client until the oldest one ages out. With `lockoutMs`, the
   * `max`th wrong guess instead locks the client out for that long from then.
   */
  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number,
    private lockoutMs = 0,
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
    const lock = this.lockedUntil.get(key);
    if (lock !== undefined) {
      if (lock > this.now()) return Math.ceil((lock - this.now()) / 1000);
      this.lockedUntil.delete(key);
    }
    const live = this.recent(key);
    if (live.length < this.max) return 0;
    return Math.max(1, Math.ceil(((live[0] as number) + this.windowMs - this.now()) / 1000));
  }

  /** Records a wrong guess; true when it was the one that reached the limit. */
  fail(key: string): boolean {
    const live = [...this.recent(key), this.now()];
    this.fails.set(key, live);
    const hit = live.length >= this.max;
    if (hit && this.lockoutMs) {
      this.lockedUntil.set(key, this.now() + this.lockoutMs);
      this.fails.delete(key);
    }
    // A client map that only grows is a leak: forget the idle ones now and then.
    if (this.fails.size > 1000) for (const k of [...this.fails.keys()]) this.recent(k);
    return hit;
  }

  clear(key: string): void {
    this.fails.delete(key);
  }
}
