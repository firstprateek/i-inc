# Ticket #25: ability to queue tickets

Stage: plan. No runtime changes in this commit.

## Findings

- Creating an assigned ticket and assigning an unstarted ticket already accept a busy employee.
  `apps/daemon/src/api.ts` delegates assignment to `Tickets.assign()` and then ticks the scheduler;
  there is no busy-employee rejection to remove.
- `packages/core/src/scheduler.ts` reserves one task per employee per scheduling pass. Both busy
  employees and builders holding a waiting ticket are excluded from new builds. Extra tickets stay
  unstarted and appear as Queued, with an employee-is-busy reason.
- The backlog is sorted by descending priority, then ticket creation time. Assignment time is not
  stored. An older ticket assigned later can therefore jump ahead of already assigned tickets.
- `occupancy()` frees a builder at ready, done, or failed. Waiting for the owner, a helper, or tokens
  keeps their build slot occupied, though they can help review other tickets. Pending reviews take
  precedence over new builds. The daemon ticks again after a run completes.
- Coverage already checks a second ticket waiting behind a paused builder
  (`apps/daemon/test/daemon.test.ts`) and occupancy rules (`packages/core/test/helpers.test.ts`).
  It does not fully prove a multi-ticket assignment queue draining across completion and restart.
- The web employee picker includes busy employees, and the board and ticket page already show
  Queued and a waiting explanation. A new queue screen is not necessary for this acceptance criterion.

## Proposed approach

Interpret “after all their previous tickets” as FIFO by assignment to an employee. Confirm the
ordering question below before implementation, because strict FIFO changes current priority behavior.

1. First add characterization tests for assigning to a busy employee, queue visibility, and automatic
   advancement. If these expose a lifecycle defect, demonstrate a failing regression test before fixing
   it. For the FIFO extension, first demonstrate that assigning an older ticket later currently jumps
   ahead of the employee's existing queue.
2. Persist a monotonic queue sequence for assigned, unstarted tickets, allocated transactionally.
   Assigning at creation appends; assigning an existing ticket to a different employee appends to that
   employee's queue. Repeating assignment to the same employee preserves its position. Do not reuse
   `picked_at`, which accounts for standing-order daily limits.
3. Migrate existing assigned tickets in their current scheduling order (priority, creation time,
   numeric ticket ID as a deterministic tie-breaker). Leave unassigned tickets without a queue sequence.
   Persisted order must survive daemon restarts and equal timestamps.
4. In the pure scheduler, only the first eligible assigned ticket for each employee competes for a
   new build slot. Keep priority ordering for unassigned standing-order work and preserve pending
   review precedence. A newer standing-order pickup must not bypass an employee's explicit queue.
   Preserve existing availability checks and independent progress for other employees.
5. Keep held tickets out of scheduling; releasing a hold restores their saved position. Reassignment
   removes the ticket from the old employee's queue. Started-ticket handoff continues through its
   existing path and is not redesigned here.
6. Keep the existing queued status, assignment endpoints, and waiting explanation. Do not add a new
   public ticket status, reorder controls, or UI fields unless review requires visible queue positions.
   Document the agreed ordering and completion rules in the scheduling spec.

Default completion semantics: advance at ready, done, or failed, preserving current behavior. A
ticket waiting for owner input before ready continues to block new builds. Approval, merge, and
follow-up work retain their current lifecycle; they do not reserve an idle builder indefinitely.

## Expected files

| Files | Purpose |
| --- | --- |
| `apps/daemon/src/schema.ts`, `apps/daemon/src/tickets.ts` | Queue sequence migration, allocation, assignment idempotency, and reads |
| `apps/daemon/src/daemon.ts` | Pass persisted ordering to the scheduler; adjust advancement only if regression tests expose a defect |
| `packages/core/src/scheduler.ts` | Explicit per-employee FIFO selection while preserving availability and helper rules |
| `packages/core/test/scheduler.test.ts`, `packages/core/test/helpers.test.ts` | Ordering and occupancy coverage |
| `apps/daemon/test/assign.test.ts`, `apps/daemon/test/daemon.test.ts` | Assignment API, serial advancement, persistence, and migration coverage |
| `docs/spec.md` | Agreed queue contract |

No API or UI change is expected. If existing endpoints need adjustment, scope it to
`apps/daemon/src/api.ts`. Any later UI change requires `.claude/skills/ui-review/SKILL.md`, including
rendered screenshots at desktop/mobile sizes in light/dark themes.

## Test strategy

- Use fake agents with controlled stage completion; avoid timing sleeps. Queue B and C while A is
  running, assert neither starts, finish A, then assert B starts before C and no employee overlaps work.
  Exercise both create-with-assignee and assign-existing-ticket endpoints.
- Prove assignment order differs from creation order; cover equal timestamps, same-employee
  reassignment, cross-employee reassignment, priority differences, holds and hold release.
- Confirm paused, needs-you, helper-waiting and actively reviewing employees cannot start a new
  build; confirm ready and terminal tickets release the slot, and other employees keep progressing.
- Restart over a temporary SQLite database and prove the remaining order persists; migrate legacy
  rows and confirm deterministic order without losing ticket definitions or standing-order counters.
- Preserve standing-order priority/limits, helper precedence, working hours, account blocks and caps.
- Before delivering implementation, run in order: `pnpm install --frozen-lockfile`, `pnpm check`,
  `pnpm typecheck`, `pnpm test`. For this plan commit, run the same commands as a baseline.

Baseline validation: all four commands passed on 2026-10-23. Tests: 3,172 passed, 56 skipped,
plus the host shell regressions. Biome reported two existing informational template-literal notices.

## Risks

- Strict assigned FIFO overrides the current priority-first rule. The spec explicitly requires
  priority for standing orders; keep that behavior and make the assigned-ticket change explicit.
- A waiting ticket can stall the employee's queue indefinitely. This preserves current holding rules;
  choosing to skip blocked tickets would be a separate scheduling policy.
- Existing queues have no assignment history; migration can preserve their present order but cannot
  reconstruct original assignment order.
- Queue allocation and repeated assignment must be transactional and idempotent to avoid duplicates
  or accidental movement. Do not rely only on wall-clock timestamps or in-memory queues.
- Handoffs and owner follow-ups can resume already-started tickets outside backlog selection. Verify
  compatibility without expanding this feature into a redesign of all resume paths.

## Questions for review (all together)

1. Should assigned tickets run FIFO by assignment, as proposed, even when a later ticket has higher
   priority? Or should the current priority-then-creation order remain? If current ordering is intended,
   narrow implementation to missing lifecycle coverage and any demonstrated defect; no queue migration.
2. Is reaching Report ready sufficient to start the next ticket (recommended/current behavior), or
   must the employee wait until owner approval or merge?
3. Should a ticket waiting for owner input or tokens block the queue (recommended/current behavior),
   or may later work proceed while it waits?
4. Are the existing Queued status and waiting reason enough for this ticket (recommended), or are
   visible queue positions/reordering also required?
