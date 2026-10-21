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
import { openDb } from "../src/db.ts";
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
  skipped: DroppedFollowUp[];
}

/**
 * Stores the parsed follow-ups as open proposals. With no `proposals` nothing is written: it only
 * works out which would be stored, given the `existing` open ones.
 */
export function backfill(
  found: DroppedFollowUp[],
  proposals: Proposals | null,
  now: number,
  existing: { project: string; title: string }[] = [],
): BackfillResult {
  const result: BackfillResult = { stored: [], skipped: [] };
  const seen = new Set(existing.map((e) => `${e.project}\n${normalTitle(e.title)}`));
  for (const f of found) {
    const key = `${f.project}\n${normalTitle(f.title)}`;
    let isNew = !seen.has(key);
    if (isNew && proposals) {
      isNew =
        proposals.add(
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
        ) !== undefined;
    }
    seen.add(key);
    (isNew ? result.stored : result.skipped).push(f);
  }
  return result;
}

async function main(argv: string[]): Promise<number> {
  const apply = argv.includes("--apply");
  const dbAt = argv.indexOf("--db");
  const dbPath =
    dbAt >= 0 ? argv[dbAt + 1] : join(process.env.I_INC_HOME ?? join(homedir(), ".i-inc"), "i-inc.db");
  const logPath = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--db");
  if (!logPath || !dbPath) {
    console.error("usage: backfill-dropped-follow-ups.ts <daemon.log> [--db <path>] [--apply]");
    return 2;
  }
  const found = parseDroppedFollowUps(readFileSync(logPath, "utf8"));
  console.log(`${found.length} dropped follow-ups in ${logPath}`);
  // A dry run never writes: it doesn't create the database or its table, only looks.
  let existing: { project: string; title: string }[] = [];
  let proposals: Proposals | null = null;
  const db = apply || existsSync(dbPath) ? await openDb(dbPath) : null;
  try {
    if (db && apply) {
      migrate(db);
      proposals = new Proposals(db);
    }
    if (db?.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'proposals'").length) {
      existing = new Proposals(db).list("open");
    }
    const result = backfill(found, proposals, Date.now(), existing);
    for (const f of result.stored) {
      console.log(
        `${apply ? "stored" : "would store"}: [${f.project}] "${f.title}" from ${f.proposedBy} (line ${f.line})`,
      );
    }
    for (const f of result.skipped) {
      console.log(`skipped (already an open proposal): [${f.project}] "${f.title}" (line ${f.line})`);
    }
    console.log(
      apply
        ? `stored ${result.stored.length}, skipped ${result.skipped.length}`
        : `dry run: ${result.stored.length} would be stored, ${result.skipped.length} skipped; pass --apply to write`,
    );
  } finally {
    db?.close();
  }
  return 0;
}

if (typeof Bun !== "undefined" && import.meta.main) process.exit(await main(process.argv.slice(2)));
