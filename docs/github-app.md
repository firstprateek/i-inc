# The GitHub App: i.inc's bot identity

Employees push branches and open PRs as a bot, never as you (spec §5). The bot is a GitHub App
called **i.inc bot**, on your personal account. For each session the daemon uses the App's private key
to mint a 1-hour token that only works on the ticket's repo (`apps/daemon/src/github.ts`). A
ruleset on each repo's `main` makes GitHub itself enforce that only you merge.

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
| Contents | Read and write | pushes its `inc/…` branches |
| Pull requests | Read and write | opens draft PRs, writes the report into them, and marks them ready |
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

For Duet, one command does it, with your own GitHub sign-in:

```bash
gh api repos/<owner>/duet/rulesets --method POST --input tools/github-app/duet-ruleset.json
```

Two more keep the bot to its own `inc/**` branches: one for every other branch and one for tags.
You and GitHub Actions, which pushes Release Please's branch and tags, bypass them:

```bash
gh api repos/<owner>/duet/rulesets --method POST --input tools/github-app/duet-branches-ruleset.json
gh api repos/<owner>/duet/rulesets --method POST --input tools/github-app/duet-tags-ruleset.json
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

`apps/daemon/src/github.ts` holds the pieces. Real mode (the handoff's next steps) wires them in.

- `readGitHubAppConfig` reads `~/.config/i-inc/github-app.json`, and `readPrivateKey` refuses a key
  that anyone else can read.
- `GitHubApp.token(repo)` mints a token for the ticket's repo alone: one that can push for the
  builder, read-only for a reviewer or verifier. A session gets one with at least 50 minutes left.
- In the machine, `gh`, and git through gh's credential helper, use that token, so they push as the
  bot. A session that runs past its token's hour loses push; fresh tokens mid-session are still to
  come (the handoff).
- `commitIdentity` gives commits the employee's name and the bot's noreply address, such as "Ada
  (i.inc)" with `<id>+i-inc-bot[bot]@users.noreply.github.com`, so GitHub shows them as the App's.
- `PullRequests` opens the draft at stage 1. At stage 9 it writes the report into the body and marks
  the PR ready, which only GraphQL can do.
- The merge is yours. For now, approve and squash-merge the PR on GitHub, then Approve in i.inc.
  Approve doing both with your account (spec §5) is still to come.

Until the App exists, a fine-grained token can stand in, as in M1 step 6 (`FineGrainedToken`).
Limit it to the repos employees work on, with Contents and Pull requests read and write. It acts
as you, so the ruleset won't stop it merging a PR. Delete it once the App works.
