// Creates the GitHub App from a manifest (docs/github-app.md, steps 1 to 4), so nobody fills in
// GitHub's form by hand, and its private key goes straight to the mini:
//   node tools/github-app/create.mjs <mini>
// where <mini> is how ssh reaches the mini. It serves a page on 127.0.0.1. Open that in any browser
// that's signed in to GitHub, and confirm there. GitHub sends the browser back with a one-time code,
// which the mini trades for the App's key, so the key never touches this Mac. The App's client
// secret and webhook secret are dropped, since i.inc uses neither. Installing the App then brings
// the browser back once more, with the installation's id, which goes into github-app.json.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const mini = process.argv[2];
if (!mini) {
  console.error("usage: node tools/github-app/create.mjs <mini>");
  process.exit(64);
}
const port = Number(process.env.PORT ?? 8765);
const base = `http://127.0.0.1:${port}`;
const state = randomBytes(16).toString("hex");
const homepage = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" })
  .trim()
  .replace(/^git@github\.com:/, "https://github.com/")
  .replace(/\.git$/, "");

const manifest = {
  name: "i.inc bot",
  url: homepage,
  description: "The bot that i.inc's employees push branches and open pull requests as.",
  public: false,
  redirect_url: `${base}/created`,
  setup_url: `${base}/installed`,
  setup_on_update: false,
  request_oauth_on_install: false,
  default_events: [],
  // Spec §5's list, and nothing that changes settings.
  default_permissions: {
    contents: "write",
    pull_requests: "write",
    checks: "read",
    metadata: "read",
    workflows: "write",
    actions: "write",
    issues: "write",
    pages: "write",
    statuses: "read",
  },
};

// Trades the code on the mini. The key and the secrets stay there; only the ids come back.
const convert = `set -eu
umask 077
dir="$HOME/.config/i-inc"
mkdir -p "$dir" && chmod 700 "$dir"
if [ -e "$dir/github-app.pem" ]; then echo "$dir/github-app.pem exists already; not replacing it" >&2; exit 1; fi
IFS= read -r code
resp=$(printf 'url = "https://api.github.com/app-manifests/%s/conversions"\\n' "$code" |
  /usr/bin/curl -fsS -X POST -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' -K -)
printf '%s' "$resp" | /usr/bin/jq -er .pem >"$dir/github-app.pem"
printf '%s' "$resp" | /usr/bin/jq '{appId: (.id | tostring), slug}' >"$dir/github-app.json"
printf '%s' "$resp" | /usr/bin/jq -r '"\\(.slug) \\(.id) \\(.owner.login)"'`;

const install = `set -eu
umask 077
f="$HOME/.config/i-inc/github-app.json"
IFS= read -r id
/usr/bin/jq --arg id "$id" '. + {installationId: $id}' "$f" >"$f.new" && mv "$f.new" "$f"
cat "$f"`;

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
function onMini(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", mini, `sh -c ${quote(script)}`]);
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      err += c;
    });
    child.on("exit", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `exit ${code}`)),
    );
    child.stdin.end(`${input}\n`);
  });
}

const html = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (body) =>
  `<!doctype html><meta charset="utf-8"><title>i.inc's GitHub App</title>` +
  `<body style="font:16px/1.5 system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem">${body}</body>`;

let slug = "";
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", base);
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(page(body));
  };
  if (url.pathname === "/") {
    return send(
      200,
      `<h1>i.inc's GitHub App</h1><p>This sends the App's settings to GitHub, which asks you to confirm.</p>` +
        `<form action="https://github.com/settings/apps/new?state=${state}" method="post">` +
        `<input type="hidden" name="manifest" value="${html(JSON.stringify(manifest))}">` +
        `<button style="font:inherit;padding:.5rem 1rem">Create it on GitHub</button></form>`,
    );
  }
  if (url.searchParams.get("state") !== state) return send(403, "<p>That link isn't from this run.</p>");
  if (url.pathname === "/created") {
    const code = url.searchParams.get("code") ?? "";
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) return send(400, "<p>GitHub sent no code.</p>");
    try {
      const [s, id, owner] = (await onMini(convert, code)).split(" ");
      slug = s ?? "";
      console.log(`created the App ${slug}, id ${id}, owned by ${owner}; its key is on the mini`);
      const next = `https://github.com/apps/${slug}/installations/new?state=${state}`;
      return send(
        200,
        `<h1>Created ${html(slug)}</h1><p>Its key is on the mini. Now install it: choose ` +
          `<b>Only select repositories</b> and pick the ones employees work on.</p>` +
          `<p><a href="${html(next)}">Install it</a></p>`,
      );
    } catch (err) {
      console.error(`couldn't trade the code on the mini: ${err.message}`);
      return send(500, `<p>The mini couldn't trade GitHub's code: ${html(err.message)}</p>`);
    }
  }
  if (url.pathname === "/installed") {
    const id = url.searchParams.get("installation_id") ?? "";
    if (!/^\d+$/.test(id)) return send(400, "<p>GitHub sent no installation id.</p>");
    try {
      console.log(`installed; github-app.json on the mini: ${await onMini(install, id)}`);
      send(200, "<h1>Done</h1><p>You can close this tab.</p>");
      server.close();
      return;
    } catch (err) {
      console.error(`couldn't write the installation id: ${err.message}`);
      return send(500, `<p>The mini couldn't save the installation id: ${html(err.message)}</p>`);
    }
  }
  send(404, "<p>Not here.</p>");
});
server.listen(port, "127.0.0.1", () => console.log(`open ${base}/ in a browser signed in to GitHub`));
