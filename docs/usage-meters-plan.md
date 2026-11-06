# Ticket #22: usage meters wording, expiry and tests

Stage: plan. Production code is unchanged. Regression tests intentionally fail before the fixes.

## Check against current main

Fetched `origin/main` on 2026-11-06: `768f09f33ffb23e77077c9e42d541453e9d1b7aa`.
The ticket branch starts at that commit. Record these findings in the eventual PR description.

| Acceptance item | Current main | Planned work |
| --- | --- | --- |
| Missing utilization has `aria-valuetext="unknown"` | Bug: the missing window displays `—` but announces `: 0%` when the other window has utilization | Correct the accessible text for each missing window |
| Completion without metadata never says `allowed`; C13 agrees | Runtime already fixed: `AcpAgent.run` completes without an `onRateLimit` callback; C13 still promises `allowed` | Preserve runtime behavior, add a regression, correct C13 |
| Rejection without `resetsAt` expires | Bug: `allRateLimits` only expires explicit reset times; the web also treats a missing reset as indefinite | Apply a finite fallback based on the report's `updatedAt` |
| Claude session/minute counts appear with utilization | Bug: utilization and activity are mutually exclusive branches in `IncOffice.accountsSection` | Show available counts beside the utilization for each window |
| 20-second rounding | Already rounds merged milliseconds to the nearest minute: 20 seconds is zero minutes | Add explicit coverage; keep the math |
| Empty fallback | Already returns zero minutes rather than inventing time from session-start events; completely empty input returns zero counts and null last use | Add explicit coverage for both paths |
| Web `—`, `100%`, `1 session` | Display logic exists, but the existing out-of-range Claude fixture has no corresponding account, so that path is never rendered | Add real rendered-account assertions, including the singular form |

## Approach and files

1. Keep the new failing tests in `apps/web/test/views.test.ts` and
   `apps/daemon/test/api.test.ts` as the starting point. They reproduce the incorrect accessible
   value, hidden Claude counts, and a rejection still present at the proposed fallback deadline.
2. In `apps/daemon/src/views.ts`, expire a rejection at its explicit `resetsAt`, or at
   `updatedAt + one hour` when no reset was reported. Use the supplied `now`; do not derive a fresh
   deadline on every read. Remove the expired status without inventing `allowed`, retaining existing
   utilization. This also covers stored legacy records without a schema migration.
3. In `apps/web/src/components/office.ts`, announce `unknown` for a missing utilization value.
   Keep numeric values clamped to 0–100. Render session/minute counts when supplied alongside each
   utilization row, retaining the activity-only presentation for accounts without utilization.
   Keep optional counts absent when not supplied rather than implying known zero activity.
   Use the same finite rejection deadline for the web's status guard, including a card that remains
   mounted across expiry through the existing refresh mechanism.
4. Inspect `apps/daemon/src/registry.ts` and the scheduler's rate-limit reads in
   `apps/daemon/src/daemon.ts` before implementing expiry. Preserve the existing protection against
   downgrading an explicitly unexpired rejection and avoid inheriting a stale reset from an older
   report. If a small shared deadline helper is needed for consistency, add it at the existing shared
   view-type boundary rather than duplicating policy across consumers. Do not extend scheduling
   blocks as an incidental part of a display fix.
5. Update contract C13 in `docs/coord.md`: metadata-free successful completion makes no quota
   assertion; rate-limit failures report rejection, with a finite fallback for unknown reset times.
   No new status strings or API fields are needed. Note the runtime behavior was already fixed.

## Test strategy

- Web: missing and null utilization announce `unknown` and display `—`; known zero stays `0%`;
  over-range utilization displays `100%` with matching ARIA/bar bounds. Cover both missing-window
  directions and accounts with neither utilization value. Assert `1 session` and plural counts with
  utilization and in activity-only cards, and exercise absent optional counts/minutes.
- Daemon API: explicit and inferred expiry immediately before, exactly at, and after the deadline;
  both `/api/accounts` and `/api/office` agree. Retain utilization after expiry, never infer `allowed`,
  preserve explicit future reset times and the active-rejection downgrade guard. Cover refreshed
  reports and persisted no-reset records so stale resets or moving deadlines cannot hide the bug.
- Telemetry API: a single 20-second session counts as one session and zero active minutes in both
  windows. Multiple short intervals must merge/sum before rounding. With no session rows, exercise
  session-start event fallback (counts, zero minutes, last use), then no events at all (all zeros and
  null last use). Retain existing boundary, overlap, orphan and invalid-duration coverage.
- ACP: add a successful completion without metadata and assert no rate-limit callback for Claude
  and a non-Claude harness. Retain real metadata and rate-limit-error tests. These are regression
  guards for behavior already correct on main.
- During build, follow `.claude/skills/ui-review/SKILL.md`: read the tells and lessons, build the web
  app, render representative Usage cards at 390×844 and 1440×900 in light/dark, run the UI checker,
  and inspect every screenshot. Use only `$I_INC_PORTS` for local servers.
- Before delivery, run in order: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm typecheck`,
  `pnpm test`. Build the web app and complete the UI review. Commit locally; do not push.

## Risks and defaults

- The ticket does not specify a no-reset TTL. Proposed default: one hour from `updatedAt`, matching
  the ACP adapter's existing unknown-reset fallback. An explicit reset remains authoritative.
- Expiry means the rejection is no longer current, not that the provider allows work. Preserve
  measured utilization and do not manufacture a new status.
- Registry merges can carry an older reset into a later rejection. Test successive reports before
  choosing whether a focused merge adjustment is necessary.
- More text can crowd quota rows on phones. Keep counts readable and allow wrapping; confirm in
  the real browser at phone and desktop sizes.
- No provider access, live account credentials, database migration, or Mac hardware is needed.

## Questions

No blocking questions. The plan assumes the existing one-hour unknown-reset fallback and nearest
whole-minute rounding (20 seconds → 0 minutes). These defaults preserve the established behavior
where it is already correct; an alternative TTL is the only product policy choice left open.

## Plan-stage validation

`pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm typecheck` pass. Biome reports two existing
informational template-literal notices in `brain-prereq.test.ts`.

The web regressions fail as intended: missing utilization announces `: 0%` and Claude's counts are
absent despite `100%` rendering. The daemon regression fails as intended: a no-reset rejection
still reports `rejected` at the one-hour deadline. No production fix has been applied at this stage.

`pnpm test` exits 1 at the new daemon regression (2,395 daemon tests pass); its fail-fast workspace
run does not reach web or host checks. The separate web suite reports exactly the two new failures,
1,371 passed and 56 skipped. The separate daemon suite likewise reports only the new expiry failure.
The full command must pass after implementation; this is a deliberately red plan-stage commit.
