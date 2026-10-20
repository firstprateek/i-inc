# Ticket 17 proof

Run `bun docs/proofs/17/run.mjs` from the repository root. It starts the real
HTTP daemon on `127.0.0.1:57400`, submits two tickets with two image attachments
through multipart HTTP, and waits for their public ticket responses to finish.
One ticket uses owner-merges mode and the other uses direct mode.

The daemon uses SQLite, its scheduler and runner, and the production
`GitHubWorkspace`. Bash and Git execute against a local origin. Ada, Kit and
Quinn belong to separate teams. The machine command boundary maps each
employee to a separate temporary filesystem root. GitHub PR responses, the
machine lifecycle, checks and agent responses are scripted. No real GitHub
credentials or remote VM infrastructure are used. This proves application
behavior across separate machine roots, not the Apple VM transport on macOS.

## Acceptance evidence

1. **Reviewer receives the ticket's images — pass at the application boundary.**
   At the start of Kit's review session, its own filesystem root contained
   `.inc/attachments/1-chart.png` and `.inc/attachments/2-receipt.jpg`. Their
   bytes matched the uploaded files exactly. The public events showed Kit's
   `attachments-copied` before its `session-started`. Its root differed from
   Ada's. The same checks passed for Quinn's proof session and in direct mode.
   The owner-merges review checkout also had a clean Git status. Direct mode
   delivers the images into a plain folder; cross-machine branch delivery in
   direct mode remains outside this ticket.
2. **Brief lists the images — pass.** The agent boundary recorded Kit's actual
   incoming review brief and Quinn's proof brief in both modes. Each listed
   both paths. See [observations.json](observations.json) for the briefs, hashes
   and public events.
3. **Tests cover a second employee reviewing images — pass.** The full suite
   passed, including the core's `a second employee reviews a ticket with images`
   group and daemon's `a reviewer's machine` group. Coverage includes both
   modes, later-round images, failed helper copies, real Git checkouts in
   separate roots, repeated checkout, and preservation of builder worktrees.

## Checks

`pnpm install --frozen-lockfile`, `pnpm check`, `pnpm typecheck` and `pnpm test`
passed. The suites passed 128 core, 295 daemon and 357 web tests (780 total),
plus the Codex host helper regressions. The independent HTTP proof passed.

Only proof artifacts were added during this stage.
