# Architecture (since the 2026-10-17 redesign)

The owner reviewed the design on 2026-10-17 and simplified it, so the company can run more on its
own and sign in to each subscription once. This page is the current picture. Where it differs from
[spec.md](spec.md), this page wins; the spec says so where it's affected.

## The pieces

**The owner** sets goals, teams and project settings, OKs changes to protected paths, cuts releases
(for now), and reads reports.

**The daemon** runs on the Mac mini, outside every sandbox:

- the scheduler and the ticket pipeline (`packages/core`);
- the registry: teams, employees, engines, accounts and projects;
- knowledge: the handbook, with a section per team, and each employee's brain, as git repos;
- the GitHub bot, "i.inc bot", which mints tokens and keeps each sandbox signed in to GitHub;
- the web app and API, on 127.0.0.1, reached through an SSH tunnel.

**A team** is a group of employees, and its **sandbox**: one walled machine, `inc-<team>`, about
12G and 6 CPUs, where all its members work.

- Each subscription (Claude, Antigravity) is signed in once per sandbox, and every agent on the
  team uses that sign-in (`tools/host/sign-in-claude.sh`).
- Each ticket works in its own folder, `/home/employee/work/inc-<ticket>`, and gets its own range
  of 100 ports in `$I_INC_PORTS`.
- The daemon renews the sandbox's GitHub sign-in every 25 minutes, so sessions of any length can push.
- Employees with no team work in the company's sandbox, `inc-company`.

**A project** is a repo with a check recipe and a policy (`PUT /api/projects/:id`):

| Setting | Default | |
| --- | --- | --- |
| `mode` | `direct` | `direct`: reviewed work goes straight to main. `owner-merges`: a draft PR the owner merges |
| `protectedPaths` | `.github/`, Release Please's config | Changes there wait for the owner's OK |
| `followUpsPerDay` | 3 | Tickets agents may file for themselves |

## A ticket, in direct mode

1. **Pick up:** a fresh branch from main in the team's sandbox, kept local.
2. **Plan** (Medium and High effort): no gate; nothing waits for the owner.
3. **Build.**
4. **Checks:** the project's recipe, with up to 5 fix attempts before an engine switch.
5. **Prove** (Medium and High): a verifier checks each done-when item.
6. **Review:** with fresh eyes, seeing only the ticket and the diff. The reviewer is another employee
   with the review duty if there is one; otherwise the builder's seat on a different engine, so a
   different AI reviews; otherwise a fresh session. At most 2 rounds, then the work goes on, with
   any open disagreement in the report.
7. **Gates:** if the change touches protected paths, it waits for the owner's OK. Then rebase on
   main, the checks again, and a push to main. If main moved meanwhile, rebase and try again.
8. **CI on main:** if it fails, the same ticket becomes the fix, first in line. If main is still red
   2 hours after the push, the push is reverted and the ticket fails honestly.
9. **Report:** to the board, with up to 3 follow-up tickets the builder noticed. The ticket closes
   without waiting for the owner.
10. **Retro:** lessons go to the brains and the handbook.

GitHub refuses the bot any change to `.github/workflows`, which keeps the repo's secrets (Duet's
release signing key) out of agents' reach. So a reviewed workflow change waits for the owner, who
pushes it with `tools/host/push-for-owner.sh` and then OKs the ticket.

## Releases

The owner cuts releases for now: a release bundles many commits on main. Making them automatic is
for later, once the owner trusts it. The signing key stays a GitHub secret, never readable by agents.

## Knowledge

- **The handbook:** the company's shared knowledge, with a section per team for its conventions.
- **Each employee's brain:** what it learned itself.

Both live on the mini, outside the sandboxes, and reach agents through their briefs.

## Safety that stays

- **The walls** around every sandbox: the internet, but not the home network, the tailnet or the
  mini. Nothing runs in a sandbox unless the walls job confirmed them in the last two minutes, and
  machines stop when they drop.
- **The bot** is its own GitHub identity, never the owner's, with no settings, workflow or secret
  powers.
- **Honest reports**, and a daily budget on agents' own tickets, so a loop can't spend the week's
  quota.

What a shared sandbox gives up: agents on a team can see and change each other's folders. A
prompt-injected agent could interfere with a teammate's work, but not reach past the walls.

## The host

- `inc.i.walls` (root): the walls, every minute; `inc.i.restart` (root): a restart on the 1st of
  each month, for a macOS bug that stops finished connections expiring after ~49.7 days of uptime.
- `inc.i.container`, `inc.i.daemon` and `inc.i.ollama-relay`: Apple's container service, the
  daemon and the Ollama relay, at login.
