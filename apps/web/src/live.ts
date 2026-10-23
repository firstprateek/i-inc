// Live updates: one EventSource on /api/events for the whole app (contract C3), so the views refetch
// when something changes instead of polling. While the stream is down (never connected, 404, the
// daemon restarting) the old 5 s poll carries on, and a slow safety poll runs even while it is up.
import { refresh, refreshNow } from "./api.ts";
import { connection, isOffline } from "./connection.ts";

export const EVENTS_URL = "/api/events";
/** The events the daemon sends (C3). */
export const LIVE_EVENTS = ["ticket", "office"] as const;
export type LiveEventName = (typeof LIVE_EVENTS)[number];
export type LiveHandler = (data: { id?: string } & Record<string, unknown>) => void;

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** Events arriving within this window cost one refetch. */
export const DEBOUNCE_MS = 300;
/** Polling while the stream is down, and how often to look at whether a poll is due. */
export const FALLBACK_POLL_MS = 5000;
/** While the stream is up, refetch anyway if nothing else has for this long. */
export const SAFETY_POLL_MS = 60_000;

export class Live {
  private handlers = new Map<LiveEventName, Set<LiveHandler>>();
  private statusHandlers = new Set<(connected: boolean, reconnected: boolean) => void>();
  private source: EventSource | null = null;
  private retry = 0;
  private attempts = 0;
  private dropped = false;
  private started = false;
  private up = false;

  get connected(): boolean {
    return this.up;
  }

  /** Calls `handler` with the parsed data of every `event`. Returns the unsubscribe. */
  subscribe(event: LiveEventName, handler: LiveHandler): () => void {
    const set = this.handlers.get(event) ?? new Set<LiveHandler>();
    this.handlers.set(event, set);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** Calls `fn` when the stream opens or drops; `reconnected` is true for an open after a drop. */
  onStatus(fn: (connected: boolean, reconnected: boolean) => void): () => void {
    this.statusHandlers.add(fn);
    return () => {
      this.statusHandlers.delete(fn);
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    connection.addEventListener("change", this.onConnection);
    this.open();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    connection.removeEventListener("change", this.onConnection);
    clearTimeout(this.retry);
    this.close();
    this.up = false;
    this.attempts = 0;
    this.dropped = false;
  }

  /** The daemon answers again after being unreachable: don't wait out the backoff. */
  private onConnection = () => {
    if (isOffline() || this.up || !this.started) return;
    clearTimeout(this.retry);
    this.attempts = 0;
    this.open();
  };

  private open(): void {
    if (!this.started || this.source || typeof EventSource === "undefined") return;
    let es: EventSource;
    try {
      es = new EventSource(EVENTS_URL);
    } catch {
      this.schedule();
      return;
    }
    this.source = es;
    es.onopen = () => {
      if (this.source !== es) return;
      const reconnected = this.dropped;
      this.up = true;
      this.attempts = 0;
      for (const fn of this.statusHandlers) fn(true, reconnected);
    };
    es.onerror = () => {
      if (this.source !== es) return;
      // Browsers retry on their own at a fixed pace, or give up on a 404/401. Take over either way.
      this.close();
      this.dropped = true;
      const wasUp = this.up;
      this.up = false;
      if (wasUp) for (const fn of this.statusHandlers) fn(false, false);
      this.schedule();
    };
    for (const name of LIVE_EVENTS) {
      es.addEventListener(name, (e) => {
        let data: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse((e as MessageEvent).data);
          if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
        } catch {}
        for (const fn of this.handlers.get(name) ?? []) fn(data);
      });
    }
  }

  private close(): void {
    const es = this.source;
    this.source = null;
    es?.close();
  }

  private schedule(): void {
    if (!this.started) return;
    const wait = Math.min(BACKOFF_START_MS * 2 ** this.attempts, BACKOFF_MAX_MS);
    this.attempts += 1;
    clearTimeout(this.retry);
    this.retry = window.setTimeout(() => this.open(), wait);
  }
}

export const live = new Live();

/**
 * Wires the stream to the views: starts it, turns its events into debounced refetches (a ticket
 * event only for that ticket's page), refetches on reconnect, and keeps polling as the fallback and
 * the safety net. Returns a stop function.
 */
export function startLiveUpdates(stream: Live = live): () => void {
  let tickets = new Set<string>();
  let office = false;
  let broad = false;
  let timer = 0;
  let last = Date.now();

  const onRefresh = () => {
    last = Date.now();
  };
  refresh.addEventListener("refresh", onRefresh);

  const hidden = () => document.visibilityState === "hidden";
  const flush = () => {
    timer = 0;
    // A backgrounded tab does not refetch for events (each one costs a request); it keeps what they named and
    // catches up when it is shown again.
    if (hidden()) return;
    const scope = { tickets, office };
    const all = broad;
    tickets = new Set();
    office = false;
    broad = false;
    if (all) refreshNow();
    else refreshNow(scope);
  };
  const queue = () => {
    if (!timer) timer = window.setTimeout(flush, DEBOUNCE_MS);
  };

  const offTicket = stream.subscribe("ticket", (data) => {
    if (typeof data.id === "string") tickets.add(data.id);
    else broad = true;
    queue();
  });
  const offOffice = stream.subscribe("office", () => {
    office = true;
    queue();
  });
  const offStatus = stream.onStatus((connected, reconnected) => {
    if (!connected || !reconnected) return;
    if (hidden()) {
      broad = true; // catch up when shown
      return;
    }
    refreshNow();
  });

  const poll = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!stream.connected || Date.now() - last >= SAFETY_POLL_MS) refreshNow();
  }, FALLBACK_POLL_MS);

  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    if (tickets.size || office || broad) {
      queue(); // events came while it was hidden: one refetch of what they named
    } else if (Date.now() - last >= FALLBACK_POLL_MS) refreshNow();
  };
  document.addEventListener("visibilitychange", onVisible);

  stream.start();

  return () => {
    stream.stop();
    offTicket();
    offOffice();
    offStatus();
    clearTimeout(timer);
    clearInterval(poll);
    document.removeEventListener("visibilitychange", onVisible);
    refresh.removeEventListener("refresh", onRefresh);
  };
}
