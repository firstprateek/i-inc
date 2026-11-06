// The owner's actions that can outlast Bun's idle timeout (main.ts). Each one may boot a machine, wait
// in its queue, run git in it and talk to GitHub, which can pass two minutes. Bun cuts a request that
// sends nothing for `idleTimeout` seconds without a word, and the proxy in front turns the cut into a
// 502, which the web app reads as "the daemon is down". So main.ts gives these the longest wait Bun allows.

/** Bun's largest per-request idle timeout, in seconds. */
export const LONG_REQUEST_SEC = 255;

const conversationAction = /^\/api\/conversations\/[^/]+\/(ticket|pr|take-back)$/;
const conversationShip = /^\/api\/conversations\/[^/]+\/ship$/;

/**
 * Whether a request is one of the long owner actions: the Ship dialog's preview (it wakes the machine),
 * making a ticket or a PR from a conversation, taking it back, and starting a conversation.
 */
export function isLongRequest(method: string, url: URL): boolean {
  const path = url.pathname;
  if (method === "GET") return conversationShip.test(path) && url.searchParams.get("preview") === "1";
  if (method !== "POST") return false;
  return path === "/api/conversations" || conversationAction.test(path);
}
