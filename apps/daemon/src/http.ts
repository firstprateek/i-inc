// How the daemon's one Bun server answers a request (main.ts): AHP upgrades, the web app's build, and the
// API, with the long owner actions given the longest wait Bun allows before the idle timeout cuts them.
import { isLongRequest, LONG_REQUEST_SEC } from "./long-requests.ts";

/**
 * Bun's idle timeout for a quiet HTTP connection, in seconds. Longer than the 90 s a proxy in front keeps an
 * idle connection (Go's IdleConnTimeout, which Tailscale serve uses), so the proxy always closes first and
 * never sends a request down a socket Bun is closing; Bun allows at most 255. The owner's long actions get
 * their own (long-requests.ts). A socket that carried one keeps the longer timeout for its later requests,
 * which still leaves the proxy closing first.
 */
export const IDLE_TIMEOUT_SEC = 120;

/** What the handler needs of Bun's server. */
export interface HttpServer<D> {
  upgrade(req: Request, options: { data: D }): boolean;
  timeout(req: Request, seconds: number): void;
  requestIP(req: Request): { address: string } | null;
}

export interface HttpRoutes<D> {
  /** The AHP socket at /ahp: whether a request is for it, and its locks. */
  ahp: { matches(req: Request): boolean; guard(req: Request): { refusal: Response } | { data: D } };
  /** The REST API. */
  api: (req: Request, o: { peer: string | undefined }) => Response | Promise<Response>;
  /** The web app's build, or null while there is none (the API answers every path then). */
  web: () => ((req: Request) => Response | Promise<Response>) | null;
}

export function httpFetch<D>(r: HttpRoutes<D>) {
  return (req: Request, server: HttpServer<D>): Response | Promise<Response> | undefined => {
    if (r.ahp.matches(req)) {
      const g = r.ahp.guard(req);
      if ("refusal" in g) return g.refusal;
      if (server.upgrade(req, { data: g.data })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    const url = new URL(req.url);
    const web = url.pathname.startsWith("/api/") ? null : r.web();
    if (web) return web(req);
    // A machine boot or GitHub can keep these quiet past the idle timeout, which would cut them silently.
    if (isLongRequest(req.method, url)) server.timeout(req, LONG_REQUEST_SEC);
    return r.api(req, { peer: server.requestIP(req)?.address });
  };
}
