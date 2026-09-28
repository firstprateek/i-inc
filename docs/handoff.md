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
| M3 (part) | `apps/daemon`: SQLite, registry, tick loop, API, urgent chat interrupts, brains and the handbook as git repos. `apps/web`: every view, light and dark. The daemon runs **only in demo mode** |
| M3 adapters | `apps/daemon/src/acp.ts` (the real ACP client), `apps/daemon/src/harness.ts` (checks and gates in the machine) and `apps/daemon/src/machines.ts` (Apple container, its commands checked on the mini). They're tested against a scripted ACP server, but **not wired into `main.ts` yet** |
| M4 (part) | Brain and handbook repos, edits applied from each retro, policies that wait for the owner, orientation, and the viewer |

`pnpm check`, `pnpm typecheck` and `pnpm test` pass (98 tests). CI runs all three.

## Open questions for the owner

None right now.

## Next steps, in order

Items 2 and 4 need the mini, so they need a session on the owner's Mac, over SSH as in M1. Ask
the owner before any `sudo` or change to the host. The other items can run anywhere.

1. **The GitHub App** (spec §6, gates and privileged requests; §8).
   - Write `docs/github-app.md`: the permissions (Contents and Pull requests read/write, Checks
     read), a ruleset under which only the owner merges, and where the private key lives on the
     host (never in the repo).
   - Then build `apps/daemon/src/github.ts`. It mints installation tokens for pushes and draft PRs,
     so commits come from the bot identity, not the owner. Until the App exists, a fine-grained
     token (as in M1 step 6) can stand in.
2. **The base image (mini).** Grow `tools/m1/machine/Dockerfile` into `images/employee/`:
   - `systemd-sysv`;
   - its own user, `employee`, whose home is `/home/employee`. `acp.ts` sessions run in
     `/home/employee/work/inc-<id>` (see `cwdFor` where the agent is built);
   - Node, pnpm, the three harnesses, and the ACP launchers from `tools/m1/acp-launchers.sh`. The
     launchers must create `$I_INC_CWD` and start there;
   - `npm --allow-scripts`, and no gnome-keyring;
   - OpenCode pinned to local providers only, for a PA's machine.
3. **Real mode in `main.ts`.** When `I_INC_DEMO` isn't set, use `AcpAgent` with `machineLaunch()`,
   `AppleMachines`, the real harness and GitHub.
   - Use `MachineHarness` (`apps/daemon/src/harness.ts`) with a check recipe per project, kept in
     the registry (Duet's: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`,
     `pnpm test`). It already ran green on Duet inside `m1-test`.
   - Credentials come from a file on the host, outside the repo: the Claude token from
     `claude setup-token`, and the GitHub App key.
   - `onUsage` feeds the account meters.
   - The helper model and chat can use Ollama through the relay later. Until then, keep the fakes
     behind a flag.
4. **The daemon's host setup at boot (mini).** A launchd job that loads the `pf` walls from
   `tools/m1/pf/` and starts the Ollama relay (`tools/m1/ollama-forward.mjs`).
   - Later, the daemon answers the machines' DNS itself, refusing tailnet names, and relays
     Antigravity's sign-in callback into the machine.
   - This changes the host's walls, so get the owner's explicit approval.
5. **The resume brief** (from M1 step 6). Add what the machine has and lacks, such as package
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
  - The GitHub App is named **i.inc** (its slug `i-inc` was free on 2026-09-28), on the owner's
    personal account. Its private key lives on the mini at `~/.config/i-inc/github-app.pem`, mode
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
