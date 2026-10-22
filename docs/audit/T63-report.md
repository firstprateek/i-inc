# T63: audit of the whole product

Date: 2026-10-22. Status of the fixes: the daemon and web groups below are merged except four PRs that are still in
review (#107, #109, #110 and #111); this report lists them as "in review" and is updated when they merge.

The UX review (T64) is a separate document: [T64-ux.md](T64-ux.md). It is linked here, not copied.

## Scope

Everything that runs: the pure pipeline and state machine (`packages/core`), the daemon (`apps/daemon`), the web app
and service worker (`apps/web`), the deployer, and the host scripts' security properties. The audit looked for
correctness, reliability and recovery, performance and growth, security, accessibility, layout consistency, docs
accuracy and test gaps. Commit audited: `d5cecbf` on `main` (2026-10-21).

## Method

- **Daemon and core (auditor A).** Every finding was reproduced or traced in a scratch clone, on the production runtime
  (Bun) and under the test runner (Node and Vitest), with throwaway repro tests. Performance was measured on a seeded
  database of 100 to 10,000 tickets (tick time, board and desk response time, memory). Ten critical code paths were
  mutation-checked: a line was changed, only the relevant tests were run, and a survivor means a test gap.
- **Web (auditor B).** A real browser (Playwright, Chromium) against demo and seeded daemons: a crawl of 26 routes at
  four sizes in both themes (scroll, overflow, clipped text, tap targets, contrast), an interactive-state pass, an
  accessibility-tree name audit, a keyboard walk, fault injection (daemon killed and restarted, delayed and failed
  routes), a leak run over 50 route switches, and service-worker install, offline and deploy runs.
- **Security review (the lead).** A read-through of the new work from the point of view of a prompt-injected agent,
  which found the three issues in "Security findings from the lead's review" below.
- **Docs.** Every factual claim in the spec, architecture, handoff, layout, GitHub App and design docs, the README and
  the API contracts was checked against the code on `main` and corrected where wrong or stale.

Severity: SEC (security), HIGH (data loss, outage or wrong results likely in normal use), MEDIUM, LOW.

## Verified clean

No finding in these areas: no unescaped HTML from data and no open redirects in the web app; the session cookie never
appears in a URL or `localStorage`; the service worker never caches `/api`; no leaks over 50 route switches; no
document scroll or sideways overflow on any route at any tested size; text contrast met 4.5:1 everywhere; live
updates reach an open page. Daemon memory stays flat over a simulated hour, and all hot queries other than the ones
listed below use an index.

## Findings by group

### Daemon 1. Poison pills: one bad datum took down everything. Fixed in #102

| Finding | Severity | Fix |
| --- | --- | --- |
| An agent's JSON reply (proof items, review verdict, follow-ups) was stored unchecked, and one malformed reply made the state fold throw, so the tick, the board, the desk and ticket creation all failed until someone edited the database | HIGH | Replies are schema-checked before they are stored (`packages/core/src/validate.ts`); an unusable reply fails the stage as "could not be read". The fold skips an event it cannot read |
| No per-ticket isolation in the tick; a corrupt row made the startup tick reject, the process exit, and launchd restart it forever | HIGH | Each ticket is processed in its own try; a row that is not readable is quarantined and shown as `unreadable` on the board; `tick()` never rejects |
| Deleting an engine that an employee used stopped the scheduler for everyone | HIGH | Refused with 409 while in use; where one is gone anyway the ticket fails with that reason |
| An exception outside the agent's own error path caused an endless 30-second retry loop with growing event logs | MEDIUM | Startup preconditions are inside the guarded path; a ticket that keeps throwing backs off (30 s, doubling to 10 min) and fails after five errors in a row |
| `decide` and `answer` did not validate their value (an empty body left a ticket stuck; a typo closed it as done) | LOW | 400 unless the value is in the allowed set |

Left on purpose: recording the session-start event only after the launch succeeds needs a change to the agent port;
the back-off and the cap bound the event growth instead.

### Daemon 2. Restart and crash recovery. Fixed in #103

| Finding | Severity | Fix |
| --- | --- | --- |
| A graceful stop (SIGTERM, a deploy) failed, escalated or engine-switched every in-flight ticket, so every deploy during a session damaged it | HIGH | `ShuttingDown` is thrown and swallowed with no events; the ticket stays running and the next start resumes it |
| Two employees of one team starting together overwrote each other's machine claim, and the machine was stopped under a live session | HIGH | Boot and stop are queued per machine; claims are added, not replaced; the idle sweep re-checks use right before each stop |
| A direct-mode push that landed whose record was lost made the ticket fail falsely | MEDIUM | A `push-intended` event is written before the push; on replay the host's mirror says whether it landed |
| Retry did not heal failed checks, proof or rebase conflicts, and a stuck card could not be resolved | MEDIUM | Retry and any answer reset the counters; the stuck card has a "Keep going" answer |
| A retried ticket older than the clean-up window built in an empty folder | MEDIUM | The working copy is checked before a session after an hour away, and reopened if gone |
| No database backup, no integrity check, no free-space guard | MEDIUM | Daily backup (`VACUUM INTO`, 30 days kept), a quick integrity check at startup (pushed on failure), and a low-disk gate (under 5 GB free, new work waits and says why) |
| Running sandboxes were not stopped after a daemon restart | LOW | Running machines are adopted at startup |
| Crash windows between paired events, and a follow-up created without its dedupe row | LOW | One append per transition; create and dedupe row in one transaction |

### Daemon 3. GitHub and network errors. Fixed in #99

| Finding | Severity | Fix |
| --- | --- | --- |
| A GitHub 5xx or a network blip failed the ticket at pick-up or when marking the PR ready, because the retry rule matched message text that never matched | HIGH | Classified by error type and status (5xx, rate limit, network), with the git messages added, applied to marking ready too, and `retryAfter` honoured |
| `waitForCi` took a failed rules lookup as "no required checks" and lost its progress on a poll error | MEDIUM | Only a 404 is swallowed; transient errors are retried |

### Daemon 4. Process robustness and timeouts. Fixed in #102

| Finding | Severity | Fix |
| --- | --- | --- |
| A write to a child's stdin after it exited killed the daemon (EPIPE on Bun), and nothing handled process-level errors | HIGH | Error guards on every child's stdin; handlers for unhandled rejections and uncaught exceptions that log and carry on; a catch on every background call |
| No timeout on any machine command or agent request, so one hang blocked a ticket, its builder and the deployer's drain for ever | HIGH | Limits on scripts (10 min), checks (30 min), `container` commands (5 min), agent start (2 min) and agent silence (30 min); settable through `GET`/`PUT /api/timeouts`; a timeout kills the process group and counts as stuck |
| Bun's development error page (with source excerpts) was served for any route exception | LOW | `development: false` and a JSON error handler |
| A script's result was read on `exit`, which can drop trailing output | LOW | Read on `close` |

Limit: a timeout stops the `container` CLI and its group on the host; what the script started inside the VM is not
signalled from there.

### Daemon 5. Performance and growth. Fixed in #98

| Finding | Severity | Fix |
| --- | --- | --- |
| The knowledge lookup was quadratic: a tick cost 15 s at 10,000 tickets | HIGH (a time bomb; invisible at today's volume) | An indexed lookup |
| The tick read and folded every ticket on every pass | MEDIUM | A state cache; only changed tickets are folded |
| Event text was unbounded | MEDIUM | Capped at 16 KB |
| Missing indexes; a synchronous `VACUUM` on a large database; a write per streamed chunk | LOW | Two indexes; a size cap on the synchronous vacuum; chunk writes debounced to about 250 ms |

The board and Needs you payloads (the web half of this) are in "Web 4" below.

### Daemon 6. Security and leaks

| Finding | Severity | Fix |
| --- | --- | --- |
| The owner's OK for protected paths stayed valid for the whole gates stage, so a later fix session could add a workflow file with it | SEC, MEDIUM | #103: the OK covers the paths on the card that was answered, and any other path asks again |
| Every sandbox agent held a write token for all of the App's repos | SEC | See "Security findings" (T68, #104) |
| Unredacted, uncapped agent error text reached events and logs | LOW | #103: redacted and capped at 500 characters |
| A protected path without a trailing slash matched only the exact file | LOW | #103: matches the path and everything under it |
| A default branch containing `/` broke every branch script | LOW | #103: scripts accept any valid ref name; the project form refuses the rest |

### Daemon 7. Correctness. Fixed in #101, with a follow-up in review (#110)

| Finding | Severity | Fix |
| --- | --- | --- |
| In owner-merges mode "Approve" never merged and "Reject" never closed the PR, so "merged" meant only "the owner clicked" | MEDIUM | #101: merged is recorded only when GitHub says the PR is merged; Reject closes the PR. **In review (#110):** the owner merges on GitHub, the ticket shows "Merge on GitHub" and "Close without merging", the daemon watches the PR about every 5 minutes and closes the ticket by itself when it is merged, and Approve is refused while the PR is open |
| Clock handling: a future-dated release hid later ones, `workedMs` could go negative, back-off used wall time, budgets used UTC days | LOW | #101: a monotonic clock for back-off, non-negative durations, local-day budgets, and red main reverted only after the builder had a chance to fix it |
| Stale snapshot across awaits; an owner action waited for the next tick | LOW | #101: the helper assignment re-reads the ticket; an owner action re-runs the ticket at once |
| After the second rejected review round nothing re-reviews the fixes | LOW | Left as designed (the report says so) |

### Daemon 8. Test gaps. Fixed in #101 (and in the test files of the PRs above)

The mutation check found five paths where a changed line left every test green: knowledge idempotency, `--force-with-lease`
(a human's concurrent push), tick coalescing, the scheduler's "a waiting builder is not another's reviewer", and "a busy
employee's machine is not stopped". Each now has a test that fails with the mutation. The behaviours with no test at all
(graceful stop, concurrent boot, replay after a landed push, retry that does real work, upstream errors, malformed agent
JSON, engine delete, a poison row at startup, stdin errors, timeouts) got tests with their fixes in #99, #102 and #103,
and #98 counts queries instead of timing.

### Web 1. First run and sessions. Fixed in #96

| Finding | Severity | Fix |
| --- | --- | --- |
| The first visitor to a fresh daemon (anyone on the tailnet) could create the owner account and received the daemon token as their cookie | SEC | A one-time setup code (logged, written to a 0600 file, deleted once the owner exists, limited guesses, replaced after repeated failures); the daemon token also works in its place. A loopback-only rule was rejected because the Tailscale proxy makes every visitor look local |
| Sign-out only expired the cookie; a copied cookie (the static token) worked for a year | SEC, LOW | Every login is a random session stored hashed and revocable; open sockets close with their session; limits on wrong logins; `Secure` over HTTPS |
| The login screen kept the previous page's title | LOW | The title says "Sign in" or "Create owner account"; the brand mark and a show-password box are in #111 |

### Web 2. Views survive failures. Fixed in #100

| Finding | Severity | Fix |
| --- | --- | --- |
| The first failed request, even a background one, unmounted the view and wiped what was typed (a half-filled Hire form came back empty after a short outage) | HIGH | The view stays mounted; a banner says the daemon cannot be reached and a retry is offered; all views refetch when it returns |
| A malformed link (`%E0%A4%A`) left a blank page | MEDIUM | Safe decoding, and the router falls back home |
| The ticket page showed the previous ticket under the new heading | MEDIUM | Cleared the moment the ticket changes |
| Out-of-order answers could leave the board without a ticket | MEDIUM | Stale answers are dropped |
| A failed action replaced the whole list with one error line; double clicks sent two requests; Brain "Revert" had no confirmation | MEDIUM | One press at a time, the error shown above the data, a confirmation on Revert |
| New-ticket text and project edits were lost on reload | LOW | Kept like chat drafts (new ticket in #100, project edits in #97) |

### Web 3. Dead ends and unsafe config. Fixed in #97

| Finding | Severity | Fix |
| --- | --- | --- |
| "Add an engine" or "Add an account" silently replaced an existing one with the same id and said "Added" | HIGH | The form refuses and keeps what was typed; the PUT is create-only with `If-None-Match: *` (412, contract C24) |
| "Getting started" sent the owner to the old chat and never completed | MEDIUM | Links to the new conversation form and completes from the conversations list |
| Settings → Teams could not create a team although two screens said to | MEDIUM | Teams can be created, resized and given people, following the PA's own-team rule |
| Back from a sent first message returned to the empty draft and could start a second conversation; the open Brain page was not in the address; raw daemon strings | LOW | The first message replaces the draft address; the Brain page is in the URL; plain not-found states |

### Web 4. Request budget and static serving. In review (#109 and #107)

| Finding | Severity | Status |
| --- | --- | --- |
| Opening the board with 1,000 tickets cost 16 requests and 2.6 MB, and each ticket event 9 requests and 1.3 MB; the board had no cap; background tabs kept refetching | HIGH | **In review (#109):** a summary endpoint with paged columns, one card per event, one shared Needs you request, and hidden tabs catching up on show. Measured there: 24 requests and 2.4 MB to 6 requests and 53 KB |
| Static files were served raw, uncompressed and uncached (a 558 KB bundle on every visit); missing assets answered 200 | MEDIUM | **In review (#107):** brotli and gzip, immutable caching for hashed files, 404 for a missing asset |
| Google Fonts blocked first paint and leaked the owner's address | MEDIUM | **In review (#107):** self-hosted fonts |
| One 558 KB chunk loaded for every route | LOW | **In review (#107):** one chunk per screen group |
| A 300 KB markdown table in a conversation made 353,000 DOM nodes | LOW | Left: a rare input; it needs a row cap or virtual rows |

### Web 5 to 8. Accessibility, layout, PWA and hardening. In review (#111)

Accessibility (duties without names, 1.6:1 control borders, placeholders at 4.44:1, no reduced-motion rule, tab bar
semantics, no skip link, 1,000 Tab stops on a large board, iOS zoom and small targets), the header-position rule,
service-worker gaps (no `pushsubscriptionchange`, wrong window focused, a 206 response cached, no update notice, no
install prompt) and unchecked link schemes are all in #111. Its CSP and `nosniff` headers for the app shell are part
of #107. The truncated line on the old new-conversation form disappeared with the redesign in #105.

### Docs accuracy. Fixed in the PR that adds this report

Found and corrected: a README and spec that said "design, nothing is built", a CLAUDE.md that said the daemon only
ran in demo mode, a trust boundary and credential model that were out of date, a "known gap" for shared Unix users
that is now a decision, approval and merge wording that predates the PR watch, the old view names (Office, My desk,
Chat, Setup), stale paths and statuses in the handoff and contracts, a missing contract for the timeouts settings,
and claims about agents asking questions, agent teams, and MCP and skills. Those are now marked as future work.

## Security findings from the lead's review

| Finding | Severity | Decision and fix |
| --- | --- | --- |
| **Sandbox write token (T68).** Every sandbox was signed in to GitHub with a write token for every repo the App could reach, and the bot may push to `main` in direct mode. A prompt-injected agent could put code on `main` around review, and the deployer would then run it on the host. Automatic deploys were paused until this was fixed | SEC, HIGH | #104. Sandboxes hold only a read-only, repo-scoped token (none if a session needs none). Every push is made on the host from a verified bundle of exactly the checked sha, scanned for credentials, with the write token held only in the daemon's memory. In the repo the mini runs, any change to host-executed code waits for the owner's one-tap OK, bound to the exact sha and the patch-id of the diff. The deployer deploys only ledgered, owner-approved commits, commits of a PR the owner merged, or docs-only commits, and skips anything else and alerts the owner. Direct mode still runs its checks and review in the builder's own sandbox, so against a poisoned agent they are advisory; the guard above is what protects the host. Deploys resumed |
| **Personal assistant egress gap (T66).** The spec said a PA's sandbox reaches only Ollama, but the walls gave every sandbox the open internet | SEC, HIGH | #94. The walls are closed unless opened: only declared machines get the internet and DNS, and the daemon fails closed. The PA gets its own home team and sandbox with no root (its sudo is removed before every launch), and the Ollama relay became an allowlisting proxy |
| **Shared Unix user (T67).** All employees of a team run as one Unix user, so an agent can read and change a teammate's working copies and brain copy | MEDIUM | Decided against changing it. Agents need root, and root reads every user's files, so per-employee users would isolate nothing unless root went, which breaks normal work; a machine per employee would reverse the sandbox-per-team decision. The team is the trust boundary. What must not be shared isn't: the PA has its own sandbox, brain edits made while a teammate's session overlapped are marked untrusted (T58, #95), and no write credential is in any sandbox |

Left open, deliberately: **machine-to-machine isolation on the bridge is not verified.** Traffic between two sandboxes may
be switched without meeting the firewall. `tools/m1/walls-test.sh` with `OTHER_MACHINE` tests it, and it has not passed on
the mini yet, so no document claims that a PA's sandbox cannot talk to another machine.

## In review at the time of writing

| PR | What | Findings it closes |
| --- | --- | --- |
| #107 | Compressed, cached static serving; self-hosted fonts; split bundle; CSP | Web 4 (static serving), Web 8 |
| #109 | The board opens on a summary and updates one card per event | Web 4 (request budget) |
| #110 | Owner-merges tickets close when the PR is merged on GitHub | Daemon 7.1 follow-up |
| #111 | Accessibility, header rule, service worker and install, safe links | Web 5 to 8 |

## Related

- UX review (T64): [T64-ux.md](T64-ux.md), fixed in #105 and #106.
- Open the session (T69, #108) and the brain's writing (T58, #95) landed in the same period and are described in
  [architecture.md](../architecture.md) and [handoff.md](../handoff.md).
