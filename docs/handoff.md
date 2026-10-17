# Handoff: where i.inc stands, and what's next

For the next session, local or cloud. Read this, then [CLAUDE.md](../CLAUDE.md) and the spec. It
replaces the context the earlier cloud session had. Update it as you work, and remove each item as
it lands.

## Where things stand (2026-10-17)

Merged on `main`:

| Milestone | What's there |
| --- | --- |
| M1 | Run on the mini. Answers are in [m1-findings.md](m1-findings.md) and scripts in `tools/m1/`. The machine `m1-test` still runs there. The walls and the Ollama relay now come back at boot (`tools/host/`, below) |
| M2 | `packages/core`: the pipeline, engines and switch rules, the scheduler (reviewers and verifiers are scheduled like builds), errands, outbound permissions, My desk maths, knowledge routing, orientation. 64 tests |
| M3 (part) | `apps/daemon`: SQLite, registry, tick loop, API, urgent chat interrupts, brains and the handbook as git repos. `apps/web`: every view, light and dark. The daemon runs real employees by default (`real.ts`: ACP sessions in machines, the harness, credentials from `~/.config/i-inc/credentials.json`, projects and their recipes in the registry through `PUT /api/projects/:id`), or the scripted demo with `I_INC_DEMO=1` |
| M3 adapters | `apps/daemon/src/acp.ts` (the real ACP client), `apps/daemon/src/harness.ts` (checks and gates in the machine), `apps/daemon/src/machines.ts` (Apple container, its commands checked on the mini) and `apps/daemon/src/github.ts` (the GitHub App's tokens, draft PRs and the bot's commit identity). Tested against a scripted ACP server and a recording `fetch`, and wired into real mode (`real.ts`) |
| M3 image | `images/employee/`: the base image, built on the mini and checked in a throwaway machine, with Duet's recipe green in it ([its README](../images/employee/README.md)). Everything in a machine runs as its user `employee` |
| Redesign (2026-10-17) | [architecture.md](architecture.md): teams share a sandbox (`inc-<team>`, 12G, 6 CPUs); projects default to direct mode, where a fresh-context review of at most 2 rounds is followed by a push to main, CI on main (fix, or revert after 2 hours), and a report with up to 3 follow-up tickets; protected paths wait for the owner; GitHub sign-ins in sandboxes are renewed by the daemon; the container service starts at login and the mini restarts monthly |
| GitHub | The App **i.inc bot** is set up: its key and ids are on the mini in `~/.config/i-inc`, it's installed on Duet only, and Duet's `main` has the ruleset. `tools/github-app/check.mjs` passes. The App still has the Workflows, Actions write and Pages permissions it was created with; the owner narrows them (below) |
| First real ticket | 2026-10-01, on the mini: Ada (Claude, signed in inside her machine) took M1's README ticket from pick-up to a ready PR as the bot, firstprateek/duet#8. Her branch was made in her machine, three required CI checks passed, the gates waited for them, and the report became the PR body. It took three fixes on the way: Claude's "session limit" now pauses a ticket until the reset; the `acp-claude` launcher refreshes an expired sign-in before the adapter's parallel queries race to; and only a session's final answer counts as its output |
| M4 (part) | Brain and handbook repos, edits applied from each retro, policies that wait for the owner, orientation, and the viewer |

`pnpm check`, `pnpm typecheck` and `pnpm test` pass (160 tests). CI runs all three.

## Open questions for the owner

None right now.

## Next steps, in order

On 2026-10-17 the owner redesigned i.inc ([architecture.md](architecture.md)): a sandbox per team,
signed in once to each subscription, and reviewed work pushed straight to main. The code is in; the
mini still runs the old setup. Ask the owner before any `sudo` or change to the host.

1. **Move the mini to the new design.**
   - Update `~/i-inc` to `main`, rebuild the image (`images/employee`), and reinstall the daemon
     (`tools/host/install-daemon.sh`, which now also starts Apple's container service at login).
   - Register the team (`PUT /api/teams/engineering` with Ada), and sign its sandbox in once, with
     the owner: `tools/host/sign-in-claude.sh engineering`. Antigravity's sign-in still needs its
     callback relayed into the machine.
   - Retire `inc-ada` and `m1-test`.
   - The owner reinstalls the walls job with `sudo` (`install-walls.sh`), which adds the monthly
     restart.
2. **GitHub, for direct mode** (the owner's sign-in):
   - Duet's `main` ruleset: drop "PR required", "1 approval", "restrict updates" and the required
     checks, keep "no force-push" and "no deletion" (`tools/github-app/duet-ruleset.json`).
   - Apply `duet-branches-ruleset.json` and `duet-tags-ruleset.json`.
   - Narrow the App: no Workflows, Actions read-only, no Pages; accept it on the installation.
   - Move Duet's release secrets into an environment limited to `main`.
3. **The live test:** M1's README ticket (closed as Duet #8) again, in direct mode, end to end.
4. **Later:** a web login so the daemon can serve the tailnet; the helper model and chat on Ollama;
   Antigravity's sign-in relay and DNS in the daemon; usage caps (M5); automatic releases; a retry
   button on the board; a visual check of the new protected-paths card (`tools/ui-check`).

Lessons kept from earlier rounds: a new image doesn't reach existing sandboxes
(`tools/host/update-machine.sh`); failed tickets retry with `POST /api/tickets/:id/retry`; report
minutes count working time only; the adversarial review of 2026-10-01 and its fixes are in the
history of #22.

## Decisions already made (don't reopen)

- **Views and UI:**
  - three views: office, board and 1:1 chat;
  - a PA arrives in v1, after the GitHub loop works (M6);
  - light by default with a dark theme, and Lit components.
- **Engines:**
  - The Google engine is Antigravity; Gemini CLI no longer serves Google AI Pro.
  - Each employee's machine signs in to Claude with the owner's subscription (`claude auth login`),
    once, at hiring. The owner chose this on 2026-09-28 over the model-only token from `claude
    setup-token`, accepting that a full login reaches the owner's claude.ai connectors. A token in
    `~/.config/i-inc/credentials.json` still works for any account.
  - Cloud engines stay. A private cloud is only noted for later.
  - Home data goes only to local models; the planned model is qwen3.8 27B, set up later.
- **Credentials:**
  - A session's credentials go into its machine with `container machine run -e NAME`, copied from
    the environment of that one `container` process. They're in no command line, never on the
    machine's disk, and gone when the session ends (m1-findings.md, "M3: credentials").
  - The GitHub App is named **i.inc bot** (slug `i-inc-bot`), on the owner's personal account.
    Plain "i.inc" is refused: Apps share names with accounts, and an account `i-inc` exists. Its private key lives on the mini at `~/.config/i-inc/github-app.pem`, mode
    0600 in a 0700 folder, and never in the repo.
- **Brains:**
  - They live on the mini and are never pushed.
  - Shared facts go in the handbook; personality and duty lessons stay in each employee's brain.
- **Proof, My desk and goals:**
  - Proof images are copied into the PR, unless something in them is private; then the PR gets a
    tailnet link.
  - My desk counts hardware and electricity with simple maths. Its watt figures await a plug
    meter; M1 measured the chip only.
  - Goals live only in i.inc, with no GitHub milestone sync in v1.
- **The 2026-10-17 redesign:** one sandbox per team; direct to main by default (owner-merges per
  project); the reviewer is another employee, else a different engine, else a fresh session, at most
  2 rounds; protected paths (workflows, release config) need the owner; red main is fixed by the same
  ticket or reverted after 2 hours; agents file follow-ups within a daily budget; the owner cuts
  releases for now; Hermes stays off.
- **The repo is public:**
  - no secrets, tokens, account names or home addresses in it;
  - no model identifiers in commits or PRs;
  - conventional commits.

## Working conventions

- **The owner likes to talk ideas through first.** "Give me your thoughts" means thoughts, not
  action.
- **Keep status messages short.** The owner asks for concise next steps and what's needed from them.
- **Every UI change goes through the `ui-review` skill.** Run `tools/ui-check/check.mjs` at
  1440x900 and 390x844, in light and dark, and look at the screenshots.
- **Branches and PRs:** open a PR per coherent chunk, and the owner merges. After a merge, start the
  next branch from `main`.
