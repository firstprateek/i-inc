// Whether the daemon can be reached. Every API call reports here (api.ts), and the app swaps its
// views for the "Can't reach i.inc" panel while it can't.

export const connection = new EventTarget();
let offline = false;

export const isOffline = (): boolean => offline;

export function report(reachable: boolean): void {
  if (reachable === !offline) return;
  offline = !reachable;
  connection.dispatchEvent(new Event("change"));
}

/** A status that means "nothing is answering behind the proxy", not an answer from the daemon. */
export const isGatewayDown = (status: number): boolean => status === 502 || status === 503 || status === 504;
