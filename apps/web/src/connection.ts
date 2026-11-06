// Whether the daemon can be reached. Every API call reports here (api.ts), and the app swaps its
// views for the "Can't reach i.inc" panel while it can't.
//
// One failed request is not enough to say so. A browser drops an HTTP/2 connection now and then (behind
// Tailscale serve, the owner's browser did it many times a minute), and every request on it fails at
// once. So a failure only makes the daemon suspect: a few health probes over a few seconds decide, and
// any answer meanwhile (a request, the event stream opening, a frame on the AHP socket) calls it off.

export const connection = new EventTarget();
let offline = false;

/** How long each step waits, in ms. Tests make them shorter. */
export const timing = {
  /** Before a failed read is sent again (api.ts). */
  retryMs: 250,
  /** When each health probe goes out, counted from the suspicion. */
  probesMs: [0, 1000, 2500],
  /** A probe with no answer by then has failed. */
  probeTimeoutMs: 5000,
  /** An outage at least this long refetches every view once the daemon answers again (app.ts). */
  refreshAfterMs: 2000,
};

/** The confirmation running now, if any: its number, so one that was called off can tell. */
let confirming = 0;
let round = 0;
let timers: ReturnType<typeof setTimeout>[] = [];

export const isOffline = (): boolean => offline;

function set(reachable: boolean): void {
  if (reachable === !offline) return;
  offline = !reachable;
  connection.dispatchEvent(new Event("change"));
}

function stopConfirming(): void {
  confirming = 0;
  for (const t of timers) clearTimeout(t);
  timers = [];
}

/** The daemon answered (true), or is known to be gone (false). An answer calls off a confirmation. */
export function report(reachable: boolean): void {
  if (reachable) stopConfirming();
  set(reachable);
}

/**
 * A request failed: find out whether the daemon is gone before saying so. With the device offline that is
 * known at once; otherwise GET /api/health is asked a few times (`timing.probesMs`), and only when every
 * probe fails, with no answer from anywhere else in between, is the daemon unreachable.
 */
export function suspect(): void {
  if (offline || confirming) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    set(false);
    return;
  }
  const run = ++round;
  confirming = run;
  let failed = 0;
  timers = timing.probesMs.map((at) =>
    setTimeout(async () => {
      if (confirming !== run) return;
      const up = await probe();
      if (confirming !== run) return;
      if (up) report(true);
      else if (++failed === timing.probesMs.length) {
        stopConfirming();
        set(false);
      }
    }, at),
  );
}

/** One GET /api/health, straight to the network: any answer but 502-504 is the daemon's. */
async function probe(): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timing.probeTimeoutMs);
  try {
    const res = await fetch("/api/health", { cache: "no-store", signal: abort.signal });
    void res.body?.cancel().catch(() => {});
    return !isGatewayDown(res.status);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** A status that means "nothing is answering behind the proxy", not an answer from the daemon. */
export const isGatewayDown = (status: number): boolean => status === 502 || status === 503 || status === 504;
