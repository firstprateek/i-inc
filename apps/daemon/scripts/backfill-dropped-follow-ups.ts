// Recovers follow-ups the daemon dropped before proposals existed (T51). It reads a daemon log for
// lines like
//   2026-10-19T08:12:01.000Z follow-up "Cover the retry path" from ada not filed: i-inc's budget for today is used
// and turns each into an open proposal for the owner to accept or decline. The log kept only the
// title, who proposed it and the project, so the rest is blank or defaulted.
//
//   bun apps/daemon/scripts/backfill-dropped-follow-ups.ts <daemon.log> [--db <path>] [--apply]
//
// Without --apply it only prints what it would store. The database defaults to the daemon's own
// ($I_INC_HOME or ~/.i-inc, i-inc.db). Running it twice stores nothing new: an open proposal with
// the same project and title is skipped.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Db, openDb } from "../src/db.ts";
import { normalTitle, Proposals } from "../src/proposals.ts";
import { migrate } from "../src/schema.ts";

export const RECOVERED_BODY = "Recovered from the daemon log; details were not kept.";

export interface DroppedFollowUp {
  title: string;
  proposedBy: string;
  project: string;
  /** When the daemon logged it (epoch ms), or null when the line has no timestamp. */
  at: number | null;
  line: number;
}

const DROPPED = /follow-up "(.+)" from (\S+) not filed: (.+)'s budget for today is used\s*$/;
const STAMP = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s/;

/** The dropped follow-ups a daemon log mentions, in order. */
export function parseDroppedFollowUps(text: string): DroppedFollowUp[] {
  const found: DroppedFollowUp[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = DROPPED.exec(raw);
    if (!m) return;
    const stamp = STAMP.exec(raw)?.[1];
    const at = stamp ? Date.parse(stamp) : Number.NaN;
    found.push({
      title: m[1] as string,
      proposedBy: m[2] as string,
      project: m[3] as string,
      at: Number.isNaN(at) ? null : at,
      line: i + 1,
    });
  });
  return found;
}

export interface BackfillResult {
  stored: DroppedFollowUp[];
  /** Already a proposal (open, accepted or declined) or a ticket, or repeated in the log. */
  skipped: DroppedFollowUp[];
  /** Names a project or employee this daemon doesn't have; skipped unless `includeUnknown`. */
  unknown: DroppedFollowUp[];
}

export interface BackfillOptions {
  /** Everything that already exists, in any status: every proposal and every ticket's project and title. */
  existing?: { project: string; title: string }[];
  /** The projects and employees this daemon has; absent when they can't be checked. */
  known?: { projects: Set<string>; employees: Set<string> } | null;
  includeUnknown?: boolean;
}

/**
 * Stores the parsed follow-ups as open proposals. With no `proposals` nothing is written: it only
 * works out which would be stored. Anything already a proposal (whatever the owner decided) or a
 * ticket is skipped, so running it again, or after accepting some, never files duplicates.
 */
export function backfill(
  found: DroppedFollowUp[],
  proposals: Proposals | null,
  now: number,
  options: BackfillOptions = {},
): BackfillResult {
  const result: BackfillResult = { stored: [], skipped: [], unknown: [] };
  const keyOf = (project: string, title: string) => `${project}\n${normalTitle(title)}`;
  const seen = new Set((options.existing ?? []).map((e) => keyOf(e.project, e.title)));
  for (const f of found) {
    const key = keyOf(f.project, f.title);
    if (seen.has(key)) {
      result.skipped.push(f);
      continue;
    }
    const k = options.known;
    if (k && !options.includeUnknown && (!k.projects.has(f.project) || !k.employees.has(f.proposedBy))) {
      result.unknown.push(f);
      continue;
    }
    seen.add(key);
    proposals?.add(
      {
        project: f.project,
        title: f.title,
        body: RECOVERED_BODY,
        proposedBy: f.proposedBy,
        sourceTicket: "",
        type: "chore",
        effort: "medium",
        doneWhen: [],
      },
      f.at ?? now,
    );
    result.stored.push(f);
  }
  return result;
}

const tableExists = (db: Db, name: string) =>
  db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;

/** What the daemon's database already holds, for the dedupe and the unknown-name check. */
export function readExisting(db: Db): Pick<BackfillOptions, "existing" | "known"> {
  const existing: { project: string; title: string }[] = [];
  if (tableExists(db, "proposals")) existing.push(...new Proposals(db).list());
  if (tableExists(db, "tickets")) {
    for (const r of db.all<{ body: string }>("SELECT body FROM tickets")) {
      try {
        const t = JSON.parse(r.body) as { project?: unknown; title?: unknown };
        if (typeof t.project === "string" && typeof t.title === "string")
          existing.push({ project: t.project, title: t.title });
      } catch {}
    }
  }
  if (!tableExists(db, "company")) return { existing, known: null };
  const ids = (kind: string) =>
    new Set(db.all<{ id: string }>("SELECT id FROM company WHERE kind = ?", kind).map((r) => r.id));
  return { existing, known: { projects: ids("project"), employees: ids("employee") } };
}

async function main(argv: string[]): Promise<number> {
  const apply = argv.includes("--apply");
  const includeUnknown = argv.includes("--include-unknown");
  const dbAt = argv.indexOf("--db");
  const dbPath =
    dbAt >= 0 ? argv[dbAt + 1] : join(process.env.I_INC_HOME ?? join(homedir(), ".i-inc"), "i-inc.db");
  const logPath = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--db");
  if (!logPath || !dbPath) {
    console.error(
      "usage: backfill-dropped-follow-ups.ts <daemon.log> [--db <path>] [--apply] [--include-unknown]",
    );
    return 2;
  }
  const found = parseDroppedFollowUps(readFileSync(logPath, "utf8"));
  console.log(`${found.length} dropped follow-ups in ${logPath}`);
  // A dry run never writes: it doesn't create the database or its table, only looks.
  const db = apply || existsSync(dbPath) ? await openDb(dbPath) : null;
  try {
    let proposals: Proposals | null = null;
    if (db && apply) {
      migrate(db);
      proposals = new Proposals(db);
    }
    const context = db ? readExisting(db) : { existing: [], known: null };
    if (!context.known)
      console.log("warning: no daemon database to check project and employee names against");
    const result = backfill(found, proposals, Date.now(), { ...context, includeUnknown });
    for (const f of result.stored) {
      console.log(
        `${apply ? "stored" : "would store"}: [${f.project}] "${f.title}" from ${f.proposedBy} (line ${f.line})`,
      );
    }
    for (const f of result.skipped) {
      console.log(`skipped (already a proposal or a ticket): [${f.project}] "${f.title}" (line ${f.line})`);
    }
    for (const f of result.unknown) {
      console.log(
        `warning: skipped, unknown project or employee: [${f.project}] "${f.title}" from ${f.proposedBy} (line ${f.line}); --include-unknown stores it anyway`,
      );
    }
    const tail = `${result.skipped.length} skipped, ${result.unknown.length} unknown`;
    console.log(
      apply
        ? `stored ${result.stored.length}, ${tail}`
        : `dry run: ${result.stored.length} would be stored, ${tail}; pass --apply to write`,
    );
  } finally {
    db?.close();
  }
  return 0;
}

if (typeof Bun !== "undefined" && import.meta.main) process.exit(await main(process.argv.slice(2)));
