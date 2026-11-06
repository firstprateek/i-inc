// The owner's actions that can outlast Bun's idle timeout. Each one may boot a machine, wait in its queue,
// run git in it and talk to GitHub, which can pass two minutes. Bun cuts a request that sends nothing for
// `idleTimeout` seconds without a word, and the proxy in front turns the cut into a 502, which the web app
// reads as "the daemon is down". So the server gives these the longest wait Bun allows (http.ts), and the
// writes among them count as busy, so the deployer waits for them (api.ts). One table for both.

/** Bun's largest per-request idle timeout, in seconds. */
export const LONG_REQUEST_SEC = 255;

/** Writes that can run for minutes, as api.ts names its routes ("METHOD /pattern/:param"). */
export const LONG_WRITES: ReadonlySet<string> = new Set([
  "POST /api/conversations/:id/ticket",
  "POST /api/conversations/:id/pr",
  "POST /api/conversations/:id/take-back",
  "POST /api/projects/:id/bootstrap",
  "POST /api/sandboxes/:team/retry",
  "POST /api/teams/:id/antigravity-callback",
  // a failed ticket made from a conversation is reclaimed: its machine wakes and git runs in it (ship.ts)
  "POST /api/tickets/:id/retry",
]);

/** Requests that wait as long, but are not counted busy: starting a conversation, and the Ship preview. */
const LONG_OTHERS = ["POST /api/conversations", "GET /api/conversations/:id/ship?preview=1"];

/** Whether `path` fits `pattern`, where a `:name` segment is any one non-empty segment. */
function fits(pattern: string, path: string): boolean {
  const a = pattern.split("/");
  const b = path.split("/");
  return a.length === b.length && a.every((seg, i) => (seg.startsWith(":") ? b[i] !== "" : seg === b[i]));
}

/** Whether a request is one of the long owner actions. */
export function isLongRequest(method: string, url: URL): boolean {
  for (const route of [...LONG_WRITES, ...LONG_OTHERS]) {
    const [m = "", target = ""] = route.split(" ");
    if (m !== method) continue;
    const [pattern = "", query] = target.split("?");
    if (!fits(pattern, url.pathname)) continue;
    if (query === undefined) return true;
    const [key = "", value] = query.split("=");
    if (url.searchParams.get(key) === value) return true;
  }
  return false;
}
