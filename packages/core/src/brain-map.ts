// A scope's map (docs/design/brain.md, "Reading"): one line per page, written as a retrieval cue, in
// sections by folder. It's always in the prompt, so it stays short: past 150 lines it splits, and the
// top map just lists the sections.

export interface MapPage {
  /** Path-like name in its scope, e.g. "tools/vitest-mocks" or "personality". */
  slug: string;
  description: string;
  title?: string;
}

export interface BuiltMap {
  /** The map to show: everything when it fits, otherwise the list of sections. */
  root: string[];
  /** Section name → its lines. Empty when the map did not need splitting. */
  sections: Record<string, string[]>;
}

export const mapLineLimit = 150;

/** "tools/vitest-mocks" → "tools"; a page with no folder goes under "general". */
export function folderOf(slug: string): string {
  const i = slug.indexOf("/");
  return i === -1 ? "general" : slug.slice(0, i);
}

const line = (p: MapPage) => `- [[${p.slug}]] — ${(p.description || p.title || p.slug).replace(/\s+/g, " ")}`;

/** Folders in a stable order: general first, then alphabetical. */
function grouped(pages: MapPage[]): [string, MapPage[]][] {
  const by = new Map<string, MapPage[]>();
  // Code-unit order, not localeCompare: it is stable across machines and about 20x faster.
  for (const p of [...pages].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
    const f = folderOf(p.slug);
    const list = by.get(f);
    if (list) list.push(p);
    else by.set(f, [p]);
  }
  return [...by.entries()].sort(([a], [b]) =>
    a === "general" ? -1 : b === "general" ? 1 : a < b ? -1 : a > b ? 1 : 0,
  );
}

/** The map for a scope's pages, split into sections when it would pass `limit` lines. */
export function buildMap(pages: MapPage[], limit = mapLineLimit): BuiltMap {
  const groups = grouped(pages);
  const whole: string[] = [];
  for (const [folder, ps] of groups) {
    if (whole.length) whole.push("");
    whole.push(`## ${folder}`, ...ps.map(line));
  }
  if (whole.length <= limit) return { root: whole, sections: Object.create(null) };

  // Too long: every folder becomes a section (chunked if it alone is too long), and the root lists them.
  // No prototype: a folder called "__proto__" or "constructor" is just a name.
  const sections: Record<string, string[]> = Object.create(null);
  for (const [folder, ps] of groups) {
    const per = limit - 2;
    for (let i = 0, n = 1; i < ps.length; i += per, n++) {
      const name = n === 1 ? folder : `${folder}#${n}`;
      sections[name] = [`## ${name}`, ...ps.slice(i, i + per).map(line)];
    }
  }
  const root: string[] = ["## Sections (ask for one by name; search finds pages across all of them)"];
  const names = Object.keys(sections);
  for (const [i, name] of names.entries()) {
    if (root.length >= limit - 1) {
      root.push(`- …and ${names.length - i} more sections`);
      break;
    }
    const count = (sections[name]?.length ?? 1) - 1;
    root.push(`- [[section:${name}]] — ${count} page${count === 1 ? "" : "s"}`);
  }
  return { root, sections };
}
