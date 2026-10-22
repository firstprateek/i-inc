# The GitHub App: i.inc's bot identity

Employees' branches and PRs are made by a bot, never as you (spec §5). The bot is a GitHub App
called **i.inc bot**, on your personal account. The daemon uses the App's private key to mint tokens
(`apps/daemon/src/github.ts`): a **write** token that exists only in the daemon's memory on the host and makes
every push, PR and CI read, and a **read-only** token limited to the repos a session works on, which is the
only GitHub credential a sandbox ever holds (T68, below). A ruleset on each repo's `main` makes GitHub itself
enforce who may update it.

Setting it up takes about ten minutes in a browser signed in to GitHub. The key goes straight to
the mini. It never goes into the repo, and neither do the App's ids. `<mini>` below is how you
reach the mini over SSH, and `<owner>` is your GitHub account.

## The quick way

```bash
node tools/github-app/create.mjs <mini>
```

It does steps 1 to 4 for you. It serves a page on 127.0.0.1:8765. Open it in any browser signed in
to GitHub, and confirm the App there; then install it. GitHub hands back a one-time code, which the
mini trades for the App's key, so the key never touches your Mac. The App's client and webhook
secrets are dropped, since i.inc uses neither. Then do step 5 and run the check in step 6.

The steps below are the same thing by hand.

## 1. Create the App

Open **github.com/settings/apps/new** and fill in:

| Field | Value |
| --- | --- |
| GitHub App name | `i.inc bot`, whose slug is `i-inc-bot`. Plain `i.inc` is refused: GitHub Apps share names with accounts, and an account called `i-inc` exists |
| Homepage URL | this repo's URL |
| Callback URL, Setup URL | leave empty |
| Request user authorization (OAuth) during installation | off |
| Webhook, Active | **off**. The daemon polls GitHub, and nothing on the mini listens |
| Where can this GitHub App be installed? | **Only on this account** |

Under **Repository permissions**, set these and leave everything else at No access:

| Permission | Access | What the bot does with it |
| --- | --- | --- |
| Contents | Read and write | the daemon, on the host, pushes `inc/…` branches (and `main` in direct mode); sandboxes get a read-only token |
| Pull requests | Read and write | the daemon opens draft PRs, writes the report into them, and marks them ready |
| Checks | Read-only | watches CI (stage 8) |
| Metadata | Read-only | GitHub requires it |
| Actions | Read-only | reads CI logs |
| Issues | Read and write | files and updates issues |
| Commit statuses | Read-only | reads CI that reports statuses instead of checks |

The first four are needed; the other three are optional.

Never grant **Workflows**, **Actions** write, **Pages**, **Administration**, **Secrets**,
**Environments** or any account permission. A token that can edit or start workflows reaches the
repo's Actions secrets (Duet's release signing keys, say) from GitHub's runners, which are outside
the walls, and the bot must not change settings (§13). Those go through privileged requests, which
i.inc carries out with your account once you approve. Without Workflows, GitHub also rejects any
push of the bot's that touches `.github/workflows/`.

**Creating repos is not on that list, on purpose.** GitHub lets an App create a repo only in an
*organization* and only with **Administration** (write), and never in a personal account. Administration also lets the
App change repo settings, so it is **off**, and **Company → Projects → New project** has you create the empty repo on GitHub
and give the bot access to it, then fills it. If you run i.inc in an organization and decide the convenience is worth the wider
permission, add Administration (write) in the App's permissions and accept it on the installation; the page notices
(`GET /api/github/status`) and creates the repo itself from then on.

Then click **Create GitHub App**.

## 2. Make its key, and put it on the mini

On the App's settings page:

1. Note the **App ID**, under About.
2. Under Private keys, click **Generate a private key**. Your browser downloads
   `i-inc-bot.<date>.private-key.pem`.

Copy it to the mini in one step. Nobody else there can read it, even for a moment:

```bash
ssh <mini> 'umask 077 && mkdir -p ~/.config/i-inc && chmod 700 ~/.config/i-inc && cat > ~/.config/i-inc/github-app.pem' < ~/Downloads/i-inc-bot.*.private-key.pem
```

Then delete the downloaded copy, and empty the Trash if that's where it went. If the key ever
leaks, generate a new one on the same page and delete the old one there.

## 3. Install it on the repos employees work on

On the App's settings page, click **Install App**, then **Install** next to your account. Choose
**Only select repositories**, pick them (Duet for now), and click **Install**. You can add repos
later from the same page.

You land on `github.com/settings/installations/<number>`. That number is the **installation ID**.

## 4. Give the daemon the ids

Replace the two placeholders, then run:

```bash
ssh <mini> 'umask 077 && cat > ~/.config/i-inc/github-app.json' <<'EOF'
{ "appId": "<App ID>", "installationId": "<installation ID>", "slug": "i-inc-bot" }
EOF
```

Neither id is a secret, but they're yours, so they stay out of the repo too.

## 5. A ruleset on `main`, in each of those repos

Since 2026-10-17 projects default to **direct mode** ([architecture.md](architecture.md)): the bot
pushes reviewed work straight to `main`, so `main`'s ruleset only blocks force-pushes and deletion.
That's `duet-ruleset.json` now. The table further down is the **owner-merges** setup, for a project
that wants every change to be a PR you merge. Change Duet's existing ruleset in place:

```bash
gh api repos/<owner>/duet/rulesets/<id> --method PUT --input tools/github-app/duet-ruleset.json
```

For a new repo, one command creates it, with your own GitHub sign-in:

```bash
gh api repos/<owner>/duet/rulesets --method POST --input tools/github-app/duet-ruleset.json
```

One more keeps the bot off every other branch: it can't create, change or delete any branch but its
own `inc/**` ones. You bypass it. Release Please's branch is left out, because on a personal
account GitHub won't put GitHub Actions on a ruleset's bypass list (it's refused with "must be part
of the ruleset source or owner organization"). For the same reason there's no ruleset on tags: it
would block Release Please's tags, and a tag alone releases nothing in Duet.

```bash
gh api repos/<owner>/duet/rulesets --method POST --input tools/github-app/duet-branches-ruleset.json
```

For another repo, copy the files and change the required checks. By hand, go to the repo's
**Settings → Rules → Rulesets → New ruleset → New branch ruleset**:

| Setting | Value |
| --- | --- |
| Ruleset name | `main` |
| Enforcement status | Active |
| Bypass list | **Repository admin**, which is you, set to **For pull requests only** |
| Target branches | **Include default branch** |
| Restrict updates | on |
| Restrict deletions, Block force pushes | on (they're on by default) |
| Require a pull request before merging | on, with **1** required approval, **Dismiss stale pull request approvals when new commits are pushed**, and **Squash** as the only allowed merge method |
| Require status checks to pass | on, with the CI jobs that run on every PR. Duet's are `Lint, types and tests`, `Desktop shell (macOS)` and `Sorting service (Python)` |

What this does:

- **Only you can move `main`.** Restrict updates leaves that to the bypass list. The bot can push
  branches and open PRs, but GitHub refuses it if it pushes to `main` or merges a PR, even one
  you've approved. Requiring an approval alone wouldn't stop that.
- **You merge through PRs.** Your bypass works for pull requests only, so nobody pushes to `main`,
  you included. When a PR hasn't met the rules, GitHub offers you the bypass as you merge. That's
  how your own PRs get in, since you can't approve them. So do Release Please's: GitHub runs no
  workflows on PRs that `GITHUB_TOKEN` opens, so their checks never report.
- **What you approved is what merges.** If the bot pushes after your approval, the approval is
  dismissed.
- **Required checks must run on every PR.** A check that a path filter skips never reports, so it
  blocks the PR for good.

GitHub enforces rulesets on public repos on the Free plan. A private repo needs GitHub Pro.

## 6. Check it

From your Mac, in this repo:

```bash
ssh <mini> node --input-type=module - <owner>/duet < tools/github-app/check.mjs
```

The check runs on the mini, where the key is. It confirms:

- the key and its folder are readable only by you;
- the key belongs to the App, which has the permissions above and nothing more;
- the App is installed on the repos you picked, not on all of them;
- the ruleset is in place, and the bot can't bypass it;
- the address the bot's commits will carry.

It mints one token to look at the repo, never prints it, and revokes it at the end.

## What the daemon does with it

`apps/daemon/src/github.ts` holds the pieces, and real mode wires them in.

- `readGitHubAppConfig` reads `~/.config/i-inc/github-app.json`, and `readPrivateKey` refuses a key
  that anyone else can read.
- **No write token ever enters a sandbox (T68).** An agent runs with bypassed permissions and can be
  prompt-injected; if its machine could push, a poisoned agent could push to `main` around the
  review pipeline (the bot may bypass the ruleset, for direct mode), and the deployer would put that
  code on the host. So:
  - `GitHubApp.readToken(repos)` (a `scopedToken` with `READ_PERMISSIONS`: contents, pull requests,
    checks and metadata, all read-only) mints the only token a sandbox gets, limited to the repos its
    sessions work on (the tickets' and conversations' projects) through the `repositories` and
    `permissions` fields of `POST /app/installations/{id}/access_tokens`. Never "all repos". A session
    with no project gets no GitHub sign-in. The machine is signed in with it (`gh auth login`, which
    git uses through gh's credential helper, as before) and it is renewed every 25 minutes. A
    stand-in token (`FineGrainedToken`) cannot be narrowed, so it is never put in a sandbox.
  - `GitHubApp.token(repo)` (write) is for the host alone: the host's push (`host-push.ts`), opening
    PRs and reading CI. It lives in the daemon's memory.
  - **Every push is the host's.** The sandbox packs exactly the commit the pipeline checked into a git
    bundle (`bundle.ts`, built from a sha it was told, in a clean repository) and prints it
    base64-encoded between markers. The daemon verifies the bundle (`git bundle verify`, one head, the
    tip is the expected sha, objects checked), unpacks it into a bare mirror
    (`~/.i-inc/push-mirrors/<owner>/<repo>.git`), scans the commits it brings for credentials with the
    same scan shipping uses, holds a project's protected paths itself, and pushes from the mirror with
    the write token in an `http.extraheader` of that one git child (empty HOME, no system or global
    config, no hooks). The branch and repo come from the daemon's records, never from the sandbox. The
    default branch is never force-pushed; a ticket's branch is replaced only under
    `--force-with-lease`. Bundles are capped at 10 MB. Anything it cannot check is a refusal.
  - **The ledger, and what the deployer trusts.** Every commit the daemon pushes to a repo's default branch
    is first written to `~/.i-inc/pushed-main.jsonl` (`{sha, repo, branch, ticket, at, parents, tip}`, plus
    `ownerApproved` and the approved paths when you tapped OK on the change, `secretsOverridden` when you said a
    scan finding is not a secret, `hostRevert` for a revert the host made). The pipeline's checks and review
    run where the builder does, so they do not count as review for code the host runs. For the repo the
    deployer deploys, every path the host could run (everything but `docs/**/*.md` and top-level `*.md`,
    never agent instruction files) is protected: the daemon holds the push for your OK, and the deployer
    deploys a commit that changes any of it only if the ledger has it with `ownerApproved`, or it is a
    commit of a pull request you merged. Your approval is for the commit and the diff of the protected paths
    shown on the card (the host hashes the diff itself), not for the path names. A revert the daemon makes
    (`hostRevert`) is accepted only for a ledgered commit and only if it is exactly its inverse. Host code
    deploys only with your approval or an owner-merged PR.
  - The merge is still yours, and the ruleset on `main` is unchanged. The owner's own tool for a
    change the bot may not push (workflows) is still `tools/host/push-for-owner.sh`.
- `commitIdentity` gives commits the employee's name and the bot's noreply address, such as "Ada
  (i.inc)" with `<id>+i-inc-bot[bot]@users.noreply.github.com`, so GitHub shows them as the App's.
- `PullRequests` opens the draft at stage 1. At stage 9 it writes the report into the body and marks
  the PR ready, which only GraphQL can do.
- The merge is yours, and happens on GitHub. A ready owner-merges ticket shows **Merge on GitHub** (a link to
  the PR) and **Close without merging** (closes the PR, keeps the branch), and no Approve while the PR is open.
  The daemon looks at the open PRs of such tickets about every 5 minutes (longer when GitHub rate limits it) and
  records the ticket as merged by itself once it sees the PR merged (so auto-release and clean-up follow), or a
  rejection if the PR was closed without merging. Approve doing the merge with your account is not built.

Until the App exists, a fine-grained token can stand in, as in M1 step 6 (`FineGrainedToken`).
Limit it to the repos employees work on, with Contents and Pull requests read and write. It acts
as you, so the ruleset won't stop it merging a PR. Delete it once the App works.
