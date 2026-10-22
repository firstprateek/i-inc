// The daemon's lock, shared by the REST API and the AHP WebSocket upgrade: the login as a session in
// the `i_inc` cookie, or the daemon token as an `Authorization: Bearer` header, plus the Host and Origin allow-lists.
import { timingSafeEqual } from "node:crypto";

/** Compares secrets in constant time. */
export function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The `i_inc` cookie's value, if the request has one. */
export function sessionCookie(req: Request): string | undefined {
  return /(?:^|;\s*)i_inc=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
}

/** What proves a request is the owner's: a bearer token, a live session, or an old cookie holding the token. */
export type Credential = "bearer" | "session" | "legacy-cookie";

/**
 * How the request proves itself, or undefined.
 * - `Authorization: Bearer <daemon token>`: scripts and the deployer.
 * - The `i_inc` cookie holding a live session (what a browser login gets).
 * - The `i_inc` cookie holding the daemon token itself: what browsers logged in before sessions have.
 *   Still honoured, and the API swaps it for a session cookie on the browser's next request.
 */
export function credential(
  req: Request,
  token: string,
  sessions?: { valid(raw: string): boolean },
): Credential | undefined {
  const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (bearer !== undefined && same(bearer, token)) return "bearer";
  const cookie = sessionCookie(req);
  if (cookie === undefined) return undefined;
  if (same(cookie, token)) return "legacy-cookie";
  if (sessions?.valid(cookie)) return "session";
  return undefined;
}

export function authorized(req: Request, token: string, sessions?: { valid(raw: string): boolean }): boolean {
  return credential(req, token, sessions) !== undefined;
}

/** Is this Host header one the daemon answers? Unset list: any (tests). */
export function hostAllowed(hosts: string[] | undefined, host: string): boolean {
  return !hosts || hosts.includes(host);
}

/** Is this Origin one of ours? A request with no Origin (not a browser) passes. */
export function originAllowed(hosts: string[] | undefined, origin: string | null): boolean {
  return !origin || !hosts || hosts.some((h) => origin === `http://${h}` || origin === `https://${h}`);
}
