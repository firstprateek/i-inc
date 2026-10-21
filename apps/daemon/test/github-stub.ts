// A stand-in for api.github.com, just enough for the projects flow (T62): the App's installation and
// its access tokens, the repos it can see, a repo's metadata and files, creating a repo in an
// organization, and writing starter files. Tests call `stub.fetch`; the end-to-end run serves
// `stub.handle` over HTTP (tools/e2e/projects). State is plain data so a test can change it between steps.
import { generateKeyPairSync } from "node:crypto";
import { GitHubApp } from "../src/github.ts";

export interface StubRepo {
  owner: string;
  name: string;
  private?: boolean;
  /** Files by path. No files means an empty repo (size 0, never pushed). */
  files?: Record<string, string>;
  description?: string | null;
  language?: string | null;
  defaultBranch?: string;
  /** GitHub's `size` lags: report 0 KB although the repo has files (a fresh README-only repo does this). */
  sizeLag?: boolean;
  /** Commits, oldest first. Files given up front count as one "Initial commit" by their owner. */
  commits?: StubCommit[];
  /** GitHub's numeric repo id: it stays when the repo is renamed. */
  id?: number;
}

export interface StubCommit {
  sha: string;
  message: string;
  /** The author's login. A starter commit's is the bot's (`state.botLogin`). */
  author: string;
  files: string[];
}

export interface StubOptions {
  account?: string;
  accountType?: "Organization" | "User";
  permissions?: Record<string, string>;
  repos?: StubRepo[];
  installationId?: string;
}

/** The real token that would be a secret: the tests check it never shows up in a response or log. */
export const STUB_TOKEN = "ghs_STUBTOKEN_do_not_leak_0123456789";

export interface StubCall {
  method: string;
  path: string;
  /** The authorization header was the stub's token, or a JWT for the App. */
  auth: "token" | "jwt" | "none";
  body: unknown;
}

export function createGitHubStub(o: StubOptions = {}) {
  const state = {
    account: o.account ?? "acme",
    accountType: o.accountType ?? ("Organization" as "Organization" | "User"),
    permissions: o.permissions ?? { contents: "write", pull_requests: "write", administration: "write" },
    installationId: o.installationId ?? "4242",
    repos: (o.repos ?? []).map((r, i): StubRepo => ({ ...r, id: r.id ?? i + 1 })),
    /** Who the commits written with the installation token are authored by. */
    botLogin: "i-inc-bot[bot]",
    shaCounter: 0,
    /** When set, every call fails with this: `{ status, headers?, message? }`. */
    fail: null as null | { status: number; headers?: Record<string, string>; message?: string },
    /** A per-path failure, such as a 422 on creating a repo. */
    failPath: [] as {
      match: RegExp;
      method?: string;
      status: number;
      message?: string;
      headers?: Record<string, string>;
    }[],
    calls: [] as StubCall[],
  };

  const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const find = (owner: string, name: string) =>
    state.repos.find(
      (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase(),
    );

  const sha = () => (++state.shaCounter).toString(16).padStart(40, "0");
  /** A repo's commits; files given up front are one earlier commit of someone else's. */
  const commitsOf = (r: StubRepo): StubCommit[] => {
    r.commits ??= Object.keys(r.files ?? {}).length
      ? [{ sha: sha(), message: "Initial commit", author: r.owner, files: Object.keys(r.files ?? {}) }]
      : [];
    return r.commits;
  };
  const meta = (r: StubRepo) => {
    const files = Object.keys(r.files ?? {});
    return {
      id: r.id ?? 1,
      name: r.name,
      full_name: `${r.owner}/${r.name}`,
      owner: { login: r.owner },
      private: r.private ?? true,
      default_branch: r.defaultBranch ?? "main",
      description: r.description ?? null,
      language: r.language ?? null,
      size: files.length && !r.sizeLag ? 10 : 0,
      pushed_at: files.length || r.commits?.length ? "2026-10-20T10:00:00Z" : null,
    };
  };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const authz = req.headers.get("authorization") ?? "";
    const auth: StubCall["auth"] =
      authz === `Bearer ${STUB_TOKEN}` ? "token" : /^Bearer eyJ/.test(authz) ? "jwt" : "none";
    const text = req.method === "GET" ? "" : await req.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    state.calls.push({ method: req.method, path, auth, body });

    if (state.fail)
      return reply({ message: state.fail.message ?? "stub failure" }, state.fail.status, state.fail.headers);
    const forced = state.failPath.find((f) => f.match.test(path) && (!f.method || f.method === req.method));
    if (forced) return reply({ message: forced.message ?? "stub failure" }, forced.status, forced.headers);

    const at = (method: string, re: RegExp, p = path) => (req.method === method ? re.exec(p) : null);
    const m1 = at("POST", /^\/app\/installations\/(\d+)\/access_tokens$/);
    if (m1) {
      if (auth !== "jwt") return reply({ message: "A JSON web token could not be decoded" }, 401);
      return reply({ token: STUB_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    const m2 = at("GET", /^\/app\/installations\/(\d+)$/);
    if (m2) {
      if (auth !== "jwt") return reply({ message: "A JSON web token could not be decoded" }, 401);
      return reply({
        id: Number(m2[1]),
        account: { login: state.account, type: state.accountType },
        repository_selection: "selected",
        permissions: state.permissions,
      });
    }
    if (auth !== "token") return reply({ message: "Bad credentials" }, 401);

    if (req.method === "GET" && path === "/installation/repositories") {
      const all = state.repos.map(meta);
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return reply({ total_count: all.length, repositories: all.slice((page - 1) * per, page * per) });
    }
    const m3 = at("POST", /^\/orgs\/([^/]+)\/repos$/);
    if (m3) {
      const owner = decodeURIComponent(m3[1] ?? "");
      const b = (body ?? {}) as { name?: string; private?: boolean; description?: string };
      if (state.accountType !== "Organization" || owner.toLowerCase() !== state.account.toLowerCase()) {
        return reply({ message: "Not Found" }, 404);
      }
      if (state.permissions.administration !== "write") {
        return reply({ message: "Resource not accessible by integration" }, 403);
      }
      if (!b.name || find(owner, b.name)) {
        return reply(
          {
            message: "Repository creation failed.",
            errors: [{ message: "name already exists on this account" }],
          },
          422,
        );
      }
      const repo: StubRepo = {
        id: Math.max(0, ...state.repos.map((r) => r.id ?? 0)) + 1,
        owner,
        name: b.name,
        private: b.private ?? true,
        description: b.description ?? null,
        files: {},
      };
      state.repos.push(repo);
      return reply(meta(repo), 201);
    }
    const m4 = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (m4) {
      const repo = find(decodeURIComponent(m4[1] ?? ""), decodeURIComponent(m4[2] ?? ""));
      if (!repo) return reply({ message: "Not Found" }, 404);
      const rest = m4[3] ?? "";
      if (req.method === "GET" && rest === "") return reply(meta(repo));
      const one = at("GET", /^\/commits\/([0-9a-f]+)$/, rest);
      if (one) {
        const c = commitsOf(repo).find((x) => x.sha === one[1]);
        if (!c) return reply({ message: "No commit found" }, 404);
        return reply({
          sha: c.sha,
          commit: { message: c.message },
          author: { login: c.author },
          files: c.files.map((filename) => ({ filename })),
        });
      }
      if (req.method === "GET" && rest.startsWith("/commits")) {
        const list = commitsOf(repo);
        if (!list.length) return reply({ message: "Git Repository is empty." }, 409);
        return reply(
          [...list]
            .reverse()
            .map((c) => ({ sha: c.sha, commit: { message: c.message }, author: { login: c.author } })),
        );
      }
      if (req.method === "GET" && rest === "/contents") {
        const names = Object.keys(repo.files ?? {});
        if (!names.length) return reply({ message: "This repository is empty." }, 404);
        return reply([...new Set(names.map((n) => n.split("/")[0]))].map((name) => ({ name, type: "file" })));
      }
      const get = at("GET", /^\/contents\/(.+)$/, rest);
      if (get) {
        const file = repo.files?.[decodeURIComponent(get[1] ?? "")];
        if (file === undefined) return reply({ message: "Not Found" }, 404);
        return reply({ sha: "abc123", content: Buffer.from(file).toString("base64") });
      }
      const put = at("PUT", /^\/contents\/(.+)$/, rest);
      if (put) {
        const file = decodeURIComponent(put[1] ?? "");
        repo.files ??= {};
        if (repo.files[file] !== undefined && !(body as { sha?: string })?.sha) {
          return reply({ message: "Invalid request. sha wasn't supplied." }, 422);
        }
        commitsOf(repo).push({
          sha: sha(),
          message: String((body as { message?: string }).message ?? ""),
          author: state.botLogin,
          files: [file],
        });
        repo.files[file] = Buffer.from(
          String((body as { content?: string }).content ?? ""),
          "base64",
        ).toString("utf8");
        return reply({ content: { path: file }, commit: { sha: "def456" } }, 201);
      }
    }
    return reply({ message: "Not Found" }, 404);
  }

  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handle(new Request(input instanceof Request ? input : String(input), init))) as typeof fetch;

  return { state, handle, fetch: fetchStub };
}

/** The real GitHubApp class pointed at a stub, with a throwaway key, so the JWT and token paths run. */
let pem: string | undefined;
export function stubApp(stub: ReturnType<typeof createGitHubStub>, api = "https://stub.github") {
  const { privateKey } = pem
    ? { privateKey: undefined }
    : generateKeyPairSync("rsa", { modulusLength: 2048 });
  pem ??= privateKey?.export({ type: "pkcs1", format: "pem" }).toString() as string;
  const key = pem;
  return new GitHubApp(
    {
      appId: "1",
      installationId: stub.state.installationId,
      slug: "i-inc-bot",
      privateKeyPath: "unused",
      api,
    },
    { fetch: stub.fetch, readKey: () => key },
  );
}
