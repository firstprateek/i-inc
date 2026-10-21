// The daemon's lock, shared by the REST API and the AHP WebSocket upgrade: the login token as the
// `i_inc` cookie or an `Authorization: Bearer` header, plus the Host and Origin allow-lists.
import { timingSafeEqual } from "node:crypto";

/** Compares secrets in constant time. */
export function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The token as the web app's cookie, or as a bearer header. */
export function authorized(req: Request, token: string): boolean {
  const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  const cookie = /(?:^|;\s*)i_inc=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  return [bearer, cookie].some((t) => t !== undefined && same(t, token));
}

/** Is this Host header one the daemon answers? Unset list: any (tests). */
export function hostAllowed(hosts: string[] | undefined, host: string): boolean {
  return !hosts || hosts.includes(host);
}

/** Is this Origin one of ours? A request with no Origin (not a browser) passes. */
export function originAllowed(hosts: string[] | undefined, origin: string | null): boolean {
  return !origin || !hosts || hosts.some((h) => origin === `http://${h}` || origin === `https://${h}`);
}
