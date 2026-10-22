#!/usr/bin/env node
// `brain`: search and read the copy of the brain that i.inc keeps in this folder (docs/design/brain.md).
// It is shipped with every snapshot as <copy>/.bin/brain and needs only the Node the sandbox image has
// (node:sqlite, FTS5): the pages are read from the files, indexed in memory for the call, and ranked by
// BM25 with the same weights, query reduction and scope boost the daemon uses. Edited files are
// searched as edited. Plain CommonJS on purpose, so it runs from a file with no extension.
//
//   brain search <words> [--scope company|team|personal|<folder>] [--limit N] [--json]
//   brain map [folder]          the INDEX.md map of a folder (all of them when none is named)
//   brain read <folder/slug>    a page
//   brain list [folder]         the pages
//   brain status                what you changed in the copy (git status)
"use strict";

// node:sqlite still prints an ExperimentalWarning in some Node versions; this command's output is read by an
// agent, so the warning (stderr) is not wanted. (The shebang is a plain `env node`: no `env -S` needed.)
process.removeAllListeners("warning");

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const weights = [5, 3, 2, 1]; // title, description, tags, body
const boost = { personal: 1.5, team: 1.2, company: 1 };

// ---- The query (the same words dropped, the same OR of quoted words as the daemon's buildQuery) ------

const stopWords = new Set(
  `a about above after again all also am an and any are as at be because been before being below
  between both but by can could did do does doing down during each few for from further had has have
  having he her here hers him his how i if in into is it its itself just let me more most my no nor
  not now of off on once only or other our out over own same she should so some such than that the
  their them then there these they this those through to too under until up us very was we were what
  when where which while who whom why will with would you your yours`
    .split(/\s+/)
    .filter(Boolean),
);

function buildQuery(text, o = {}) {
  const maxTerms = o.maxTerms ?? 24;
  const limit = o.maxScan ?? 65536;
  const scan = text.length > limit ? text.slice(0, limit) : text;
  const seen = new Map();
  const stops = new Map();
  let at = 0;
  for (const m of scan.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    at++;
    if (w.length < 2 || w.length > 32) continue;
    if (/^\d+$/.test(w) && w.length > 6) continue;
    if (/^[0-9a-f]{12,}$/.test(w)) continue;
    const into = stopWords.has(w) ? stops : seen;
    const hit = into.get(w);
    if (hit) hit.n++;
    else into.set(w, { n: 1, at });
  }
  const terms = seen.size ? seen : stops;
  return [...terms.entries()]
    .sort(([, a], [, b]) => Math.min(b.n, 3) - Math.min(a.n, 3) || a.at - b.at)
    .slice(0, maxTerms)
    .map(([w]) => `"${w}"`)
    .join(" OR ");
}

// ---- Reading the pages -----------------------------------------------------------------------------

function listFolders() {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && (e.name === "company" || e.name === "personal" || /^team-/.test(e.name)),
    )
    .map((e) => e.name)
    .sort();
}

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(dir, r, out);
    else if (e.isFile() && e.name.endsWith(".md") && r !== "INDEX.md") out.push(r);
  }
}

const unquote = (v) => v.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");

function parsePage(text, slug) {
  const front = {};
  let body = text.replace(/^﻿/, "");
  const m = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (m) {
    body = body.slice(m[0].length);
    let list = null;
    for (const line of m[1].split(/\r?\n/)) {
      const item = list && line.match(/^\s*-\s+(.*)$/);
      if (item) {
        list.push(unquote(item[1]));
        continue;
      }
      const kv = line.match(/^([A-Za-z][\w-]*):(?:\s+(.*))?$/);
      if (!kv) continue;
      const v = (kv[2] || "").trim();
      list = null;
      if (v === "") front[kv[1]] = list = [];
      else if (v.startsWith("[") && v.endsWith("]")) {
        front[kv[1]] = v.slice(1, -1).split(",").map(unquote).filter(Boolean);
      } else front[kv[1]] = unquote(v);
    }
  }
  const heading = body.match(/^#{1,6}\s+(.+?)\s*#*\s*$/m);
  const title = (typeof front.title === "string" && front.title) || heading?.[1] || slug.split("/").pop();
  const first = body
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split("\n")
        .filter((l) => l.trim() && !/^\s*#{1,6}\s/.test(l))
        .join(" ")
        .trim(),
    )
    .find(Boolean);
  const description =
    (typeof front.description === "string" && front.description) ||
    (first || "").split(/(?<=[.!?])\s/)[0].slice(0, 160);
  const tags = Array.isArray(front.tags)
    ? front.tags
    : typeof front.tags === "string"
      ? front.tags.split(",")
      : [];
  return { title, description, tags: tags.map((t) => String(t).trim().toLowerCase()), body };
}

function load(onlyFolder) {
  const pages = [];
  for (const folder of onlyFolder ? [onlyFolder] : listFolders()) {
    const files = [];
    try {
      walk(path.join(root, folder), "", files);
    } catch {
      continue;
    }
    for (const f of files) {
      const slug = f.slice(0, -3);
      let text;
      try {
        text = fs.readFileSync(path.join(root, folder, f), "utf8");
      } catch {
        continue;
      }
      pages.push({ folder, slug, ...parsePage(text, slug) });
    }
  }
  return pages;
}

function search(query, o = {}) {
  const match = buildQuery(query);
  if (!match) return [];
  const folders = o.scope ? [folderOf(o.scope)] : undefined;
  const pages = [];
  for (const f of folders ?? listFolders()) pages.push(...load(f));
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE f USING fts5(title, description, tags, body, tokenize = 'porter unicode61')");
  const put = db.prepare("INSERT INTO f (rowid, title, description, tags, body) VALUES (?, ?, ?, ?, ?)");
  for (const [i, p] of pages.entries()) put.run(i + 1, p.title, p.description, p.tags.join(" "), p.body);
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT rowid AS id, bm25(f, ${weights.join(", ")}) AS rank, snippet(f, -1, '', '', '…', 20) AS snippet
         FROM f WHERE f MATCH ? ORDER BY rank LIMIT 100`,
      )
      .all(match);
  } catch {
    rows = [];
  }
  db.close();
  return rows
    .map((r) => {
      const p = pages[r.id - 1];
      const kind = p.folder === "company" ? "company" : p.folder === "personal" ? "personal" : "team";
      return {
        folder: p.folder,
        slug: p.slug,
        title: p.title,
        description: p.description,
        score: -r.rank * boost[kind],
        snippet: r.snippet,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, o.limit ?? 10);
}

function folderOf(scope) {
  if (scope === "team") {
    const t = listFolders().filter((f) => f.startsWith("team-"));
    return t[0] || "team-";
  }
  return scope;
}

// ---- Commands --------------------------------------------------------------------------------------

function main(argv) {
  const [cmd = "help", ...rest] = argv;
  const flags = {};
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") flags.json = true;
    else if (a === "--scope" || a === "--limit") flags[a.slice(2)] = rest[++i];
    else words.push(a);
  }
  if (cmd === "search") {
    const results = search(words.join(" "), {
      ...(flags.scope ? { scope: flags.scope } : {}),
      limit: Math.max(1, Math.min(50, Number(flags.limit) || 10)),
    });
    if (flags.json) return console.log(JSON.stringify(results, null, 2));
    if (!results.length) return console.log("No pages matched.");
    for (const r of results) {
      console.log(
        `${r.folder}/${r.slug}  ${r.score.toFixed(2)}\n  ${r.title}${r.description ? ` — ${r.description}` : ""}`,
      );
      if (r.snippet) console.log(`  …${r.snippet.replace(/\s+/g, " ")}`);
    }
    return undefined;
  }
  if (cmd === "map") {
    for (const f of words[0] ? [words[0].replace(/\/+$/, "")] : listFolders()) {
      try {
        process.stdout.write(`# ${f}\n${fs.readFileSync(path.join(root, f, "INDEX.md"), "utf8")}\n`);
      } catch {
        console.error(`no map for ${f}`);
        process.exitCode = 1;
      }
    }
    return undefined;
  }
  if (cmd === "read") {
    const target = (words[0] || "").replace(/\.md$/, "");
    const file = path.resolve(root, `${target}.md`);
    if (!target || !file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file)) {
      console.error(`no such page: ${target || "(none given)"}`);
      process.exitCode = 1;
      return undefined;
    }
    return process.stdout.write(fs.readFileSync(file, "utf8"));
  }
  if (cmd === "list") {
    for (const p of load(words[0] ? words[0].replace(/\/+$/, "") : undefined)) {
      console.log(`${p.folder}/${p.slug}  ${p.title}`);
    }
    return undefined;
  }
  if (cmd === "status") {
    const r = require("node:child_process").spawnSync("git", ["-C", root, "status", "--short"], {
      encoding: "utf8",
    });
    process.stdout.write(r.stdout || "no changes\n");
    return undefined;
  }
  console.log(
    [
      "brain: the copy of i.inc's brain in this folder",
      "  brain search <words> [--scope company|team|personal] [--limit N] [--json]",
      "  brain map [folder]        brain read <folder/slug>",
      "  brain list [folder]       brain status",
    ].join("\n"),
  );
  return undefined;
}

if (require.main === module) main(process.argv.slice(2));
else module.exports = { buildQuery, parsePage, search, load, main, weights, boost };
