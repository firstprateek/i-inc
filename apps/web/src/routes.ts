// The route model (docs/layout.md): three areas, each with its own tabs. Pure functions only: the shell
// (components/app.ts) renders from this, and the tests drive it without a DOM.
import { LAYOUT_BREAKPOINTS, type LayoutKind } from "./components/layout.ts";

export type Area = "conversations" | "work" | "company";

export const AREAS: readonly { id: Area; label: string; href: string }[] = [
  { id: "conversations", label: "Conversations", href: "#/conversations" },
  { id: "work", label: "Work", href: "#/work/board" },
  { id: "company", label: "Company", href: "#/company/team" },
];

/** Work's tabs: the board, what needs the owner, and releases. */
export const WORK_TABS = [
  ["board", "Board"],
  ["needs-you", "Needs you"],
  ["releases", "Releases"],
] as const;
export type WorkTab = (typeof WORK_TABS)[number][0];

/** Company's tabs: who works here, what they know, where they work, what it costs, and the setup. */
export const COMPANY_TABS = [
  ["team", "Team"],
  ["brain", "Brain"],
  ["projects", "Projects"],
  ["usage", "Usage"],
  ["settings", "Settings"],
] as const;
export type CompanyTab = (typeof COMPANY_TABS)[number][0];

/** The sections inside Company → Settings. */
export const sections = [
  ["teams", "Teams"],
  ["engines", "Engines and accounts"],
  ["sandboxes", "Sandboxes"],
  ["notifications", "Notifications"],
] as const;
export type Section = (typeof sections)[number][0];
export const isSection = (s: string | undefined): s is Section => sections.some(([id]) => id === s);

const isWorkTab = (s: string | undefined): s is WorkTab => WORK_TABS.some(([id]) => id === s);

export type Route =
  | { view: "conversations"; id: string }
  | { view: "work"; tab: WorkTab }
  | { view: "ticket"; id: string }
  | { view: "team" }
  | { view: "hiring"; id?: string }
  /** An empty id is the company brain (the handbook); otherwise one employee's brain. */
  | { view: "brain"; id: string }
  /**
   * `#/company/projects` is the list. After it: `add` (pick or confirm a repo to add, `?repo=owner/name`),
   * `new` (start a new project), or a project's id (its page).
   */
  | { view: "projects"; flow?: "add" | "new"; id?: string }
  | { view: "usage" }
  | { view: "settings"; section: Section };

export const areaOf = (r: Route): Area =>
  r.view === "conversations"
    ? "conversations"
    : r.view === "work" || r.view === "ticket"
      ? "work"
      : "company";

/** The tab a route sits under, or null for a page that is in an area but on no tab (a ticket). */
export function tabOf(r: Route): WorkTab | CompanyTab | null {
  switch (r.view) {
    case "work":
      return r.tab;
    case "team":
    case "hiring":
      return "team";
    case "brain":
    case "projects":
    case "usage":
    case "settings":
      return r.view;
    default:
      return null;
  }
}

/** The single route-to-template map, also used by the layout regression test. */
export function layoutForRoute(route: Route): LayoutKind {
  switch (route.view) {
    case "conversations":
    case "brain":
    case "settings":
      return "split";
    case "team":
      return "wide";
    case "work":
      return route.tab === "board" ? "wide" : "page";
    default:
      return "page";
  }
}

/** True on a phone-sized screen, where the app opens on what needs the owner. */
const onPhone = () =>
  typeof matchMedia === "function" && matchMedia(`(max-width: ${LAYOUT_BREAKPOINTS.phone}px)`).matches;

/** Where the app opens with no hash, and where the logo goes: Conversations on a laptop, Needs you on a phone. */
export const homeHash = () => (onPhone() ? "#/work/needs-you" : "#/conversations");

/** Old hashes (before the three areas) and the canonical hash each one lands on. */
export function legacyTarget(hash: string): string | null {
  const [, view, id] = hash.split("/");
  switch (view) {
    case "inbox":
      return "#/work/needs-you";
    case "board":
      return "#/work/board";
    case "office":
    case "more":
      return "#/company/team";
    case "desk":
      return "#/company/usage";
    case "handbook":
      return "#/company/brain";
    case "brain":
      return id ? `#/company/brain/${id}` : "#/company/brain";
    case "chat":
      return id ? `#/conversations/${id}` : "#/conversations";
    case "hiring":
      return id ? `#/company/team/hiring/${id}` : "#/company/team/hiring";
    case "setup":
      return id === "projects" ? "#/company/projects" : `#/company/settings/${isSection(id) ? id : "teams"}`;
    default:
      return null;
  }
}

/**
 * Where a hash should be rewritten to, or null when it is fine as it is (or empty). An old hash lands on
 * its new address; case and a query string are ignored (`#/Inbox`, `#/inbox?x=1`); a canonical address
 * is tidied (`#/Work/Board`); anything the app does not know goes home.
 */
export function redirectFor(hash: string): string | null {
  if (!hash || hash === "#" || hash === "#/") return null;
  const path = hash.split("?")[0] ?? hash;
  const [h, view = "", ...rest] = path.replace(/\/+$/, "").split("/");
  if (h !== "#") return homeHash();
  const lower = (s: string | undefined) => s?.toLowerCase();
  const v = view.toLowerCase();
  const tail = (...parts: (string | undefined)[]) => parts.filter(Boolean).join("/");
  let out = legacyTarget(["#", v, lower(rest[0])].join("/")) ?? null;
  if (out && (v === "brain" || v === "chat" || v === "hiring") && rest[0])
    out = out.replace(/[^/]*$/, rest[0]);
  if (!out) {
    switch (v) {
      case "conversations":
        out = `#/${tail(v, rest[0])}`;
        break;
      case "work":
        out =
          rest[0] === undefined
            ? "#/work"
            : isWorkTab(lower(rest[0]))
              ? `#/work/${lower(rest[0])}`
              : "#/work/board";
        break;
      case "ticket":
        out = rest[0] ? `#/${tail(v, rest[0], lower(rest[1]) === "assign" ? "assign" : undefined)}` : null;
        break;
      case "company": {
        const a = lower(rest[0]);
        if (a === undefined) out = "#/company";
        else if (a === "brain") out = `#/${tail(v, a, rest[1])}`;
        else if (a === "usage") out = `#/company/${a}`;
        else if (a === "projects") {
          // add and new are the flows; anything else is a project's id, which keeps its case.
          const sub = lower(rest[1]) === "add" || lower(rest[1]) === "new" ? lower(rest[1]) : rest[1];
          out = `#/${tail(v, a, sub)}`;
        } else if (a === "settings")
          out =
            rest[1] === undefined
              ? "#/company/settings"
              : `#/company/settings/${isSection(lower(rest[1])) ? lower(rest[1]) : "teams"}`;
        else out = lower(rest[1]) === "hiring" ? `#/${tail(v, "team", "hiring", rest[2])}` : "#/company/team";
        break;
      }
    }
  }
  const target = out ?? homeHash();
  if (target === hash) return null;
  // A page that reads its own query (`#/conversations?new=1&project=Duet`, `#/company/projects/add?repo=a/b`)
  // keeps it when the address is otherwise canonical. Every other address drops its query.
  if (target === path && queryPages.test(path)) return null;
  return target;
}

/** The addresses whose query string means something (see redirectFor). */
const queryPages = /^#\/(?:conversations|company\/projects)(?:\/|$)/;

/** The query of a hash: `#/conversations?new=1&project=Duet` gives `new=1&project=Duet`. */
export const hashQuery = (hash: string): URLSearchParams => new URLSearchParams(hash.split("?")[1] ?? "");

/** Where the app opens with no hash. */
export function homeRoute(): Route {
  return onPhone() ? { view: "work", tab: "needs-you" } : { view: "conversations", id: "" };
}

export function parse(hash: string): Route {
  const [, view, a, b, c] = (redirectFor(hash) ?? hash).split("?")[0]?.split("/") ?? [];
  switch (view) {
    case "conversations":
      return { view: "conversations", id: a ?? "" };
    case "work":
      return { view: "work", tab: isWorkTab(a) ? a : "board" };
    case "ticket":
      if (a) return { view: "ticket", id: a };
      break;
    case "company":
      switch (a) {
        case "brain":
          return { view: "brain", id: b ?? "" };
        case "projects":
          return b === "add" || b === "new"
            ? { view: "projects", flow: b }
            : b
              ? { view: "projects", id: safeDecode(b) }
              : { view: "projects" };
        case "usage":
          return { view: "usage" };
        case "settings":
          return { view: "settings", section: isSection(b) ? b : "teams" };
        default:
          return b === "hiring" ? (c ? { view: "hiring", id: c } : { view: "hiring" }) : { view: "team" };
      }
  }
  return homeRoute();
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The page heading: the area, or the ticket. `short` is for very narrow screens. */
export function routeName(r: Route): { long: string; short: string } {
  const same = (t: string) => ({ long: t, short: t });
  switch (r.view) {
    case "conversations":
      return same("Conversations");
    case "work":
      return same("Work");
    case "ticket":
      return r.id ? { long: `Ticket #${r.id}`, short: `#${r.id}` } : same("Ticket");
    default:
      return same("Company");
  }
}

/** What a tabbed route is called in the browser title, the most specific first: "Board · Work". */
function titleParts(r: Route): string[] {
  const tab = (list: readonly (readonly [string, string])[], id: string) =>
    list.find(([t]) => t === id)?.[1] ?? "";
  switch (r.view) {
    case "conversations":
      return r.id ? [cap(r.id), "Conversations"] : ["Conversations"];
    case "work":
      return [tab(WORK_TABS, r.tab), "Work"];
    case "ticket":
      return [r.id ? `Ticket #${r.id}` : "Ticket", "Work"];
    case "team":
      return ["Team", "Company"];
    case "hiring":
      return ["Hiring", "Company"];
    case "brain":
      return [r.id ? `${cap(r.id)}’s brain` : "Brain", "Company"];
    case "projects":
      return r.id
        ? [r.id, "Projects", "Company"]
        : r.flow
          ? [r.flow === "add" ? "Add a repo" : "New project", "Projects", "Company"]
          : ["Projects", "Company"];
    case "usage":
      return ["Usage", "Company"];
    case "settings":
      return [tab(sections, r.section), "Settings", "Company"];
  }
}

/** The browser tab / window title for a route: "Board · Work · i.inc". */
export function routeTitle(r: Route): string {
  return [...titleParts(r), "i.inc"].join(" · ");
}

/** The hash a tab links to. */
export const workTabHref = (t: WorkTab) => `#/work/${t}`;
export const companyTabHref = (t: CompanyTab) => `#/company/${t}`;
