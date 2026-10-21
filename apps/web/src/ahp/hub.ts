// The one AHP connection of the web app, shared by the shell (the Needs you count) and the Conversations
// screen. Views take a lease with `useAhp()`; the socket opens with the first and closes a few seconds after
// the last, so switching between views does not thrash it and nothing is left open behind a closed view.
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { api } from "../api.ts";
import { AhpConnection } from "./connection.ts";

/** Where the host listens: the page's own origin, `/ahp` (the `i_inc` cookie rides on the upgrade). */
export function ahpUrl(loc: Pick<Location, "protocol" | "host"> = location): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/ahp`;
}

let conn: AhpConnection | undefined;
let leases = 0;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

export const STOP_AFTER_MS = 4000;

function make(): AhpConnection {
  const c = new AhpConnection({
    log: (m) => console.info(m),
    connect: async () => {
      try {
        const t = await WebSocketTransport.connect(ahpUrl());
        failures = 0;
        return t;
      } catch (e) {
        // A refused upgrade does not say why. After a couple of tries, ask the REST API: a 401 there
        // shows the sign-in screen, and the socket then connects with the new cookie.
        if (++failures >= 2) void api.conversations().catch(() => {});
        throw e;
      }
    },
  });
  if (typeof addEventListener === "function") {
    addEventListener("online", () => c.retryNow());
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") c.retryNow();
    });
  }
  return c;
}

/** The shared connection (not started until something holds a lease). */
export function ahp(): AhpConnection {
  conn ??= make();
  return conn;
}

/** Holds the connection open; returns the release. */
export function useAhp(): () => void {
  clearTimeout(stopTimer);
  leases++;
  const c = ahp();
  c.start();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--leases > 0) return;
    stopTimer = setTimeout(() => {
      if (leases === 0) c.stop();
    }, STOP_AFTER_MS);
  };
}

/** For tests: forgets the shared connection. */
export function resetAhp(): void {
  clearTimeout(stopTimer);
  conn?.stop();
  conn = undefined;
  leases = 0;
  failures = 0;
}

/** For tests: puts a connection (over a fake transport) where the shared one would be. */
export function setAhp(c: AhpConnection | undefined): void {
  resetAhp();
  conn = c;
}
