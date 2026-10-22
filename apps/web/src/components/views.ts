// Which code a route needs, loaded when the route is first opened (T63: the first load is the shell and
// the view you land on, not all 250 modules). Each group below is one dynamic import, so the build makes
// one chunk per group and shares what groups have in common.
//
// A route is ready once the elements it renders are defined, so a test (or a view that is already in the
// page) that imported them directly needs no wait. Keep this in step with `view()` in app.ts.
import type { Route } from "../routes.ts";

export type ViewGroup =
  | "conversations"
  | "chat"
  | "work"
  | "desk"
  | "team"
  | "hiring"
  | "brain"
  | "projects"
  | "settings";

/** One group: how to load it, and the elements it defines. */
const GROUPS: Record<ViewGroup, { load: () => Promise<unknown> }> = {
  conversations: { load: () => import("./group-conversations.ts") },
  chat: { load: () => import("./chat.ts") },
  work: { load: () => import("./group-work.ts") },
  desk: { load: () => import("./desk.ts") },
  team: { load: () => import("./office.ts") },
  hiring: { load: () => import("./hiring.ts") },
  brain: { load: () => import("./group-brain.ts") },
  projects: { load: () => import("./group-projects.ts") },
  settings: { load: () => import("./setup.ts") },
};

/** What a route renders: the groups that define its elements, and those elements' tags. */
export interface Need {
  groups: ViewGroup[];
  tags: string[];
}

export function needFor(r: Route): Need {
  switch (r.view) {
    case "conversations":
      return r.old
        ? { groups: ["chat"], tags: ["inc-chat"] }
        : { groups: ["conversations"], tags: ["inc-conversations"] };
    case "needs-you":
      return { groups: ["work"], tags: ["inc-inbox"] };
    case "work":
      return r.tab === "board"
        ? { groups: ["work"], tags: ["inc-board"] }
        : { groups: ["desk"], tags: ["inc-desk"] };
    case "ticket":
      return { groups: ["work"], tags: [r.session ? "inc-ticket-session" : "inc-ticket"] };
    case "team":
      return { groups: ["team"], tags: ["inc-office"] };
    case "hiring":
      return { groups: ["hiring"], tags: ["inc-hiring"] };
    case "brain":
      return { groups: ["brain"], tags: [r.changes ? "inc-brain-changes" : "inc-knowledge"] };
    case "projects":
      return {
        groups: ["projects"],
        tags: [r.id ? "inc-project-page" : r.flow ? "inc-project-flow" : "inc-setup-projects"],
      };
    case "usage":
      return { groups: ["desk", "team"], tags: ["inc-desk", "inc-office"] };
    case "settings":
      return { groups: ["settings"], tags: ["inc-setup"] };
  }
}

/** Every element of the route is defined, so it can render now. */
export function isReady(need: Need): boolean {
  return need.tags.every((t) => customElements.get(t) !== undefined);
}

const loading = new Map<ViewGroup, Promise<void>>();

/**
 * Loads the code for a route; resolves when its elements are defined. A group that is loading is not asked
 * for twice. A failure (the network, or a chunk a newer build replaced) rejects, and the next call tries again.
 */
export function loadViews(need: Need): Promise<void> {
  if (isReady(need)) return Promise.resolve();
  return Promise.all(
    need.groups.map((g) => {
      let p = loading.get(g);
      if (!p) {
        p = GROUPS[g].load().then(
          () => undefined,
          (err) => {
            loading.delete(g);
            throw err;
          },
        );
        loading.set(g, p);
      }
      return p;
    }),
  ).then(() => undefined);
}
