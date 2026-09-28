# Handoff: where i.inc stands, and what's next

For the next session, local or cloud. Read this, then [CLAUDE.md](../CLAUDE.md) and the spec. It
replaces the context the earlier cloud session had. Update it as you work, and remove each item as
it lands.

## Where things stand (2026-09-28)

Merged on `main`:

| Milestone | What's there |
| --- | --- |
| M1 | Run on the mini. Answers are in [m1-findings.md](m1-findings.md) and scripts in `tools/m1/`. The walls, the Ollama relay and the machine `m1-test` still run there, set up by hand, so a reboot drops the walls and the relay |
| M2 | `packages/core`: the pipeline, engines and switch rules, the scheduler (reviewers and verifiers are scheduled like builds), errands, outbound permissions, My desk maths, knowledge routing, orientation. 64 tests |
| M3 (part) | `apps/daemon`: SQLite, registry, tick loop, API, urgent chat interrupts, brains and the handbook as git repos. `apps/web`: every view, light and dark. The daemon runs real employees by default (`real.ts`: ACP sessions in machines, the harness, credentials from `~/.config/i-inc/credentials.json`, projects and their recipes in the registry through `PUT /api/projects/:id`), or the scripted demo with `I_INC_DEMO=1` |
| M3 adapters | `apps/daemon/src/acp.ts` (the real ACP client), `apps/daemon/src/harness.ts` (checks and gates in the machine), `apps/daemon/src/machines.ts` (Apple container, its commands checked on the mini) and `apps/daemon/src/github.ts` (the GitHub App's tokens, draft PRs and the bot's commit identity). They're tested against a scripted ACP server and a recording `fetch`, but **not wired into `main.ts` yet** |
| M3 image | `images/employee/`: the base image, built on the mini and checked in a throwaway machine, with Duet's recipe green in it ([its README](../images/employee/README.md)). Everything in a machine runs as its user `employee` |
| M4 (part) | Brain and handbook repos, edits applied from each retro, policies that wait for the owner, orientation, and the viewer |

`pnpm check`, `pnpm typecheck` and `pnpm test` pass (130 tests). CI runs all three.

## Open questions for the owner

None right now.

## Next steps, in order

Item 3 needs the mini, so it needs a session on the owner's Mac, over SSH as in M1. Ask the owner
before any `sudo` or change to the host. The other items can run anywhere.

1. **The owner sets up the GitHub App** by following [github-app.md](github-app.md): the App, its
   key on the mini, the ids in `~/.config/i-inc/github-app.json`, and a ruleset on Duet's `main`.
   Then run the check at its end. Until then, the fine-grained token from M1 step 6 stands in.
2. **The rest of GitHub in the loop.** Pick-up makes the worktree and branch in the builder's
   machine, starting it with an empty commit (GitHub opens no PR without one), and opens the draft
   PR (`workspace.ts`). Sessions get a token for the ticket's repo as `GH_TOKEN`. The gates push the
   rebased branch, and the report goes into the PR, which is then marked ready. Still to do:
   - Stage 8 doesn't wait for GitHub CI yet: after the push, poll the PR's check runs.
   - A token lasts an hour, and a session gets one at launch. For longer sessions: in the image,
     git's credential helper and a `gh` wrapper ask the daemon's API for a fresh token (the walls
     already let machines reach the API), with a per-session key passed in with `-e`, so a machine
     only gets its own ticket's repo.
   - A reviewer or verifier checks out the branch in its own machine, from its brief. Pick-up could
     make their worktrees too.
   - Usage reports are in the registry (`registry.usage()`) but not on My desk yet, and the helper
     model and chat are still the fakes until they use Ollama through the relay.
3. **The daemon's host setup at boot (mini).** A launchd job that loads the `pf` walls from
   `tools/m1/pf/` and starts the Ollama relay (`tools/m1/ollama-forward.mjs`).
   - Later, the daemon answers the machines' DNS itself, refusing tailnet names, and relays
     Antigravity's sign-in callback into the machine.
   - This changes the host's walls, so get the owner's explicit approval.
4. **The resume brief** (from M1 step 6). Add what the machine has and lacks, such as package
   managers and whether checks ran. Point to the plan and notes files instead of quoting them.

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
