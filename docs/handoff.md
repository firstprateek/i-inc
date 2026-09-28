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
| M3 adapters | `apps/daemon/src/acp.ts` (the real ACP client) and `apps/daemon/src/machines.ts` (Apple container). They're tested against a scripted ACP server, but **not wired into `main.ts` yet** |
| M4 (part) | Brain and handbook repos, edits applied from each retro, policies that wait for the owner, orientation, and the viewer |

`pnpm check`, `pnpm typecheck` and `pnpm test` pass (98 tests). CI runs all three.

## Open questions for the owner

1. **The Claude token in the process list.** Each session gets `CLAUDE_CODE_OAUTH_TOKEN` in its
   environment, through `container machine run … -- env K=V acp-claude`. It's never written to a
   file, but it shows in the mini's process list while a session runs. Is that OK? If not, the
   alternative is to write a file in the machine through `machine run -i` with stdin, then have the
   launcher read it.
2. **The GitHub App:** its name, the owner or org, and where its private key lives on the mini. The
   owner creates the App; the session writes the steps (item 3 below).

## Next steps, in order

Items 1, 4 and 6 need the mini, so they need a session on the owner's Mac, over SSH as in M1. Ask
the owner before any `sudo` or change to the host. The other items can run anywhere.

1. **Confirm the machine commands (mini).** `machines.ts` marks two unverified commands with
   `// verify`: `container machine start <name>` and `container machine stop <name>`.
   - Try them on `m1-test`, and time each.
   - Check that `start` on a missing machine fails. `AppleMachines` falls back to `create` when it
     does.
   - See whether `container machine list` has a JSON output.
   - Fix `machines.ts` and `test/acp.test.ts` if needed, and record what you find in
     `m1-findings.md` under "M3: machine commands".
2. **A real harness** (`Harness` port: `runChecks`, `runGates`). Use the same tooling as
   `machines.ts`: `container machine run -i -n inc-<id> -- bash -s` with a script on stdin (M1:
   `machine run` re-splits arguments).
   - **Checks** run the project's recipe in the ticket's worktree, `~/work/inc-<ticket>`. The
     recipe is a per-project setting in the registry, for example Duet's `pnpm install`, `pnpm
     check`, `pnpm typecheck` and `pnpm test`.
   - **Gates** fetch `main`, rebase, and rerun the checks. A conflict must come back as `{ ok:
     false, conflict: true }`.
   - Test it against a fake `Exec`, the way `acp.test.ts` tests the machine provider.
3. **The GitHub App** (spec §6, gates and privileged requests; §8).
   - Write `docs/github-app.md`: the permissions (Contents and Pull requests read/write, Checks
     read), a ruleset under which only the owner merges, and where the private key lives on the
     host (never in the repo).
   - Then build `apps/daemon/src/github.ts`. It mints installation tokens for pushes and draft PRs,
     so commits come from the bot identity, not the owner. Until the App exists, a fine-grained
     token (as in M1 step 6) can stand in.
4. **The base image (mini).** Grow `tools/m1/machine/Dockerfile` into `images/employee/`:
   - `systemd-sysv`;
   - its own user, `employee`, whose home is `/home/employee`. `acp.ts` sessions run in
     `/home/employee/work/inc-<id>` (see `cwdFor` where the agent is built);
   - Node, pnpm, the three harnesses, and the ACP launchers from `tools/m1/acp-launchers.sh`. The
     launchers must create `$I_INC_CWD` and start there;
   - `npm --allow-scripts`, and no gnome-keyring;
   - OpenCode pinned to local providers only, for a PA's machine.
5. **Real mode in `main.ts`.** When `I_INC_DEMO` isn't set, use `AcpAgent` with `machineLaunch()`,
   `AppleMachines`, the real harness and GitHub.
   - Credentials come from a file on the host, outside the repo: the Claude token from
     `claude setup-token`, and the GitHub App key.
   - `onUsage` feeds the account meters.
   - The helper model and chat can use Ollama through the relay later. Until then, keep the fakes
     behind a flag.
6. **The daemon's host setup at boot (mini).** A launchd job that loads the `pf` walls from
   `tools/m1/pf/` and starts the Ollama relay (`tools/m1/ollama-forward.mjs`).
   - Later, the daemon answers the machines' DNS itself, refusing tailnet names, and relays
     Antigravity's sign-in callback into the machine.
   - This changes the host's walls, so get the owner's explicit approval.
7. **The resume brief** (from M1 step 6). Add what the machine has and lacks, such as package
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
