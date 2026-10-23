// Addresses that come from data (the daemon, GitHub, an agent's output) are checked before they become a link's
// href: a `javascript:` or `data:` address in a field must never be followable, whatever the daemon sent.
// (Markdown links take the same care: conversations/markdown.ts `safeHref`.)
import { ifDefined } from "lit/directives/if-defined.js";

/** An http(s) address to another site (GitHub), or undefined: the link is then drawn without a destination. */
export function webHref(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length > 2000) return undefined;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** An address inside the app (`#/ticket/7`), or undefined. */
export function appHref(url: unknown): string | undefined {
  return typeof url === "string" && /^#\/[^\s]*$/.test(url) && url.length <= 2000 ? url : undefined;
}

/** A path on this daemon (`/api/tickets/7/attachments/1`): one `/`, never `//host` or a scheme. */
export function apiPath(url: unknown): string | undefined {
  return typeof url === "string" && /^\/(?!\/)[^\s\\]*$/.test(url) && url.length <= 2000 ? url : undefined;
}

/** For a template: `href=${web(url)}`. An unsafe address leaves the attribute off. */
export const web = (url: unknown) => ifDefined(webHref(url));
export const app = (url: unknown) => ifDefined(appHref(url));
export const api = (url: unknown) => ifDefined(apiPath(url));
