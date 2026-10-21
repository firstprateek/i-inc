// Opt-in benchmarks for the brain index (docs/design/brain.md). Wall-clock numbers don't belong in
// the test suite, because they depend on the machine's load, so they live here:
//
//   pnpm --filter @i-inc/daemon bench      (or: pnpm bench, from the repo root)
//
// It builds throwaway git repos in the OS temp directory, prints each timing and exits 1 if one is over
// its budget. Run it on an otherwise idle machine.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildQuery, parsePage, retrieve } from "@i-inc/core";
import { BrainIndex } from "../src/brain-index.ts";
import { KnowledgeStore } from "../src/knowledge.ts";

const root = mkdtempSync(join(tmpdir(), "i-inc-brain-bench-"));
let failed = false;
const report = (name: string, ms: number, budget: number) => {
  const ok = ms <= budget;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "SLOW"} ${name}: ${ms.toFixed(1)} ms (budget ${budget} ms)`);
};
const time = <T>(fn: () => T): [T, number] => {
  const t = performance.now();
  const out = fn();
  return [out, performance.now() - t];
};

const page = (title: string, description: string, body: string, tags: string[] = []) =>
  `---\ntitle: ${title}\ndescription: ${description}\ntags: [${tags.join(", ")}]\nupdated: 2026-10-01\nsources: []\n---\n${body}\n`;

async function repoWith(name: string, n: number, folders: string[]) {
  const dir = join(root, name);
  const store = new KnowledgeStore(dir);
  store.ensureHandbook();
  store.ensureBrain({ id: "ada", name: "Ada", role: "Engineer" });
  const words =
    "alpha beta gamma delta epsilon zeta theta iota kappa lambda sigma omega release deploy test build review".split(
      " ",
    );
  const hb = join(dir, "handbook");
  for (let i = 0; i < n; i++) {
    const path = join(hb, `${folders[i % folders.length]}/page-${i}.md`);
    mkdirSync(dirname(path), { recursive: true });
    const body = Array.from({ length: 120 }, (_, j) => words[(i * 7 + j * 3) % words.length]).join(" ");
    writeFileSync(
      path,
      page(
        `Page ${i} ${words[i % words.length]}`,
        `About ${words[i % 17]} things`,
        `${body} [[page-${(i + 1) % n}]]`,
        [words[i % 5] ?? "x"],
      ),
    );
  }
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=b", "-c", "user.email=b@b", "-c", "commit.gpgsign=false", ...a], {
      cwd: hb,
      stdio: "pipe",
    });
  git("add", "-A");
  git("commit", "-q", "-m", "bulk");
  return { store, index: await BrainIndex.open(":memory:", store) };
}

try {
  // 1,000 pages: rebuild under 3 s, a retrieval under 20 ms.
  {
    const { index } = await repoWith("k1", 1000, ["facts"]);
    const [, rebuild] = time(() => index.rebuild());
    report("rebuild, 1,000 pages", rebuild, 3000);
    const q = "how do we release and deploy the review build for kappa";
    retrieve(index, { query: q, scopes: ["brain:ada", "company"] });
    const runs = Array.from(
      { length: 30 },
      () => time(() => retrieve(index, { query: q, scopes: ["brain:ada", "company"] }))[1],
    );
    runs.sort((a, b) => a - b);
    report("retrieve, 1,000 pages (median of 30)", runs[15] ?? 0, 20);
    console.log(`     slowest of 30: ${(runs.at(-1) ?? 0).toFixed(1)} ms`);
  }
  // 100 KB of hostile query text: under 50 ms to build the query.
  for (const [label, text] of [
    ["FTS syntax", '"(*^:NEAR('.repeat(15_000)],
    ["one long word", "a".repeat(100_000)],
    ["20,000 words", Array.from({ length: 20_000 }, (_, i) => `w${i}x`).join(" ")],
  ] as const) {
    report(`buildQuery, 100 KB ${label}`, time(() => buildQuery(text))[1], 50);
  }
  // A YAML alias bomb in frontmatter.
  {
    const bomb = `---\na: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\n---\nx`;
    report("parsePage, YAML alias bomb", time(() => parsePage(bomb, "x"))[1], 500);
  }
  // 10,000 pages: the map builds in under 30 ms, and a second call is a cache hit.
  {
    const { index } = await repoWith("k10", 10_000, ["facts", "policies", "projects"]);
    index.rebuild();
    report("mapFor, 10,000 pages (cold)", time(() => index.mapFor("company"))[1], 30);
    report("mapFor, 10,000 pages (cached)", time(() => index.mapFor("company"))[1], 1);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
