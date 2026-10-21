// CI status from GitHub's public REST API: no credentials (the repo is public). Unauthenticated
// callers get 60 requests an hour, so every answer is kept with its ETag and asked again with
// If-None-Match (a 304 doesn't count against the limit), and a 403/429 backs off until the limit
// resets (or exponentially when GitHub doesn't say).
import type { Ci, CiResult, Clock } from "./types.ts";

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GitHubCiOptions {
  /** "owner/name" */
  repo: string;
  /** The check run that means "CI is green": the workflow job's name. */
  checkName: string;
  clock: Clock;
  fetch?: typeof fetch;
}

export class GitHubCi implements Ci {
  private readonly cache = new Map<string, { etag: string; result: CiResult }>();
  private backoffUntil = 0;
  private strikes = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: GitHubCiOptions) {
    this.fetchImpl = o.fetch ?? fetch;
  }

  async check(sha: string): Promise<CiResult> {
    const now = this.o.clock.now();
    if (now < this.backoffUntil) return { state: "rate-limited", until: this.backoffUntil };
    const cached = this.cache.get(sha);
    if (cached?.result.state === "success") return cached.result;
    let res: Response;
    try {
      res = await this.fetchImpl(
        `https://api.github.com/repos/${this.o.repo}/commits/${sha}/check-runs?per_page=100`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "i-inc-deployer",
            "x-github-api-version": "2022-11-28",
            ...(cached ? { "if-none-match": cached.etag } : {}),
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (err) {
      return { state: "error", reason: `GitHub unreachable: ${String(err)}` };
    }
    if (res.status === 403 || res.status === 429) {
      const until = this.limitedUntil(res, now);
      this.backoffUntil = until;
      return { state: "rate-limited", until };
    }
    if (res.status === 304 && cached) {
      this.strikes = 0;
      return cached.result;
    }
    if (!res.ok) return { state: "error", reason: `GitHub answered ${res.status}` };
    this.strikes = 0;
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(reset) && reset > 0) this.backoffUntil = reset * 1000;
    }
    const body = (await res.json().catch(() => null)) as { check_runs?: CheckRun[] } | null;
    const result = this.decide(body?.check_runs ?? []);
    const etag = res.headers.get("etag");
    if (etag) this.cache.set(sha, { etag, result });
    return result;
  }

  private decide(runs: CheckRun[]): CiResult {
    const mine = runs.filter((r) => r.name === this.o.checkName).sort((a, b) => b.id - a.id);
    const latest = mine[0]; // a re-run has a higher id
    if (!latest) return { state: "pending", reason: `no "${this.o.checkName}" check run yet` };
    if (latest.status !== "completed") return { state: "pending", reason: `check is ${latest.status}` };
    if (latest.conclusion === "success") return { state: "success" };
    return {
      state: "failure",
      reason: `CI check "${latest.name}" ${latest.conclusion ?? "did not succeed"}`,
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
}
