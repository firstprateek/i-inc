// GitHub for i.inc (spec §5 and §6): the bot identity. The GitHub App "i.inc" mints a 1-hour
// installation token per session, limited to the ticket's repo, so pushes and draft PRs come from the
// bot and never from the owner. A ruleset on main means only the owner merges. Setting it up:
// docs/github-app.md. Until the App exists, a fine-grained token (M1 step 6) can stand in.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, readOwnerOnly } from "./config.ts";

/** Where a session's GitHub token comes from. `repo` is "owner/name". */
export interface TokenSource {
  /**
   * "read" for a reviewer or verifier, who checks the branch out but never pushes. `repo` "*" asks
   * for every repo the App is installed on: a team sandbox's shared sign-in.
   */
  token(repo: string, access?: "write" | "read"): Promise<string>;
}

/** A session can run for most of an hour, so it gets a token with at least this long left. */
const minLeftMs = 50 * 60_000;

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  /** Its public name in URLs, `i-inc-bot`, which the bot's commit address needs. */
  slug?: string;
  /** On the mini: ~/.config/i-inc/github-app.pem, readable only by the owner. Never in the repo. */
  privateKeyPath: string;
  api?: string;
}

/** Reads `github-app.json` ({appId, installationId, slug}); the key sits next to it. */
export function readGitHubAppConfig(dir = configDir()): GitHubAppConfig {
  const raw = JSON.parse(readFileSync(join(dir, "github-app.json"), "utf8")) as Record<string, unknown>;
  const id = (key: string) => {
    const value = String(raw[key] ?? "");
    if (!/^\d+$/.test(value)) throw new Error(`github-app.json needs ${key}, a number`);
    return value;
  };
  return {
    appId: id("appId"),
    installationId: id("installationId"),
    slug: typeof raw.slug === "string" ? raw.slug : "i-inc-bot",
    privateKeyPath: join(dir, "github-app.pem"),
  };
}

export interface GitHubDeps {
  fetch?: typeof fetch;
  now?: () => number;
  readKey?: (path: string) => string;
}

const API = "https://api.github.com";
const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** A JWT for the App itself, signed with its private key (RS256), good for 9 minutes. */
export function appJwt(appId: string, privateKey: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  // Backdated a minute, as GitHub suggests, in case the clocks disagree.
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Reads the App's key, refusing one that anyone but its owner can read. */
export const readPrivateKey = readOwnerOnly;

async function call(f: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await f(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "i-inc",
      ...init.headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw new Error(
      `GitHub ${init.method ?? "GET"} ${url} failed: ${res.status} ${body.message ?? ""}`.trim(),
    );
  return body;
}

/** Checks "owner/name" before it goes into a URL. */
const checkRepo = (repo: string) => {
  if (!/^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`not a repo: ${repo}`);
  return repo;
};

/** Installation tokens from the App: one per repo, reused until five minutes before it expires. */
export class GitHubApp implements TokenSource {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly readKey: (path: string) => string;

  constructor(
    private readonly config: GitHubAppConfig,
    deps: GitHubDeps = {},
  ) {
    this.f = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.readKey = deps.readKey ?? readPrivateKey;
  }

  async token(repo: string, access: "write" | "read" = "write"): Promise<string> {
    const key = `${repo} ${access}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.now() > minLeftMs) return cached.token;
    const jwt = appJwt(this.config.appId, this.readKey(this.config.privateKeyPath), this.now());
    const body = await call(
      this.f,
      `${this.config.api ?? API}/app/installations/${this.config.installationId}/access_tokens`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
        // Only the ticket's repo: with whatever the App was granted there, or read-only.
        body: JSON.stringify({
          ...(repo === "*" ? {} : { repositories: [checkRepo(repo).split("/")[1]] }),
          ...(access === "read"
            ? { permissions: { contents: "read", pull_requests: "read", metadata: "read", checks: "read" } }
            : {}),
        }),
      },
    );
    if (typeof body.token !== "string") throw new Error("GitHub sent no installation token");
    const token = body.token;
    this.cache.set(key, { token, expiresAt: Date.parse(String(body.expires_at)) });
    return token;
  }
}

/** A fine-grained token that can push and open PRs on the owner's repos, until the App exists. */
export class FineGrainedToken implements TokenSource {
  constructor(private readonly value: string) {}
  async token(): Promise<string> {
    return this.value;
  }
}

export interface DraftPr {
  number: number;
  url: string;
  nodeId: string;
}

/** The pull requests an employee's work goes through, opened and updated as the bot. */
export class PullRequests {
  private readonly f: typeof fetch;
  private readonly api: string;

  constructor(
    private readonly tokens: TokenSource,
    deps: GitHubDeps & { api?: string } = {},
  ) {
    this.f = deps.fetch ?? fetch;
    this.api = deps.api ?? API;
  }

  private async auth(repo: string) {
    return { authorization: `Bearer ${await this.tokens.token(repo)}` };
  }

  /** Stage 1 opens the PR as a draft, so CI runs from the start (spec §6). */
  async openDraft(
    repo: string,
    pr: { head: string; base: string; title: string; body: string },
  ): Promise<DraftPr> {
    const body = await call(this.f, `${this.api}/repos/${checkRepo(repo)}/pulls`, {
      method: "POST",
      headers: await this.auth(repo),
      body: JSON.stringify({ ...pr, draft: true }),
    });
    return { number: Number(body.number), url: String(body.html_url), nodeId: String(body.node_id) };
  }

  /** The open PR for a branch, if there is one: pick-up after a crash finds the PR it opened. */
  async find(repo: string, branch: string): Promise<DraftPr | null> {
    const owner = checkRepo(repo).split("/")[0] ?? "";
    const head = encodeURIComponent(`${owner}:${branch}`);
    const list = (await call(this.f, `${this.api}/repos/${repo}/pulls?head=${head}&state=open`, {
      method: "GET",
      headers: await this.auth(repo),
    })) as unknown as Record<string, unknown>[];
    const [pr] = Array.isArray(list) ? list : [];
    return pr ? { number: Number(pr.number), url: String(pr.html_url), nodeId: String(pr.node_id) } : null;
  }

  async isDraft(repo: string, number: number): Promise<boolean> {
    const pr = await call(this.f, `${this.api}/repos/${checkRepo(repo)}/pulls/${number}`, {
      method: "GET",
      headers: await this.auth(repo),
    });
    return pr.draft === true;
  }

  /** Stage 9: the report becomes the PR body. */
  async setBody(repo: string, number: number, body: string): Promise<void> {
    await call(this.f, `${this.api}/repos/${checkRepo(repo)}/pulls/${number}`, {
      method: "PATCH",
      headers: await this.auth(repo),
      body: JSON.stringify({ body }),
    });
  }

  /** Stage 9: out of draft, ready for the owner. REST can't do this; GraphQL can. */
  async markReady(repo: string, nodeId: string): Promise<void> {
    const body = await call(this.f, `${this.api}/graphql`, {
      method: "POST",
      headers: await this.auth(repo),
      body: JSON.stringify({
        query:
          "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }",
        variables: { id: nodeId },
      }),
    });
    if (Array.isArray(body.errors) && body.errors.length) {
      throw new Error(`GitHub couldn't mark the PR ready: ${JSON.stringify(body.errors)}`);
    }
  }
}

export interface CiOptions {
  fetch?: typeof fetch;
  api?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long CI may take in all. */
  timeoutMs?: number;
  /** How long to wait for the first check to show up before deciding the repo has no CI. */
  graceMs?: number;
  pollMs?: number;
}

/**
 * Stage 8's "GitHub CI green" (spec §6). The checks `main`'s rules require must each have run on the
 * commit and passed; every other check run that showed up must have finished without failing. A
 * check that hasn't started yet has no run, so the required ones are what keep this from passing
 * early. A repo whose `main` requires no checks and whose commit gets no runs in the grace period
 * has no CI.
 */
export async function waitForCi(
  tokens: TokenSource,
  repo: string,
  sha: string,
  o: CiOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const f = o.fetch ?? fetch;
  const api = o.api ?? API;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`not a commit: ${sha}`);
  const get = async (url: string) =>
    call(f, url, { method: "GET", headers: { authorization: `Bearer ${await tokens.token(repo)}` } });

  const rules = (await get(`${api}/repos/${checkRepo(repo)}/rules/branches/main`)) as unknown;
  const required = (Array.isArray(rules) ? (rules as Record<string, unknown>[]) : [])
    .filter((r) => r.type === "required_status_checks")
    .flatMap(
      (r) =>
        ((r.parameters as Record<string, unknown>)?.required_status_checks ?? []) as { context: string }[],
    )
    .map((c) => c.context);

  // GitHub sometimes leaves `status: "in_progress"` on a check run that already has `conclusion` and
  // `completed_at` set (seen on Duet's Sorting service job). A run with a conclusion is finished.
  const finished = (r: Record<string, unknown>) =>
    r.status === "completed" || (typeof r.conclusion === "string" && r.conclusion.length > 0);
  const passed = (r: Record<string, unknown>) =>
    ["success", "neutral", "skipped"].includes(String(r.conclusion));
  const start = now();
  for (;;) {
    const runs: Record<string, unknown>[] = [];
    for (let page = 1; ; page++) {
      const body = await get(`${api}/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
      const batch = (Array.isArray(body.check_runs) ? body.check_runs : []) as Record<string, unknown>[];
      runs.push(...batch);
      if (batch.length < 100) break;
    }
    const failed = runs.filter((r) => finished(r) && !passed(r));
    if (failed.length) {
      return {
        ok: false,
        reason: `CI failed: ${failed.map((r) => `${r.name} (${r.conclusion})`).join(", ")}`,
      };
    }
    const waited = now() - start;
    const allDone = runs.every(finished);
    const requiredPassed = required.every((name) => runs.some((r) => r.name === name && passed(r)));
    if (required.length ? requiredPassed && allDone : runs.length > 0 && allDone) return { ok: true };
    if (!required.length && runs.length === 0 && waited >= (o.graceMs ?? 120_000)) return { ok: true };
    if (waited >= (o.timeoutMs ?? 45 * 60_000)) {
      const missing = required.filter((name) => !runs.some((r) => r.name === name && passed(r)));
      return {
        ok: false,
        reason: `CI didn't finish in time${missing.length ? `: waiting on ${missing.join(", ")}` : ""}`,
      };
    }
    await sleep(o.pollMs ?? 20_000);
  }
}

/**
 * The git identity for an employee's commits: its own name, with the bot's noreply address, so GitHub
 * shows them as the App's ("Ada (i.inc)"). The address needs the bot account's id.
 */
export async function commitIdentity(
  employeeName: string,
  appSlug: string,
  deps: GitHubDeps & { api?: string } = {},
): Promise<{ name: string; email: string }> {
  const url = `${deps.api ?? API}/users/${encodeURIComponent(`${appSlug}[bot]`)}`;
  const bot = await call(deps.fetch ?? fetch, url, { method: "GET" });
  return { name: `${employeeName} (i.inc)`, email: `${bot.id}+${appSlug}[bot]@users.noreply.github.com` };
}

export interface GitHubRepoSummary {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  empty: boolean;
  pushedAt: string | null;
  alreadyRegistered: boolean;
}

export interface GitHubInspectResult {
  id: string;
  repo: string;
  defaultBranch: string;
  empty: boolean;
  checks: string[];
  protectedPaths: string[];
  detected: string;
}

export interface BootstrapOptions {
  repo: string;
  template?: "ts-node" | "web" | "python" | "minimal";
  description?: string;
  defaultBranch?: string;
}

export interface BootstrapResult {
  bootstrapped: boolean;
  commits: number;
}

/** Lists all repositories accessible to the GitHub App installation. */
export async function listInstallationRepos(
  tokens: TokenSource,
  registeredRepos: string[] = [],
  deps: GitHubDeps & { api?: string } = {},
): Promise<GitHubRepoSummary[]> {
  const f = deps.fetch ?? fetch;
  const api = deps.api ?? API;
  const token = await tokens.token("*", "read");
  const registeredSet = new Set(registeredRepos.map((r) => r.toLowerCase()));

  const res = (await call(f, `${api}/installation/repositories?per_page=100`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  })) as { repositories?: Record<string, unknown>[] };

  const rawRepos = Array.isArray(res.repositories) ? res.repositories : [];
  return rawRepos.map((r) => {
    const fullName = String(r.full_name ?? "");
    const name = String(r.name ?? "");
    const owner = String((r.owner as Record<string, unknown>)?.login ?? fullName.split("/")[0] ?? "");
    const isPrivate = Boolean(r.private);
    const defaultBranch = String(r.default_branch ?? "main");
    const description = typeof r.description === "string" ? r.description : null;
    const language = typeof r.language === "string" ? r.language : null;
    const size = typeof r.size === "number" ? r.size : 0;
    const pushedAt = typeof r.pushed_at === "string" ? r.pushed_at : null;
    const empty = size === 0 || !pushedAt;
    const alreadyRegistered = registeredSet.has(fullName.toLowerCase());
    return {
      fullName,
      name,
      owner,
      private: isPrivate,
      defaultBranch,
      description,
      language,
      empty,
      pushedAt,
      alreadyRegistered,
    };
  });
}

/** Inspects a repository to detect language, build tools, check recipes, and default branch. */
export async function inspectRepo(
  tokens: TokenSource,
  owner: string,
  name: string,
  deps: GitHubDeps & { api?: string } = {},
): Promise<GitHubInspectResult> {
  const f = deps.fetch ?? fetch;
  const api = deps.api ?? API;
  const repo = `${owner}/${name}`;
  checkRepo(repo);
  const token = await tokens.token(repo, "read");
  const authHeader = { authorization: `Bearer ${token}` };

  const repoMeta = await call(f, `${api}/repos/${repo}`, {
    method: "GET",
    headers: authHeader,
  });
  const defaultBranch = String(repoMeta.default_branch ?? "main");
  const size = typeof repoMeta.size === "number" ? repoMeta.size : 0;
  const empty = size === 0 || !repoMeta.pushed_at;

  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  if (empty) {
    return {
      id,
      repo,
      defaultBranch,
      empty: true,
      checks: ["pnpm install --frozen-lockfile", "pnpm check", "pnpm test"],
      protectedPaths: ["package.json", "pnpm-lock.yaml"],
      detected: "empty",
    };
  }

  let contents: Record<string, unknown>[] = [];
  try {
    const list = await call(f, `${api}/repos/${repo}/contents`, {
      method: "GET",
      headers: authHeader,
    });
    contents = Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  } catch {
    // repo contents not accessible or directory is empty
  }

  const fileNames = new Set(contents.map((c) => String(c.name ?? "")));

  if (fileNames.has("package.json")) {
    const checks: string[] = [];
    const hasPnpmLock = fileNames.has("pnpm-lock.yaml");
    const hasYarnLock = fileNames.has("yarn.lock");
    const hasPackageLock = fileNames.has("package-lock.json");

    const installCmd = hasPnpmLock
      ? "pnpm install --frozen-lockfile"
      : hasYarnLock
        ? "yarn install --frozen-lockfile"
        : hasPackageLock
          ? "npm ci"
          : "pnpm install";

    checks.push(installCmd);

    try {
      const pkgFile = await call(f, `${api}/repos/${repo}/contents/package.json`, {
        method: "GET",
        headers: authHeader,
      });
      const content =
        typeof pkgFile.content === "string" ? Buffer.from(pkgFile.content, "base64").toString("utf8") : "";
      const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const runner = hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : "npm run";

      if (scripts.check) checks.push(`${runner} check`);
      if (scripts.typecheck) checks.push(`${runner} typecheck`);
      if (scripts.test) checks.push(`${runner} test`);
      if (!scripts.check && !scripts.typecheck && !scripts.test && scripts.build) {
        checks.push(`${runner} build`);
      }
    } catch {
      checks.push("pnpm test");
    }

    if (checks.length === 1) {
      checks.push("pnpm test");
    }

    return {
      id,
      repo,
      defaultBranch,
      empty: false,
      checks,
      protectedPaths: [
        "package.json",
        ...(hasPnpmLock ? ["pnpm-lock.yaml"] : hasPackageLock ? ["package-lock.json"] : []),
      ],
      detected: "node",
    };
  }

  if (fileNames.has("pyproject.toml") || fileNames.has("requirements.txt")) {
    return {
      id,
      repo,
      defaultBranch,
      empty: false,
      checks: ["pytest"],
      protectedPaths: fileNames.has("pyproject.toml") ? ["pyproject.toml"] : ["requirements.txt"],
      detected: "python",
    };
  }

  if (fileNames.has("Cargo.toml")) {
    return {
      id,
      repo,
      defaultBranch,
      empty: false,
      checks: ["cargo test"],
      protectedPaths: ["Cargo.toml", ...(fileNames.has("Cargo.lock") ? ["Cargo.lock"] : [])],
      detected: "rust",
    };
  }

  if (fileNames.has("go.mod")) {
    return {
      id,
      repo,
      defaultBranch,
      empty: false,
      checks: ["go test ./..."],
      protectedPaths: ["go.mod", ...(fileNames.has("go.sum") ? ["go.sum"] : [])],
      detected: "go",
    };
  }

  return {
    id,
    repo,
    defaultBranch,
    empty: false,
    checks: ["echo ok"],
    protectedPaths: [],
    detected: typeof repoMeta.language === "string" ? repoMeta.language.toLowerCase() : "unknown",
  };
}

/** Scaffolds starter template files into a repository via the GitHub Contents API. */
export async function bootstrapRepo(
  tokens: TokenSource,
  opts: BootstrapOptions,
  deps: GitHubDeps & { api?: string } = {},
): Promise<BootstrapResult> {
  const f = deps.fetch ?? fetch;
  const api = deps.api ?? API;
  const repo = checkRepo(opts.repo);
  const token = await tokens.token(repo, "write");
  const authHeader = { authorization: `Bearer ${token}` };

  const template = opts.template ?? "ts-node";
  const name = repo.split("/")[1] ?? "project";
  const description = opts.description ?? "Project managed by i.inc";

  const files: Record<string, string> = {};

  if (template === "ts-node") {
    files["package.json"] = `${JSON.stringify(
      {
        name,
        version: "0.1.0",
        type: "module",
        scripts: {
          check: "tsc --noEmit",
          test: "vitest run",
        },
        devDependencies: {
          typescript: "^5.7.0",
          vitest: "^3.0.0",
        },
      },
      null,
      2,
    )}\n`;
    files["tsconfig.json"] = `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
        },
        include: ["src", "test"],
      },
      null,
      2,
    )}\n`;
    files["src/index.ts"] =
      `export function greet(name = "World"): string {\n  return \`Hello, \${name}!\`;\n}\n`;
    files["test/index.test.ts"] =
      `import { describe, expect, it } from "vitest";\nimport { greet } from "../src/index.js";\n\ndescribe("greet", () => {\n  it("greets by name", () => {\n    expect(greet("${name}")).toBe("Hello, ${name}!");\n  });\n});\n`;
    files["README.md"] = `# ${name}\n\n${description}\n`;
    files[".gitignore"] = "node_modules/\ndist/\n";
  } else if (template === "web") {
    files["package.json"] = `${JSON.stringify(
      {
        name,
        version: "0.1.0",
        type: "module",
        scripts: {
          check: "tsc --noEmit",
          build: "vite build",
          test: "vitest run",
        },
        devDependencies: {
          typescript: "^5.7.0",
          vite: "^6.0.0",
          vitest: "^3.0.0",
        },
      },
      null,
      2,
    )}\n`;
    files["index.html"] =
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>${name}</title>\n</head>\n<body>\n  <div id="app"></div>\n  <script type="module" src="/src/main.ts"></script>\n</body>\n</html>\n`;
    files["src/main.ts"] = `document.querySelector("#app")!.innerHTML = "<h1>${name}</h1>";\n`;
    files["README.md"] = `# ${name}\n\n${description}\n`;
    files[".gitignore"] = "node_modules/\ndist/\n";
  } else if (template === "python") {
    files["pyproject.toml"] =
      `[project]\nname = "${name}"\nversion = "0.1.0"\ndescription = "${description}"\nreadme = "README.md"\nrequires-python = ">=3.11"\n\n[build-system]\nrequires = ["setuptools>=61.0"]\nbuild-backend = "setuptools.build_meta"\n`;
    files["src/__init__.py"] = '__version__ = "0.1.0"\n';
    files["tests/test_basic.py"] = "def test_basic():\n    assert True\n";
    files["README.md"] = `# ${name}\n\n${description}\n`;
    files[".gitignore"] = "__pycache__/\n*.py[cod]\n.venv/\n";
  } else {
    files["README.md"] = `# ${name}\n\n${description}\n`;
    files[".gitignore"] = ".DS_Store\n";
  }

  let commits = 0;
  for (const [path, content] of Object.entries(files)) {
    const encoded = Buffer.from(content, "utf8").toString("base64");
    await call(f, `${api}/repos/${repo}/contents/${path}`, {
      method: "PUT",
      headers: authHeader,
      body: JSON.stringify({
        message: `Initialize ${path} (i.inc scaffold)`,
        content: encoded,
        ...(opts.defaultBranch ? { branch: opts.defaultBranch } : {}),
      }),
    });
    commits++;
  }

  return { bootstrapped: true, commits };
}
