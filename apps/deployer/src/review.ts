// The deployer's guard (T68): main is deployed onto the host, so host code deploys only with the owner's approval
// or from a pull request the owner merged. For every commit in `git rev-list <current>..<candidate>`:
//   - a commit that changes only documents (paths.ts: `docs/**/*.md` and top-level `*.md`, not agent instruction
//     files) is fine: nothing runs it;
//   - any other commit must be (a) in the daemon's ledger of what it pushed to main WITH `ownerApproved` (the owner
//     tapped OK on the change in the app; a plain ledgered commit is not enough, because the pipeline's checks and
//     review run where the builder does) or made by the host to revert one (`hostRevert`); or (b) a commit of a
//     pull request into the branch whose `merged_by` is the repo's owner: the squash or merge commit
//     (`merge_commit_sha`), or one of the PR's own commits (GET /pulls/{n}/commits, the merge-commit method).
// Anything else is somebody pushing around the owner. The caller skips the candidate: never marks it bad, never
// rolls back, and looks again when main moves. GitHub is asked without credentials unless a read-only token is
// given (I_INC_GITHUB_TOKEN); a rate limit is waited out, never answered by deploying. Verdicts by pull request are
// kept on disk, so a restart doesn't ask again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isHostExecuted } from "./paths.ts";
import type { Clock, Remote, Review, ReviewResult } from "./types.ts";

/** The most commits looked at in one candidate; a bigger jump is for the owner (`--once --sha`). */
export const MAX_RANGE = 90;

export interface LedgerReviewOptions {
  /** "owner/name" */
  repo: string;
  /** The branch that is deployed. */
  branch?: string;
  /** ~/.i-inc/pushed-main.jsonl */
  ledgerPath: string;
  remote: Pick<Remote, "range" | "changedFiles">;
  clock: Clock;
  fetch?: typeof fetch;
  /** A read-only GitHub token, if the host has one: calls are then authenticated and rate limits are far roomier. */
  token?: () => string | undefined;
  /** Where commits found reviewed by a pull request are kept (they never change). */
  cachePath?: string;
}

interface PullSummary {
  number: number;
  merged_at: string | null;
  base?: { ref?: string };
}

interface PullDetail {
  merged_by?: { login?: unknown } | null;
  merge_commit_sha?: unknown;
}

interface LedgerEntry {
  /** The owner approved the change in the app, or the host made it to revert one. */
  approved: boolean;
}

export class LedgerReview implements Review {
  private readonly f: typeof fetch;
  private readonly branch: string;
  private readonly owner: string;
  private readonly repoLower: string;
  /** Commits already found reviewed by a pull request (that never changes), by sha. */
  private readonly viaPr = new Set<string>();
  private loaded = false;
  /** Merged pull requests' mergers and merge commits, by number. */
  private readonly details = new Map<number, { merger: string | null; mergeSha: string | null }>();
  /** The commits of a pull request, by number. */
  private readonly prCommits = new Map<number, Set<string>>();
  private backoffUntil = 0;
  private strikes = 0;

  constructor(private readonly o: LedgerReviewOptions) {
    this.f = o.fetch ?? fetch;
    this.branch = o.branch ?? "main";
    this.owner = o.repo.split("/")[0]?.toLowerCase() ?? "";
    this.repoLower = o.repo.toLowerCase();
  }

  private loadCache(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.o.cachePath || !existsSync(this.o.cachePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.o.cachePath, "utf8")) as { reviewed?: unknown };
      if (Array.isArray(raw.reviewed)) {
        for (const s of raw.reviewed)
          if (typeof s === "string" && /^[0-9a-f]{40}$/.test(s)) this.viaPr.add(s);
      }
    } catch {
      // a damaged cache is just empty
    }
  }

  private remember(sha: string): void {
    this.viaPr.add(sha);
    if (!this.o.cachePath) return;
    try {
      mkdirSync(dirname(this.o.cachePath), { recursive: true });
      writeFileSync(this.o.cachePath, JSON.stringify({ reviewed: [...this.viaPr].slice(-5000) }));
    } catch {
      // asked again next time
    }
  }

  /** The commits the daemon says it pushed to this repo's branch. Missing or damaged lines count for nothing. */
  private ledger(): Map<string, LedgerEntry> {
    const out = new Map<string, LedgerEntry>();
    if (!existsSync(this.o.ledgerPath)) return out;
    let text = "";
    try {
      text = readFileSync(this.o.ledgerPath, "utf8");
    } catch {
      return out;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as {
          sha?: unknown;
          repo?: unknown;
          branch?: unknown;
          ownerApproved?: unknown;
          hostRevert?: unknown;
        };
        if (
          typeof e.sha === "string" &&
          /^[0-9a-f]{40}$/.test(e.sha) &&
          typeof e.repo === "string" &&
          e.repo.toLowerCase() === this.repoLower &&
          e.branch === this.branch
        ) {
          const approved = e.ownerApproved === true || typeof e.hostRevert === "string";
          // A commit pushed twice is approved if either push was.
          out.set(e.sha, { approved: approved || out.get(e.sha)?.approved === true });
        }
      } catch {
        // a damaged line
      }
    }
    return out;
  }

  async check(current: string, candidate: string): Promise<ReviewResult> {
    this.loadCache();
    const range = await this.o.remote.range(current, candidate, MAX_RANGE).catch(() => null);
    if (!range) return { state: "error", reason: "could not list the commits between the release and main" };
    if (range.truncated) {
      return {
        state: "unreviewed",
        shas: [],
        reason: `more than ${MAX_RANGE} new commits to check; the owner deploys this one with --once --sha`,
      };
    }
    const ledger = this.ledger();
    const stray: string[] = [];
    for (const sha of range.shas) {
      if (this.viaPr.has(sha)) continue;
      // Cheapest first: what git says, then the ledger, then GitHub.
      const files = await this.o.remote.changedFiles(sha, current).catch(() => null);
      if (files === null) return { state: "error", reason: `could not read what ${sha.slice(0, 7)} changes` };
      if (!files.some(isHostExecuted)) continue;
      if (ledger.get(sha)?.approved === true) continue;
      const pr = await this.ownerMerged(sha);
      if (pr.state === "yes") {
        this.remember(sha);
        continue;
      }
      if (pr.state === "rate-limited" || pr.state === "error") return pr;
      stray.push(sha);
    }
    if (stray.length === 0) return { state: "ok" };
    return {
      state: "unreviewed",
      shas: stray,
      reason: `${stray.map((s) => s.slice(0, 7)).join(", ")} ${stray.length === 1 ? "changes" : "change"} code the host runs without the owner's approval or a pull request the owner merged`,
    };
  }

  private headers(): Record<string, string> {
    const token = this.o.token?.();
    return {
      accept: "application/vnd.github+json",
      "user-agent": "i-inc-deployer",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  private limitedUntil(res: Response, now: number): number {
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000;
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (res.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
      return Math.max(reset * 1000, now + 1000);
    }
    this.strikes += 1;
    return now + Math.min(30 * 60_000, 60_000 * 2 ** (this.strikes - 1));
  }

  /** GET json from GitHub, or what went wrong. */
  private async get(
    path: string,
  ): Promise<
    | { ok: true; status: number; body: unknown }
    | { ok: false; result: Extract<ReviewResult, { state: "rate-limited" | "error" }> }
  > {
    const now = this.o.clock.now();
    if (now < this.backoffUntil)
      return { ok: false, result: { state: "rate-limited", until: this.backoffUntil } };
    let res: Response;
    try {
      res = await this.f(`https://api.github.com/repos/${this.o.repo}/${path}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { ok: false, result: { state: "error", reason: `GitHub unreachable: ${String(err)}` } };
    }
    if (res.status === 403 || res.status === 429) {
      const until = this.limitedUntil(res, now);
      this.backoffUntil = until;
      return { ok: false, result: { state: "rate-limited", until } };
    }
    if (res.status === 404 || res.status === 422) return { ok: true, status: res.status, body: null };
    if (!res.ok) return { ok: false, result: { state: "error", reason: `GitHub answered ${res.status}` } };
    this.strikes = 0;
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(reset) && reset > 0) this.backoffUntil = reset * 1000;
    }
    return { ok: true, status: res.status, body: await res.json().catch(() => null) };
  }

  /** The commits of a pull request (up to 300), as a set. */
  private async commitsOf(
    number: number,
  ): Promise<
    | { ok: true; shas: Set<string> }
    | { ok: false; result: Extract<ReviewResult, { state: "rate-limited" | "error" }> }
  > {
    const known = this.prCommits.get(number);
    if (known) return { ok: true, shas: known };
    const shas = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      const r = await this.get(`pulls/${number}/commits?per_page=100&page=${page}`);
      if (!r.ok) return r;
      const list = (Array.isArray(r.body) ? r.body : []) as { sha?: unknown }[];
      for (const c of list) if (typeof c.sha === "string") shas.add(c.sha);
      if (list.length < 100) break;
    }
    this.prCommits.set(number, shas);
    return { ok: true, shas };
  }

  /**
   * Is this commit the squash or merge commit of a pull request into the branch that its owner merged, or one of
   * that pull request's own commits?
   */
  private async ownerMerged(
    sha: string,
  ): Promise<
    { state: "yes" } | { state: "no" } | Extract<ReviewResult, { state: "rate-limited" | "error" }>
  > {
    const list = await this.get(`commits/${sha}/pulls?per_page=30`);
    if (!list.ok) return list.result;
    const pulls = (Array.isArray(list.body) ? list.body : []) as PullSummary[];
    for (const p of pulls) {
      if (typeof p.number !== "number" || !p.merged_at || p.base?.ref !== this.branch) continue;
      let d = this.details.get(p.number);
      if (!d) {
        const one = await this.get(`pulls/${p.number}`);
        if (!one.ok) return one.result;
        if (!one.body) continue;
        const body = one.body as PullDetail;
        const by = body.merged_by?.login;
        d = {
          merger: typeof by === "string" ? by.toLowerCase() : null,
          mergeSha: typeof body.merge_commit_sha === "string" ? body.merge_commit_sha : null,
        };
        this.details.set(p.number, d);
      }
      // Merged by the owner, not by the bot or anybody else.
      if (d.merger === null || d.merger !== this.owner) continue;
      if (d.mergeSha === sha) return { state: "yes" };
      const own = await this.commitsOf(p.number);
      if (!own.ok) return own.result;
      if (own.shas.has(sha)) return { state: "yes" };
    }
    return { state: "no" };
  }
}
