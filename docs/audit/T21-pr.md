# Ticket #21 — PR notes and validation

Desk error banner dismiss button size and release button min-height are explicitly
tested, and sign-out synchronizes the document title and focuses the login heading
or first field.

## Audit against current main

Checked against `origin/main` (baseline merge base `3a5ce28d0d58c279eff4247cb9ab3750f9716448`, current main `584821b2a32dc057024c5611e5b6ea49465254c4`) before and during implementation.

| Acceptance item | State on main and resulting change |
| --- | --- |
| Mobile title issue (docs/coord.md:226) | **Already fixed on main.** Resolved by T40/T43 route heading focus during navigation in the app shell. Verified and noted as already resolved. |
| Desk test 'labelled 44px button' asserts 44px size | **Missing assertion on main.** The test only checked `aria-label` and `type`. Added assertions checking `getComputedStyle(dismiss).width === "44px"`, `height === "44px"`, and CSS rule `width: 44px; height: 44px`. |
| Guard release button min-height | **Missing coverage on main.** No test verified `.release-btn` min-height. Added a dedicated test asserting 44px min-height in CSS rules (including the mobile `<= 900px` media query) and computed style. |
| Sign-out document title and focus | **Unmet on main.** Sign-out did not set the document title or move focus to `<inc-login>` heading/first field. Added focusable heading (`tabindex="-1"`), `focusHeadingOrField()` on mount and sign-out, and re-synchronized `titleNow()` in `showLogin()` even when `<inc-login>` is already in the DOM. |
| Tests cover both | **Covered.** Added unit and integration tests in `apps/web/test/desk.test.ts`, `apps/web/test/login.test.ts`, and `apps/web/test/views.test.ts`. |

## Verification

Required checks passed: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm typecheck`, `pnpm test`.

- `apps/web/test/desk.test.ts`: 16 tests passed, verifying 44px button sizing and release button min-height guard.
- `apps/web/test/login.test.ts`: 5 tests passed, verifying title setting, heading/field focus on first run, and title/focus re-synchronization when `showLogin()` runs with an existing element.
- `apps/web/test/views.test.ts`: shell sign-out test passes, asserting `POST /api/logout`, document title `"Sign in · i.inc"`, and focus on the login heading.
- Full web test suite: 1,455 tests passed (56 skipped).
- All workspace typechecks and biome checks pass cleanly.

## Risk and owner choices

The title and focus updates are confined to `<inc-login>` and `showLogin()`, preserving existing styling and keyboard navigation without disrupting route transitions.

Commits are local on branch `inc/21-desk-button-size-test-and-sign-out-title`; nothing was pushed or published.
This document is the prepared PR description for review and publication.
