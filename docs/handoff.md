# Handoff: where i.inc stands, and what's next

For the next session, local or cloud. Read this, then [CLAUDE.md](../CLAUDE.md) and the spec. It
replaces the context the earlier cloud session had. Update it as you work, and remove each item as
it lands.

## Where things stand (2026-09-28)

Merged on `main`:

| Milestone | What's there |
| --- | --- |
| M1 | Run on the mini. Answers are in [m1-findings.md](m1-findings.md) and scripts in `tools/m1/`. The machine `m1-test` still runs there. The walls and the Ollama relay now come back at boot (`tools/host/`, below) |
| M2 | `packages/core`: the pipeline, engines and switch rules, the scheduler (reviewers and verifiers are scheduled like builds), errands, outbound permissions, My desk maths, knowledge routing, orientation. 64 tests |
| M3 (part) | `apps/daemon`: SQLite, registry, tick loop, API, urgent chat interrupts, brains and the handbook as git repos. `apps/web`: every view, light and dark. The daemon runs real employees by default (`real.ts`: ACP sessions in machines, the harness, credentials from `~/.config/i-inc/credentials.json`, projects and their recipes in the registry through `PUT /api/projects/:id`), or the scripted demo with `I_INC_DEMO=1` |
| M3 adapters | `apps/daemon/src/acp.ts` (the real ACP client), `apps/daemon/src/harness.ts` (checks and gates in the machine), `apps/daemon/src/machines.ts` (Apple container, its commands checked on the mini) and `apps/daemon/src/github.ts` (the GitHub App's tokens, draft PRs and the bot's commit identity). They're tested against a scripted ACP server and a recording `fetch`, but **not wired into `main.ts` yet** |
| M3 image | `images/employee/`: the base image, built on the mini and checked in a throwaway machine, with Duet's recipe green in it ([its README](../images/employee/README.md)). Everything in a machine runs as its user `employee` |
| GitHub | The App **i.inc bot** is set up: its key and ids are on the mini in `~/.config/i-inc`, it's installed on Duet only, and Duet's `main` has the ruleset. `tools/github-app/check.mjs` passes. Nothing has pushed as the bot yet |
| M4 (part) | Brain and handbook repos, edits applied from each retro, policies that wait for the owner, orientation, and the viewer |

`pnpm check`, `pnpm typecheck` and `pnpm test` pass (138 tests). CI runs all three.

## Open questions for the owner

None right now.

## Next steps, in order

Item 2 needs the mini, so it needs a session on the owner's Mac, over SSH as in M1. Ask the owner
before any `sudo` or change to the host. The other items can run anywhere.

1. **The rest of GitHub in the loop.** Pick-up makes the worktree and branch in the builder's
   machine, starting it with an empty commit (GitHub opens no PR without one), and opens the draft
   PR (`workspace.ts`). Sessions get a token for the ticket's repo as `GH_TOKEN`. The gates push the
   rebased branch and wait for GitHub CI on it (`waitForCi`), and the report goes into the PR, which
   is then marked ready. Still to do:
   - Red CI at the gates fails the ticket honestly. It could get a fix session first, as failed
     checks do at stage 4.
   - A token lasts an hour, and a session gets one at launch. For longer sessions: in the image,
     git's credential helper and a `gh` wrapper ask the daemon's API for a fresh token (the walls
     already let machines reach the API), with a per-session key passed in with `-e`, so a machine
     only gets its own ticket's repo.
   - A reviewer or verifier checks out the branch in its own machine, from its brief. Pick-up could
     make their worktrees too.
   - Usage reports are in the registry (`registry.usage()`) but not on My desk yet, and the helper
     model and chat are still the fakes until they use Ollama through the relay.
2. **The daemon's host setup at boot (mini).** Installed on 2026-09-28, from `tools/host/`:
   - the walls job, the LaunchDaemon `inc.i.walls`, which loads the `pf` walls at boot and every
     minute after, keeps `pf` on, and leaves `/var/run/i-inc-walls.ok` while they're up. The daemon
     fails closed: without the marker, no machine boots and no session or script starts
     (`assertWalls`);
   - the Ollama relay, the owner's LaunchAgent `inc.i.ollama-relay`, which waits for the machines'
     gateway at boot.

   M1's wall tests pass from inside `m1-test` with them (13 of 13).

   The daemon runs there too, since 2026-09-28: the LaunchAgent `inc.i.daemon`
   (`tools/host/install-daemon.sh`) runs `~/i-inc` (branch `m3-deploy` until the stack merges;
   switch it to `main` then) with Bun and pnpm from Homebrew, on 127.0.0.1:7420. The web app sends
   no token yet, and the tailnet has a device that isn't the owner's, so it isn't served there:
   reach it with `ssh -L 7420:127.0.0.1:7420 <mini>`. The registry has the account `claude`, the
   engine `claude` (Claude Code) and the project `Duet` with its recipe. The owner's Claude token
   goes in with `tools/host/add-claude-token.sh claude`, then `launchctl kickstart -k
   gui/$(id -u)/inc.i.daemon`.

   Still to do:
   - hire the first employee and run a real Duet ticket end to end (M1's README ticket, as the bot);
   - a token for the web app, so the daemon can be served on the tailnet;
   - answer the machines' DNS in the daemon, refusing tailnet names, and relay Antigravity's
     sign-in callback into the machine.

After these, M3 can take a real Duet ticket end to end. Then come the rest of M4 (PM ticket drafting,
UX review, non-code tickets) and M5 (track records per engine, enforced usage caps, K per host).

## Decisions already made (don't reopen)

- **Views and UI:**
  - three views: office, board and 1:1 chat;
  - a PA arrives in v1, after the GitHub loop works (M6);
  - light by default with a dark theme, and Lit components.
- **Engines:**
  - The Google engine is Antigravity; Gemini CLI no longer serves Google AI Pro.
  - Employees get the model-only Claude token, never a full login, because a full login reaches the
    owner's connectors.
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
