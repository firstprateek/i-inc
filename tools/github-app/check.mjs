// Checks the GitHub App setup (docs/github-app.md). Run it on the mini, where the key lives:
//   ssh <mini> node --input-type=module - <owner>/<repo> < tools/github-app/check.mjs
// It reads the ids and the key from ~/.config/i-inc, mints one token to look at the repo, never
// prints it, and revokes it at the end. Plain Node, no dependencies.
import { createSign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".config", "i-inc");
const repo = process.argv[2] ?? "";
let failed = false;
const pass = (msg) => console.log(`✓ ${msg}`);
const fail = (msg) => {
  failed = true;
  console.log(`✗ ${msg}`);
};
const note = (msg) => console.log(`  ${msg}`);

// What spec §5 gives the bot. `needed` must be there; `optional` may be; anything else is too much.
const needed = { contents: "write", pull_requests: "write", checks: "read", metadata: "read" };
const optional = { workflows: "write", actions: "write", issues: "write", pages: "write", statuses: "read" };

async function gh(method, path, token, body) {
  const res = await fetch(`${process.env.GITHUB_API ?? "https://api.github.com"}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "i-inc-check",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function appJwt(appId, key) {
  const b64 = (data) => Buffer.from(data).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  )}`;
  return `${head}.${b64(createSign("RSA-SHA256").update(head).sign(key))}`;
}

// 1. The files, readable only by you.
let config;
let key;
try {
  for (const path of [dir, join(dir, "github-app.pem")]) {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) fail(`${path} is ${mode.toString(8)}; make it ${path === dir ? 700 : 600}`);
  }
  config = JSON.parse(readFileSync(join(dir, "github-app.json"), "utf8"));
  key = readFileSync(join(dir, "github-app.pem"), "utf8");
  if (!failed) pass("the key and its folder are yours alone");
} catch (err) {
  fail(`can't read ${dir}: ${err.message}`);
  process.exit(1);
}
const jwt = appJwt(String(config.appId), key);

// 2. The App, and the permissions its installation grants (what tokens get).
const app = await gh("GET", "/app", jwt);
if (app.status !== 200) {
  fail(`GitHub refused the key for App ${config.appId}: ${app.status} ${app.json.message ?? ""}`);
  process.exit(1);
}
pass(`the key belongs to "${app.json.name}" (${app.json.slug})`);
if (config.slug && config.slug !== app.json.slug) fail(`github-app.json says slug ${config.slug}`);

const inst = await gh("GET", `/app/installations/${config.installationId}`, jwt);
if (inst.status !== 200) {
  fail(`no installation ${config.installationId}: ${inst.status} ${inst.json.message ?? ""}`);
  process.exit(1);
}
const perms = inst.json.permissions ?? {};
pass(`installed on ${inst.json.account?.login}, with ${Object.keys(perms).length} permissions`);
const rank = { read: 1, write: 2 };
for (const [name, level] of Object.entries(needed)) {
  if ((rank[perms[name]] ?? 0) < rank[level])
    fail(`it needs ${name}: ${level}, and has ${perms[name] ?? "none"}`);
}
for (const [name, level] of Object.entries(perms)) {
  if (!(name in needed) && !(name in optional)) fail(`it has ${name}: ${level}, which the bot mustn't`);
}
const without = Object.keys(optional).filter((name) => !(name in perms));
if (without.length) note(`not granted (fine until an employee needs them): ${without.join(", ")}`);
const sorted = (o) => JSON.stringify(Object.entries(o ?? {}).sort());
if (sorted(app.json.permissions) !== sorted(perms)) {
  note(
    `the App asks for more than the installation grants: accept it at github.com/settings/installations/${config.installationId}`,
  );
}
if (inst.json.repository_selection === "all")
  fail("it's installed on all your repos; pick only the ones employees work on");

// 3. The repo: a token for it alone, and the ruleset on its default branch.
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
  note("give <owner>/<repo> to check a repo and its ruleset too");
} else {
  const minted = await gh("POST", `/app/installations/${config.installationId}/access_tokens`, jwt, {
    repositories: [repo.split("/")[1]],
  });
  if (minted.status !== 201) {
    fail(`no token for ${repo}: ${minted.status} ${minted.json.message ?? ""} (is the App installed on it?)`);
  } else {
    const token = minted.json.token;
    pass(`minted a token for ${repo} alone, until ${minted.json.expires_at}`);
    const info = await gh("GET", `/repos/${repo}`, token);
    const branch = info.json.default_branch ?? "main";
    const rules = await gh("GET", `/repos/${repo}/rules/branches/${branch}`, token);
    const types = new Map((Array.isArray(rules.json) ? rules.json : []).map((rule) => [rule.type, rule]));
    const want = {
      update: "only the bypass list updates it (Restrict updates)",
      pull_request: "a PR is required",
      non_fast_forward: "force pushes are blocked",
      deletion: "it can't be deleted",
      required_status_checks: "status checks are required",
    };
    for (const [type, what] of Object.entries(want)) {
      if (types.has(type)) pass(`${branch}: ${what}`);
      else fail(`${branch}: ${what} is missing from the ruleset`);
    }
    const pr = types.get("pull_request")?.parameters;
    if (pr && pr.required_approving_review_count < 1) fail(`${branch}: a PR needs at least 1 approval`);
    if (pr && !pr.dismiss_stale_reviews_on_push)
      fail(`${branch}: stale approvals should be dismissed on push`);
    const checks = types.get("required_status_checks")?.parameters?.required_status_checks ?? [];
    if (checks.length) note(`required checks: ${checks.map((c) => c.context).join(", ")}`);
    for (const id of new Set([...types.values()].map((rule) => rule.ruleset_id))) {
      const set = await gh("GET", `/repos/${repo}/rulesets/${id}`, token);
      if (set.status !== 200) {
        fail(`can't read ruleset ${id} as the bot (${set.status}), so can't tell whether it can bypass it`);
        continue;
      }
      const bypass = set.json.current_user_can_bypass ?? "never";
      if (bypass === "never") pass(`the bot can't bypass ruleset "${set.json.name}"`);
      else fail(`the bot can bypass ruleset "${set.json.name}" (${bypass}); take it off the bypass list`);
    }
    const revoked = await gh("DELETE", "/installation/token", token);
    if (revoked.status === 204) pass("revoked the token");
    else fail(`couldn't revoke the token: ${revoked.status}; it expires within the hour`);
  }
}

// 4. The address the bot's commits carry.
const bot = await gh("GET", `/users/${encodeURIComponent(`${app.json.slug}[bot]`)}`);
if (bot.status === 200)
  pass(`commits read as "Ada (i.inc)" <${bot.json.id}+${app.json.slug}[bot]@users.noreply.github.com>`);
else fail(`can't find the bot user ${app.json.slug}[bot]: ${bot.status}`);

process.exit(failed ? 1 : 0);
