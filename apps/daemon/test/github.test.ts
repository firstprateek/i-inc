// The GitHub App against a recording fetch: no network, and a key made for the test.
import { createVerify, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appJwt,
  commitIdentity,
  FineGrainedToken,
  GitHubApp,
  PullRequests,
  readGitHubAppConfig,
  readPrivateKey,
} from "../src/github.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};

function recorder(reply: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const { status = 200, json } = reply(call);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return { calls, f };
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("the GitHub App", () => {
  it("signs a 9-minute JWT for the App with its private key", () => {
    const jwt = appJwt("123", privateKey, 1_800_000_000_000);
    const [header = "", payload = "", signature = ""] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload)).toEqual({ iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: "123" });
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });

  it("mints an installation token for the ticket's repo only, and reuses it until near expiry", async () => {
    let now = Date.parse("2026-09-28T10:00:00Z");
    let minted = 0;
    const { calls, f } = recorder(() => ({
      status: 201,
      json: { token: `ghs_${++minted}`, expires_at: new Date(now + 60 * 60_000).toISOString() },
    }));
    const app = new GitHubApp(
      { appId: "123", installationId: "456", privateKeyPath: "/unused" },
      { fetch: f, now: () => now, readKey: () => privateKey },
    );
    expect(await app.token("firstprateek/duet")).toBe("ghs_1");
    expect(calls[0]?.url).toBe("https://api.github.com/app/installations/456/access_tokens");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ repositories: ["duet"] });
    const jwt = calls[0]?.headers.authorization?.replace("Bearer ", "") ?? "";
    expect(decode(jwt.split(".")[1] ?? "").iss).toBe("123");

    now += 50 * 60_000; // 10 minutes left: reuse it
    expect(await app.token("firstprateek/duet")).toBe("ghs_1");
    now += 6 * 60_000; // 4 minutes left: mint a new one
    expect(await app.token("firstprateek/duet")).toBe("ghs_2");
    expect(calls).toHaveLength(2);
  });

  it("says what GitHub said when it refuses", async () => {
    const { f } = recorder(() => ({ status: 401, json: { message: "Bad credentials" } }));
    const app = new GitHubApp(
      { appId: "1", installationId: "2", privateKeyPath: "/unused" },
      { fetch: f, readKey: () => privateKey },
    );
    await expect(app.token("firstprateek/duet")).rejects.toThrow("failed: 401 Bad credentials");
    await expect(app.token("duet")).rejects.toThrow("not a repo: duet");
  });

  it("refuses a private key that others can read", () => {
    const path = join(mkdtempSync(join(tmpdir(), "inc-key-")), "github-app.pem");
    writeFileSync(path, privateKey);
    chmodSync(path, 0o644);
    expect(() => readPrivateKey(path)).toThrow("chmod 600");
    chmodSync(path, 0o600);
    expect(readPrivateKey(path)).toBe(privateKey);
  });

  it("reads the App's ids from the host, with the key beside them", () => {
    const dir = mkdtempSync(join(tmpdir(), "inc-config-"));
    writeFileSync(join(dir, "github-app.json"), JSON.stringify({ appId: 123, installationId: "456" }));
    expect(readGitHubAppConfig(dir)).toEqual({
      appId: "123",
      installationId: "456",
      slug: "i-inc-bot",
      privateKeyPath: join(dir, "github-app.pem"),
    });
    writeFileSync(join(dir, "github-app.json"), JSON.stringify({ appId: "i.inc", installationId: 456 }));
    expect(() => readGitHubAppConfig(dir)).toThrow("needs appId");
  });
});

describe("pull requests, as the bot", () => {
  it("opens a draft, sets the body and marks it ready", async () => {
    const { calls, f } = recorder((call) =>
      call.url.endsWith("/pulls")
        ? {
            status: 201,
            json: { number: 7, html_url: "https://github.com/firstprateek/duet/pull/7", node_id: "PR_7" },
          }
        : { json: { data: {} } },
    );
    const prs = new PullRequests(new FineGrainedToken("github_pat_x"), { fetch: f });
    const pr = await prs.openDraft("firstprateek/duet", {
      head: "inc/7-readme",
      base: "main",
      title: "docs: list lint and typecheck",
      body: "In progress.",
    });
    expect(pr).toEqual({ number: 7, url: "https://github.com/firstprateek/duet/pull/7", nodeId: "PR_7" });
    expect(calls[0]?.body).toMatchObject({ head: "inc/7-readme", base: "main", draft: true });
    expect(calls[0]?.headers.authorization).toBe("Bearer github_pat_x");

    await prs.setBody("firstprateek/duet", 7, "The report.");
    expect(calls[1]).toMatchObject({
      url: "https://api.github.com/repos/firstprateek/duet/pulls/7",
      method: "PATCH",
      body: { body: "The report." },
    });

    await prs.markReady("firstprateek/duet", "PR_7");
    expect(calls[2]?.url).toBe("https://api.github.com/graphql");
    expect(calls[2]?.body).toMatchObject({ variables: { id: "PR_7" } });
    expect(String(calls[2]?.body?.query)).toContain("markPullRequestReadyForReview");

    for (const repo of ["duet", "../duet", "firstprateek/..", "firstprateek/duet/pulls"]) {
      await expect(prs.setBody(repo, 7, "x")).rejects.toThrow(`not a repo: ${repo}`);
    }
    expect(calls).toHaveLength(3);
  });

  it("fails loudly when GraphQL returns errors", async () => {
    const { f } = recorder(() => ({ json: { errors: [{ message: "not a draft" }] } }));
    const prs = new PullRequests(new FineGrainedToken("t"), { fetch: f });
    await expect(prs.markReady("firstprateek/duet", "PR_7")).rejects.toThrow("not a draft");
  });

  it("commits as the employee, with the bot's noreply address", async () => {
    const { calls, f } = recorder(() => ({ json: { id: 987654 } }));
    expect(await commitIdentity("Ada", "i-inc-bot", { fetch: f })).toEqual({
      name: "Ada (i.inc)",
      email: "987654+i-inc-bot[bot]@users.noreply.github.com",
    });
    expect(calls[0]?.url).toBe("https://api.github.com/users/i-inc-bot%5Bbot%5D");
  });
});
