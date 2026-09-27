# i.inc — spec

i.inc is a personal company of AI engineers. You hire agent employees, each with its own machine
and a brain that grows. You hand them tickets on a board, and you get back pull requests that
have already been checked, reviewed and proven. You decide what gets built and what ships, and
they do the work, even while your laptop is closed.

The company can also have a **Personal Assistant**: an employee that works on your life rather than
your repos. It triages your email, drafts replies, proposes calendar changes and researches things
like flights, using only local models, and nothing it prepares leaves the house until you approve
it (§7).

This is the v1 spec and it is still a draft. It is the source of truth for behavior, words and
safety. "You" always means the owner, the one person who runs the company.

**Status:** design (M0). Nothing is built yet.

## 1. Why

Agents can now do most of the work on your projects. Getting that work shipped still costs too
much of your attention, only happens while you're at your laptop, and wastes subscriptions you
already pay for.

1. **Your attention is the bottleneck, not the agents' speed.** Every session needs you partway
   through, for a permission, a question, or "is this what you meant?". With three sessions running
   you become a switchboard operator, and nothing tells you which one is waiting.
2. **Reviewing takes longer than writing.** An agent makes a PR in 30 minutes, and judging it takes an
   hour: you read the diff, run it, check the screen and guess what wasn't tested. Agents say "done"
   when it isn't. A model that reviews its own work has the same blind spots it had when it wrote it.
3. **You pay for capacity you don't use, then run out when you need it.** Subscription limits reset
   on their own schedule, whether you're asleep or at work. Then they run out partway through a task.
   Meanwhile local models sit idle.
4. **Work stops when the laptop closes.** From your phone you can't see what's running, answer a
   question or approve a result.
5. **You have many projects and no single place for them.** Ideas and bugs for Duet, fintrack, listy
   and the website live in your head or in scattered issues.
6. **Shipping and learning are manual.** You release each repo by hand, and which agent is good at what
   is gut feel.

**Goal:** ship more across your projects each week, spending fewer of your own minutes per merged
PR, for the same monthly spend. Also track the first-pass approval rate and how much of each
subscription gets used.

**Not in scope:**

- agents choosing the work (you do, or your standing orders do);
- teams;
- editing code yourself;
- activity for its own sake.

i.inc takes you out of the doing and keeps you in the deciding: what to work on, answers to
questions, and approvals.

## 2. Use cases

| When you… | you want to… | v1 |
| --- | --- | --- |
| spot a bug or have an idea, anywhere | capture it in 20 seconds (text, voice or a screenshot) and get a proper ticket back | ✓ |
| have a clear fix, feature or chore | hand it to an employee at an effort level and get back a PR that is already checked, reviewed and proven | ✓ |
| are interrupted by an employee | answer from your phone in one tap | ✓ |
| have finished work to look at | decide in two minutes from a one-page report, opening the diff only if you want to | ✓ |
| are heading to bed | queue a batch that runs within your limits, and wake up to reports | ✓ |
| plan your week | see every project's queue, who is working on what, who is out of tokens, and what is ready | ✓ |
| have approved changes piling up | release with one approval | ✓ |
| want the team to grow | hire, configure, re-engine or retire employees whenever you like | ✓ |
| want to know what the team is up to | glance at the office to see who is doing what, and at the board for where the work stands | ✓ |
| want to talk to one employee | chat with it: ask why, add context, or ask for something new | ✓ |
| have a full inbox | wake up to it triaged, with draft replies waiting for your review | ✓, after the GitHub loop |
| need a calendar change or a trip | ask your PA, and approve the event or pick from a flight shortlist | ✓, after the GitHub loop |
| have a question rather than a change | get a research report with no PR | later |
| assign work | know who is best at this kind of ticket from their track record | later |
| have GitHub issues or Dependabot PRs | pull them into To do | later |

## 3. Design cases

Each case is a short story followed by the rule it sets for the design.

1. **The bug from the couch.** At 9:40 pm you notice Duet counts refunds as spending.
   - On your phone you tap New and add one line and a screenshot.
   - Mia, a Product Manager, sharpens it into a ticket with done-when criteria ("August drops by the
     refund, and a test covers it") and one question: lower the total, or hide refunds?
   - You tap an answer and assign the ticket to Ada, a Senior Engineer, at Medium effort.
   - 45 minutes later you get: "Ready · checks pass · reviewed by Grace, 1 round", with before and
     after screenshots of August. You approve it.
   - On Friday the Release card lists four changes. You approve it, and Duet 0.1.1 ships.

   → *Capturing work and approving it each take under a minute on a phone.*
2. **The night shift.** At 11 pm on Sunday you queue six tickets across three projects. Ada's account
   resets at 1 am, so her ticket waits, while Kit and a local employee start straight away.
   - When you check at 7:30 on Monday, four tickets are ready.
   - One plan is waiting for you because it wants a schema change.
   - One ticket didn't make it: CI was flaky, and there's a note of what was tried.

   Going through all of it takes fifteen minutes over coffee.
   → *Capacity is visible and scheduled. A failure comes back as a report, never as a silent retry.*
3. **An employee needs you.** Juno is setting up a deploy workflow for the website and needs a token
   added as a repo secret. That is a privileged request: the card names the exact action, you paste
   the token once, and i.inc stores it. A question works the same way, with suggested answers and a
   text box.
   → *Every interruption carries its context and takes one tap. Questions are asked at the plan
   stage, not one at a time.*
4. **The employees disagree.** Grace's review says Ada's cache goes stale after a sync, and Ada
   disagrees. After two rounds the ticket goes to Needs you, with each side summarized in three lines
   and a link to the code. You pick a side, or ask for a test that settles it.
   → *Review loops have a limit, and open disagreements reach you already summarized.*
5. **"Not quite."** The screenshot shows a button in the wrong place. You type "move it to the toolbar".
   The same employee fixes it on the same branch, and the new report covers only what changed.
   → *Follow-ups are cheap.*
6. **Stuck, then revived.** Kit fails the checks on a CSV import three times. Kit's switch rule moves
   Kit from Claude Sonnet to Gemini 3 Pro for the rest of the stage, and Gemini picks up from the
   same branch, plan and notes. The report says "started on Claude Sonnet, finished on Gemini 3 Pro".
   → *An employee is its memory; its engine can be swapped.*
7. **Hiring.** You hire Juno as a UX Designer and set:
   - the engine: Gemini Flash on your Google AI Pro account;
   - the projects: listy and the website;
   - the working hours: nights only.

   i.inc builds Juno's machine, and Juno's first ticket is orientation: reading the handbook and
   each project's `CLAUDE.md`, then writing project pages in its brain.
   → *The team is yours to build. Nothing is preset.*
8. **Monday planning.** At your desk you see every project, a live status line on each running card,
   and the office. The office shows who is working, who is out of tokens until when, each account's
   windows, and each employee's record, such as "8 of 10 UI tickets approved first time".
   → *The office is for a glance, the board is for planning, and the phone is for deciding.*
9. **A word with Kit.** Kit's report on the CSV import says dates are parsed as US format. You open
   Kit's chat and ask why. Kit answers from its plan and notes: the sample files were all US. You
   type "also accept ISO dates". That's new work, so it arrives as a draft ticket in the chat, and
   one tap puts it on the board.
   → *Chat is for talking. Work still flows through tickets, so the board stays true.*
10. **The PA's morning.** At 7 am Pip, your PA on a local qwen model, triages the night's email:
    - 2 draft replies wait for your review;
    - the dentist's reschedule becomes a proposed calendar change;
    - 14 newsletters are summarized in five lines.

    You fix one word in a draft and tap Send. Later you ask Pip for flights to Bengaluru in December.
    Pip writes a brief with the route, the dates and your seat preference, and a separate web errand
    with no access to your mail comes back with a shortlist of four. You book one yourself.
    → *Your mail stays on local models, and what leaves the house goes through you, as far as you
    choose.*

## 4. Principles

1. **Employees, not sessions or models.** An employee is its brain, role and track record. Its
   machine can be rebuilt and its engine (harness + model + account) can be swapped, but its memories
   are kept.
2. **You build the team.** i.inc starts with no employees and makes no assumptions about
   subscriptions. You hire, configure, pause and retire employees, and add accounts, in any number.
3. **Walls around the machine, not rules on each command.** Inside its VM an employee may do anything,
   with no permission prompts, and it has the open internet. Safety comes from four things:
   - the VM boundary;
   - keeping employees off your home network and tailnet;
   - a bot GitHub identity;
   - one-tap requests for actions that need your own credentials.

   A PA's walls are tighter, because it handles your private data: no internet, local engines only,
   and no credentials (§7).
4. **Code runs the company; agents do the work.** A deterministic state machine schedules,
   checkpoints and escalates. No agent spends tokens coordinating others, and nobody works without a
   ticket, so there are no heartbeats.
5. **Every stage can be resumed, by any engine.** A quota pause, a crash, a reboot or an engine switch
   costs minutes, not the ticket.
6. **You decide; they do.** You assign the work, unless you've given an employee a standing order. You
   answer questions and approve results. Everything else runs without you.
7. **Your private data stays home, and nothing leaves without you.** Home data (mail, calendar,
   contacts) is processed only by local engines. Anything that goes out in your name (a sent email,
   an accepted invite, a merge) waits for your approval, unless you've allowed that kind of action
   with an outbound permission (§7).

## 5. Employees

### What you set when hiring

Everything here can be edited later.

| Setting | For example |
| --- | --- |
| Name, avatar | "Ada", a picture |
| Role | Its identity: Senior Engineer by default, or Staff or Principal Engineer, Product Manager, UX Designer, QA, or a role you write yourself. Each role is an editable system prompt with default duties |
| Engine | harness + model + account: Claude Code · Opus · "Claude Pro"; Gemini CLI · 3 Pro · "Google AI Pro"; OpenCode · qwen3 · "Local" |
| Fallback engines and switch rules | See "Engines and switching" below |
| Usage caps | Per ticket, per day and per week. Tokens where the harness reports them; otherwise a share of the account's window, or hours |
| Defaults | Effort level, and a review preference (for example, prefer a reviewer from another vendor) |
| Machine | CPUs, memory, disk |
| Projects | The repos it may work on, or Home for a PA |
| Outbound permissions | For a PA: which kinds of outgoing action need your approval and which it may do by itself (§7) |
| Standing orders | Tickets it may pick up by itself, e.g. "`chore` tickets labeled `deps`, at most 5 a day" |
| Working hours | For example, nights only |

Presets such as "Senior Engineer on Claude" or "Product Manager on Gemini" make hiring quick, but
nothing exists until you hire it.

### Roles and duties

A **role** is who the employee is. A **duty** is what a stage asks it to do: build, plan, review,
verify, draft tickets or design. The stage's instructions sit on top of the role's system prompt, so
a Staff Engineer reviews like a staff engineer. Each role comes with default duties, which you can
change.

| Role | Default duties |
| --- | --- |
| Senior Engineer | Build, review, verify |
| Staff or Principal Engineer | Plan and architecture review (clearing plan gates before they reach you, if you allow it), reviewing risky changes, design docs |
| Product Manager | Sharpening tickets and writing done-when criteria; breaking big ideas into draft tickets, which wait for you; checking results against done-when |
| UX Designer | Design tickets (mockups, flows); UX review of UI changes from the screenshots |
| QA | Verifying (the Prove stage); writing missing tests |
| Personal Assistant | Triaging mail, drafting replies, proposing calendar changes, research errands such as flights (§7) |

### Accounts

You add accounts separately, in any number: Claude Pro or Max, Google AI Pro or Ultra, API keys,
and local Ollama.

- i.inc assumes nothing about how large an account is. It learns each account's windows from what
  the harnesses report.
- When an account runs out, the work pauses. Running out early on is expected and fine.
- Two employees on the same account share its limits.

### Hiring

Once you've made the choices above, i.inc:

1. builds the machine from the base image;
2. clones the projects;
3. creates the brain from a template;
4. if the account is new, shows a sign-in link on your phone.

The employee's first ticket is orientation. It reads the handbook and each project's `CLAUDE.md`,
then writes project pages in its brain.

### Engines and switching: identity is memory

Every machine has all the harnesses installed: Claude Code, Gemini CLI and OpenCode, each with its
ACP adapter. The engine chosen for a session decides which harness runs and which account's
credential i.inc injects.

Switch rules are set per employee:

| Trigger | Rule |
| --- | --- |
| Out of tokens | Wait for the reset (the default), or move to a fallback engine, for example after waiting 30 minutes |
| Stuck | For example: checks failed 3 times, the same error twice, no progress for 20 minutes, review rounds used up, or the agent says it's stuck. Move to a stronger or different engine for the rest of the stage |
| Usage cap reached | Stop, or continue on a cheaper engine such as the local model |
| By hand | Swap the engine at any time to revive the employee |

A switch keeps the brain, the role, the machine, the worktree and branch, and the stage artifacts.
The new session starts with a resume brief, so the only thing lost is the old session's in-context
memory.

Switches are visible: the card and the report say, for example, "started on Claude Sonnet, finished
on Gemini 3 Pro after 3 failed checks". Track records are kept per engine, so you learn which engine
suits which role.

### Lenient permissions, hard walls

- **Inside the machine** the harness runs in its bypass mode: Claude Code bypassPermissions, Gemini
  CLI yolo, OpenCode allow-all. i.inc's ACP client also approves any permission request. The
  employee can install anything, run servers, and use Docker if nested virtualization works.
- **Network:**
  - The employee has open outbound internet: packages, docs, web search, GitHub and model APIs. A
    PA is the exception: it has no internet at all (§7).
  - It can't reach your LAN, your tailnet, or other services on the host. The exceptions are i.inc's
    API and Ollama.
  - Nothing can connect in from outside.
  - The host firewall (`pf` on the Mac mini) enforces this, and the domains each employee contacts
    are logged.
- **GitHub** uses a bot identity: one GitHub App, "i.inc", installed on the repos you choose.
  - For each session it mints a 1-hour token. The token can push branches, open and update PRs, edit
    CI/CD workflows, run Actions, and manage issues and Pages.
  - Commits read as "Ada (i.inc)".
  - A ruleset on `main` requires a PR and your approval, so GitHub itself enforces that only you
    merge. Your Approve does the merge with your account.
- **Privileged requests.** Sometimes an employee needs something beyond its powers, such as a deploy
  secret, a repo setting or a new repo. It then files a Needs you card naming the exact action. You
  tap Approve, and i.inc does it with your account. This way employees can still set up CI/CD from
  start to finish.
- **Audit:** every tool call in the ACP stream is logged, so you audit afterwards instead of approving
  beforehand.

### The brain

The brain follows the conventions of the owner's own LLM wiki:

- It has an `INDEX.md` map, with pages under `tools/`, `patterns/`, `projects/` and `reference/`.
- It is written only at task boundaries, and only with facts that are durable, non-obvious and
  reusable.
- It is committed after each edit.
- It is plain markdown, so any engine can load it through its global memory file
  (`~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, `AGENTS.md`).
- It lives in git, outside the machine, so rebuilding the machine never loses it.

Knowledge is routed by scope:

- A fact about one project goes into that repo's `CLAUDE.md`, in the PR.
- A lesson that holds across projects becomes a proposal for the **company handbook**, a shared,
  curated wiki whose changes you approve.
- The employee's own working lessons go into its brain.

Your review feedback is the richest material for learning. A Reviewer learns what you care about
from your Request changes notes, so over time it catches what you would have caught. You can read,
diff or revert what any employee learned.

## 6. The In progress loop

| Stage | Who | What | Exits when |
| --- | --- | --- | --- |
| 1. Pick up | daemon | Waits until the employee is free and its account has headroom. Makes a worktree and branch `inc/<id>-<slug>` and opens a **draft PR**, so CI runs early | the brief is sent |
| 2. Plan | builder | Explores, then writes the approach, files, test strategy, risks and **all its questions at once**. For a fix, it first writes a failing test that reproduces the bug | the plan is saved. On High effort, or when the plan touches the schema, auth, public API, dependencies or CI, the gate waits for you, or for a Staff or Principal Engineer if you've allowed that |
| 3. Build | builder | Small commits, with WIP pushed as checkpoints | the builder says done |
| 4. Checks | harness | The project recipe: install, build, lint, typecheck, tests | green, or ≤3 fix attempts, then a switch rule or an honest failure |
| 5. Prove | a fresh session with the verify duty (e.g. QA) | A black-box check of each done-when item against the running app. Screenshots come from Playwright on the web build, plus test and CLI output, all stored by the harness | every item ✓ with evidence, or ✗ with a reason |
| 6. Review | another employee with the review duty (same vendor is fine), plus a UX Designer when the UI changed, if you have one | Checks out the branch **in its own machine** and runs it. Returns findings marked blocking, should-fix or nit, each with file:line, and checks the builder's claims against the diff | a verdict |
| 7. Address | builder | Fixes each finding or replies with why not. Then back to 4, to 5 if the UI changed, and a re-review of **only the changes** | approved, or out of rounds, which goes to you with both sides |
| 8. Final gates | harness | Rebase on the latest `main`, full checks, GitHub CI green, every done-when ✓, a secret scan, diff-size and protected-path checks | all pass |
| 9. Report | the builder drafts, the reviewer confirms, the harness fills in the facts | The one-page report becomes the PR body; the PR is marked ready, the ticket moves to Review, and you get a push notification | — |
| 10. Your decision | you | Approve (the ruleset approval, then a squash-merge with a conventional title, then Release Please), Request changes (back to 7 with your note first), or Reject | — |
| 11. Retro | builder and reviewer | 0–2 brain edits each, optional handbook proposals, track records updated | — |

**Effort sets how far the loop goes.**

| Effort | Stages | Review rounds | Gate |
| --- | --- | --- | --- |
| Low | 1, 3, 4, 8, 9 | 0 | — |
| Medium | all | 1 | only on risky areas |
| High | all, with a fresh verifier on a different model | 2 | always |

**Non-code tickets** go through the same loop with a different recipe. A spec comes from a Product
Manager, a design from a UX Designer, and an architecture doc from a Principal Engineer. The
deliverable is a doc or mockups in a PR, the checks are lighter, and someone in a fitting role
reviews it.

**Why the loop is thorough:**

- For fixes, a failing test comes first.
- A verifier with fresh context tests against done-when without seeing the builder's reasoning.
- The reviewer is a different employee with its own role, brain and machine, and it runs the code
  itself.
- The deterministic gates include real CI.
- The branch is rebased and checked again at the end.
- A failure comes back as an honest report.

**Why the loop is cheap:**

- Deterministic checks run before any LLM.
- Each stage uses the cheapest engine that can do it.
- Re-reviews look only at what changed.
- Machines stay warm, and their caches persist.
- CI runs on the draft PR while the review happens.
- Questions are asked at the plan stage, before an hour of building.
- Scheduling takes quotas and usage caps into account.

**Assignment and scheduling:**

- You assign tickets by default. An unassigned ticket that matches an employee's standing order is
  picked up in priority order when that employee is free and has tokens. Mark a ticket Hold to keep
  it for yourself.
- Each employee does one thing at a time.
- A pending review goes ahead of starting a new build.
- The reviewer is never the builder. A reviewer from another vendor is optional.
- A paused ticket can be handed to another employee, using its branch, plan and progress notes.

## 7. The Personal Assistant

A PA is an employee like any other: it has a name, a role, a brain, a machine, standing orders and
working hours. What's different is its work and its walls. It works on **Home**, your personal life,
instead of a repo, and it handles your most private data. It arrives in v1, after the GitHub loop
is right (§14).

### Errands

An **errand** is a ticket kind for a PA. It flows over the same board, in its own Home lane, through a
shorter loop:

| Stage | What | Exits when |
| --- | --- | --- |
| 1. Pick up | Waits until the PA is free and the local engine has room | the brief is sent |
| 2. Work | Reads what it needs through the home tools and prepares its proposals | the PA says done |
| 3. Proposals | Each outgoing action becomes a proposal: a draft reply, a calendar change, a shortlist, an answer | all proposals are filed |
| 4. Your decision | Approve, edit then approve, or reject each proposal. Approved actions are carried out by i.inc with your account | — |
| 5. Retro | 0–2 brain edits, such as "prefers aisle seats" or "replies to the school the same day" | — |

- **Standing orders can run on a schedule**, for example "7 am: triage my inbox" or "Sunday 6 pm:
  plan the week". The daemon creates the errand at that time, so there are still no heartbeats.
- **Chat is the PA's main door.** A request in the PA's chat becomes an errand straight away, with
  no confirm tap, and it shows on the board.
- **What a PA produces:** draft replies, triage summaries, proposed calendar events and changes,
  shortlists (flights, hotels, products), and answers to personal questions.

### Home data stays home

- **Local engines only.** Home data (mail, calendar, contacts and anything taken from them) is
  processed only by local engines, such as qwen on Ollama. i.inc refuses to give a PA a cloud engine,
  and its switch rules can only wait or move to another local engine, never to a cloud one.
- **The PA never holds your credentials.** The daemon keeps the Google (or other) tokens and offers
  the PA a small set of **home tools**: search mail, read a thread, create a draft, propose an event,
  read free/busy, and file a web errand. Every call is logged.
- **No open internet.** Unlike an engineer's machine, a PA's machine reaches only i.inc's API and
  Ollama. Whatever it prepares can only leave through a proposal you see.
- **Web work is split off.** A flight search needs the internet but not your mail. The PA files a
  **web errand** with a structured brief (for example: from, to, dates, cabin, preferences). A fresh,
  throwaway session with open internet and no home data runs it, on any engine, and returns the
  results. Briefs are logged, and you can ask to approve each one before it runs.
- **The PA's brain stays home too.** It holds personal facts, so it lives only on the host (with
  local backups) and is never pushed to GitHub.

### Outbound permissions

Each kind of outgoing action has a setting, which you can tune per PA:

| Setting | Meaning |
| --- | --- |
| Ask (the default) | It waits in your inbox as a proposal, and one tap carries it out |
| Allowed within a rule | It goes out by itself when the rule matches, e.g. "accept invites from people in my contacts that fit free time" or "add holds to my own calendar that invite no one" |
| Off | The PA can't even propose it |

- Every action starts as Ask. Loosening one is an explicit choice in settings, and the office
  shows which permissions are loosened.
- Anything done under a rule shows up afterwards in the PA's chat and in the audit log, and can be
  undone where the provider allows it.
- **Never automatic**, whatever the settings: payments and bookings, deleting mail, sending to an
  address that isn't in your contacts, forwarding, sharing files, and changing account settings.
  These are always proposals, or things you do yourself.

## 8. Status at a glance

**Employee states:**

- **Idle**
- **Working**: the ticket, the stage and a live line, such as "tests: 3 failing"
- **Reviewing**
- **Needs you**: a question, a gate, a disagreement, a privileged request, or a sign-in to redo
- **Out of tokens**: when its account resets, which ticket resumes then, or which fallback engine it
  switched to
- **Cap reached**: its own usage cap was hit, and when that cap resets
- **Blocked**: the machine is down, the disk is full or the provider has an outage, plus the fix
- **Done**: a report is waiting for you
- **Off**: outside working hours, or paused or retired by you

**Accounts and token windows:**

- **Claude:** Claude Code emits a `rate_limit_event` on its stream. It carries the status (allowed,
  warning or rejected) and `resetsAt` for the 5-hour and weekly windows. We still have to confirm it
  passes through the ACP adapter; the fallback is to read the reset time from the "limit reached"
  error.
- **Gemini:** 429 / RESOURCE_EXHAUSTED errors, and the daily reset.
- **Local:** busy or idle.

"Out of tokens" is shown but doesn't send a push notification. Pushes go out only for Needs you,
Done and Blocked.

A data sketch of the office (not the design):

```
Accounts  Claude Pro     ■■■■■■■■■■ limit reached · resets 3:40 pm (in 1 h 12 m)
          Google AI Pro  ■■■□□□□□□□ 31% of today · resets at midnight
          Local          busy (1 of 1)

Ada    Senior Eng · Claude Opus   ◌ Out of tokens  #16 Budget alerts · Duet   waiting · resumes 3:40 pm
Kit    Senior Eng · Gemini 3 Pro  ● Working        #18 CSV import · fintrack  switched from Claude Sonnet (out of tokens)
Grace  Staff Eng · Gemini 3 Pro   ● Reviewing      #12 Export video · listy   round 2 · 11 min
Mia    PM · Gemini Flash          ▲ Needs you      #19 Budget alerts spec     3 draft tickets to approve
Qwen   Senior Eng · Local qwen3   ✓ Done           #11 Bump deps · fintrack   report ready for you
```

## 9. Robust, and able to scale

- **Durable state:** tickets, stages, employees and accounts live in SQLite as an append-only event
  log. The daemon is a LaunchAgent and the machines persist, so after a crash or reboot everything
  resumes where it was.
- **Checkpoints:** every stage ends with a pushed commit and a saved artifact (the plan, the review,
  the proof). Resuming, on the same engine or another, starts a fresh ACP session with a resume brief
  (ticket, plan, progress, git log, last error). Where the agent supports it, `session/load` is used
  instead.
- **Every kind of failure has a policy:**

  | Failure | What happens |
  | --- | --- |
  | Transient | Retry with backoff |
  | Quota or cap | Pause, or switch engine by rule |
  | Stuck | Switch engine by rule, then escalate |
  | Sign-in | Needs you |
  | Machine | Restart it and resume |
  | Logical | Bounded attempts, then an honest report |
  | Silent | No ACP activity for N minutes: cancel, resume once, then escalate |

- **No fixed team size.** Machines sleep when idle and wake when work arrives. Each host runs at most
  K machines at once, and the rest wait in the queue. K is a host setting that defaults to what the
  host's RAM allows. More hosts, such as a Mac Studio or cloud VMs, raise K.
- **Machines can be rebuilt; brains are kept.** There's a reset button and a nightly base-image
  update. Brains and the handbook are git repos with backups.
- **Audit:** every stage keeps its full transcript, each ticket has a timeline, and brain changes are
  commits.
- **Tests:** a scripted fake ACP agent and a fake machine provider cover these cases, and the tests run
  on Linux:
  - the happy path;
  - a quota pause;
  - an engine switch partway through a stage;
  - a review deadlock;
  - flaky checks;
  - a daemon crash;
  - a rebase conflict.
- **Room to grow:**
  - Stages are data, set per project and effort.
  - Machine hosts plug in: the mini, then a Mac Studio, then cloud VMs, with macOS VMs later.
  - Harnesses plug in: any ACP agent.
  - Notifications plug in: Web Push, then native push.
  - A weekly company report shows what shipped, the first-pass approval rate, your minutes, and usage
    per account and engine.

## 10. Views, report, phone and design

There are three main views. Each answers a different question, and each is a way into the others.

- **Office:** who is doing what, right now? It's the desktop home. Each employee has a desk and an
  avatar, and its monitor shows the live status line. Out of tokens reads as a coffee break ("back
  at 3:40 pm"), off hours as an empty desk, and Needs you as a raised hand. The account meters sit
  beside the floor.
- **Board:** where does all the work stand? To do → In progress → Review → Done, plus a Needs you badge.
  It spans all your projects and Home, and each card has a stage strip. Cards move themselves; you press
  buttons.
- **Chat:** one thread per employee, for talking one to one.
  - Questions ("why this approach?") are answered from the employee's brain, its tickets and notes,
    in a short session that counts against its usage.
  - Asks for new work become a draft ticket in the chat, and one tap puts it on the board. For a PA,
    an ask becomes an errand straight away (§7).
  - A message to an employee in the middle of a ticket reaches it at the next stage boundary, or
    right away if you mark it urgent.
  - Everything that needs you also appears in that employee's chat. Answering in the chat or in the
    inbox resolves both.
- **Report:** it fits on one phone screen and is also the PR description.
  - The harness supplies the facts: checks, what the change touches, dependencies, schema, proof,
    engines used, time and usage.
  - The agents supply the judgment: what changed, why, risk, your call, and the reviewer's view.
  - The reviewer checks the builder's claims against the diff.

  ```
  [fix] Refunds are counted as spending · Duet · PR #42
  ✓ tests 212/212 · lint · typecheck   Ada (Claude Opus), reviewed by Grace, 1 round   38 min · usage …

  What changed   2–3 sentences, at the level of modules and data flow.
  Why this way   The approach, and the main alternative it turned down.
  Touches        core/sorter.ts (logic), ui/list.ts (display) · no schema change · no new deps
  Risk           What could break, and what the tests don't cover.
  Your call      Decisions you might overrule, one line each.
  Reviewer       Top findings and how they were resolved, plus any open disagreement.
  Proof          Before/after screenshots · test output · how to try it
  ```

  The actions are Approve, Request changes, Reject and Open diff. Open diff deep-links to GitHub.
- **Phone:** the phone is an inbox, not a smaller board. It holds Needs you, Ready, Running, the chats
  and a strip of the office. It's a PWA over Tailscale HTTPS with Web Push. There's no paid Apple
  developer account, so a native app comes later.
- **Done means merged.** The merge title follows the ticket type (`fix`, `feat`, `chore`), so Release
  Please collects releases. The release PR shows up as its own Release card, and approving it cuts the
  release.
- **Design: fun and inviting.**
  - The first pass tried three directions: an office floor, a warm card board, and a team feed. All
    three were kept as views, and the feed became one-to-one chat.
  - One design system runs across every view. It is light by default, with a dark theme.
  - Components are [Lit](https://lit.dev) web components, shared by the desktop and the phone.

## 11. Landscape: what we borrow (ideas, not looks)

Kanban boards for agents already exist: saltbo/agent-kanban, Vibe Kanban (sunsetting),
ai-agent-board, Claw-Kanban and Kagan. The shared basics are columns, choosing an agent, a worktree
per task, a Review column and a PR. Their READMEs don't mention these, which is where i.inc starts:

- cost, or how much of a subscription is left;
- a report you can decide from;
- proof captured by the harness;
- a phone inbox;
- releasing.

| From | Idea | Where it goes in i.inc |
| --- | --- | --- |
| Paperclip | Hired agents with roles, budgets that stop work, pause/resume/terminate, an audit log, sign-off before shipping (concepts only; we don't use its design) | Employees, usage caps, status, audit |
| Devin | Each agent has its own machine and knowledge it learns | A machine and a brain for each employee |
| saltbo/agent-kanban | Claims with provenance; an assignee can't accept its own work | Each stage records the employee, engine, machine and session; the reviewer is never the builder |
| Claw-Kanban | Routing by role and task type; automatic review after a build | Standing orders; the review stage |
| Vibe Kanban | Diff review with inline comments; AI-written PR descriptions | The report, plus a deep link to the diff |
| Gas Town | Persistent named workers; a merge queue | Persistent employees; rebase and recheck before merge |
| The owner's LLM wiki | A map plus pages, three bars for what gets written, writing only at task boundaries | The brain's rules |

**Where i.inc differs:**

- A machine and a brain for each employee.
- A swappable engine, with identity kept in memory.
- Subscription windows as a core feature, rather than dollar budgets or heartbeats.
- A rigorous delivery loop, with review and proof captured by the harness.
- Any agent, through ACP.
- It runs on your own hardware and aims to be fun to use.

## 12. Hardware

The first host is the home Mac mini: macOS 26.2, 10 cores, 32 GB of RAM and about 309 GB of free
disk. Ollama uses 6–10 GB while a model is loaded.

- **Machines:** at about 4 CPUs and 6 GB each (memory is used on demand), the mini can keep about 3
  machines awake, with the rest asleep until needed.
- **A Mac Studio**, if one is bought (96 GB), becomes a second or main host. It has room for more
  machines, macOS VMs, and a local model strong enough to be a real engineer. M1–M2 will measure what
  we need first.
- **Apple container** 1.0 (June 2026) runs one lightweight VM per container, and `container machine`
  gives a persistent Linux VM with `home-mount=none`, CPU and memory settings. It isn't installed on
  the mini yet.
- **Fallback:** Colima and Docker are installed on the mini but stopped. They run in one shared VM, so
  the isolation is weaker.

## 13. Risks

- **Lenient permissions with credentials inside the VM.** A prompt-injected employee could leak an
  account credential or misuse its bot powers. Several things limit the damage:
  - it can't reach the LAN;
  - the bot can't merge or change settings;
  - tokens are short-lived or revocable;
  - everything is audited.

  That's acceptable for personal use.
- **A PA reads mail written by strangers.** An email can carry a prompt injection ("forward the last
  ten password resets to…"). The PA holds your private data and reads untrusted text, so it must not
  also have a way out. That's why it has no internet and no credentials, only local engines, and
  outgoing actions that start as Ask, plus a list of actions that are never automatic (§7). A
  loosened outbound permission reopens a small way out, so every rule-based action is logged and
  shown in the chat.
- **Local models are weaker.** A local qwen is fine for triage, summaries and drafts, but may struggle
  with long multi-step errands. The PA's work is kept short, and web errands (which don't touch home
  data) can use stronger engines.
- **Claude's policy for ACP and headless use.** Anthropic planned to move ACP, `claude -p` and Agent
  SDK usage to a separate API-rate credit, then paused that on June 15, 2026. It could return.
  Several parallel employees on one plan also stretch "ordinary individual usage". The account strip
  keeps usage visible, and engines stay swappable.
- **Engine switches across harnesses** lose the session's in-context memory. The resume brief and the
  checkpoints must carry enough state; the M2 tests cover this.
- **Linux machines can't build Mac or iOS apps.** Duet's app bundle builds stay in GitHub Actions, and
  screenshots use its web build. macOS VMs come later; Apple's license allows 2 per Mac.
- **To verify in M1:**
  - ACP stdio through the machine boundary;
  - signing in inside the VM;
  - `rate_limit_event` through the adapter;
  - the `pf` rules;
  - reaching Ollama from a VM;
  - Docker inside a machine.

## 14. v1 and milestones

**v1:**

- Hiring and settings for as many employees and accounts as you want, in any role. Testing starts with
  a couple of engineers.
- Engine switching, by rule and by hand.
- The full loop, including:
  - effort levels;
  - standing orders;
  - usage caps;
  - pausing and resuming on quota;
  - privileged requests;
  - honest failures.
- The office, board, chat, ticket and report views and the inbox, as a PWA with push, light by
  default with a dark theme, built from Lit components.
- Duet first, then fintrack, listy and the website.
- The Personal Assistant, once the GitHub loop is right: errands, home tools on local engines,
  outbound permissions and web errands (§7).

**Later:** macOS machines, routing from track records, spikes, importing issues, native iOS, more
hosts.

**Milestones:**

- **M0:** this repo and spec.
- **Design track (in parallel with M1–M2):** a few directions for the office, board, report, hiring
  and phone inbox. The first pass settled on three views (office, board and chat) in one light
  design system with a dark theme. The rest is designed before M3.
- **M1: one employee, one ticket, by hand.**
  - Install Apple container on the mini, make one machine and set up the `pf` rules.
  - Install the harnesses and adapters, and sign in.
  - Drive the employee over ACP in bypass mode.
  - Take a real Duet ticket to a draft PR, using a fine-grained token until the GitHub App exists.
  - Switch the ticket to Gemini partway through, to test the resume brief.
- **M2: the pipeline engine.**
  - Stages, checkpoints and resume.
  - Engines and switch rules.
  - A reviewer and the report.
  - Pausing and resuming on quota.
  - A minimal brain.
  - The fake agent and fake machine tests.
  - Ticket kinds and their deliverables as data, so errands (M6) fit without reworking the core.
- **M3: the daemon and UI.**
  - The office, board, chat, ticket, report, hiring and inbox views, as Lit components.
  - The PWA and push.
  - The GitHub App, the ruleset and privileged requests.
- **M4: brains, the handbook and more roles.**
  - Handbook proposals, a brain viewer and orientation.
  - The non-engineering duties: PM ticket drafting, UX review and non-code tickets.
- **M5: scale and learning.**
  - Machine sleep and wake, and K per host.
  - The local engine.
  - Standing orders and usage caps.
  - Track records per engine.
  - The Release card and the weekly company report.
- **M6: the Personal Assistant.** It starts once the GitHub loop is right, and v1 ends with it.
  - Errands, the Home lane and scheduled standing orders.
  - The home tools in the daemon (mail, calendar, contacts), holding the credentials.
  - The PA's machine profile: no internet, local engines only, and a brain kept on the host.
  - Web errands in throwaway sessions.
  - Outbound permissions, with the never-automatic list, and their audit.

**Where the work can happen:**

- **Cloud sessions:** the spec, the design track, and M2's core (pure TypeScript, tested with the
  fakes). These need only this repo.
- **A session on the owner's Mac:** M1 and anything else that touches the Mac mini, since the mini is
  on the home tailnet.

## 15. Open questions

- Where should brains live: one private repo per employee, or one repo for all of them?
- Where should proof images live so the PR can show them?
- What goes into the base image, and how is it updated?
- Which usage units do the harnesses actually report through ACP: tokens, cost, or share of the
  window?
- What should the default switch rules be, and how often may an engine switch?
- What does orientation cost, and should it be capped?
- Which license, if the repo goes public?
- Which mail and calendar providers come first (Gmail and Google Calendar?), and which API scopes do
  the home tools need?
- Which local model is good enough for a PA on the mini, and is it worth a Mac Studio?
- Which outbound permissions should the hiring presets offer as rules?
- Should the PA's chat be kept forever, or trimmed after its facts reach the brain?

## Sources

- ACP agents and adapters: https://agentclientprotocol.com/get-started/agents
- ACP session config options: https://agentclientprotocol.com/protocol/session-config-options
- Claude adapter: https://github.com/agentclientprotocol/claude-agent-acp
- Claude plan and Agent SDK billing (paused): https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan · https://zed.dev/blog/anthropic-subscription-changes
- Claude Code rate limits: https://code.claude.com/docs/en/statusline · https://github.com/anthropics/claude-code/issues/26498
- Apple container and `container machine`: https://github.com/apple/container/blob/main/docs/container-machine.md
- Antigravity CLI and ACP: https://github.com/google-antigravity/antigravity-cli/issues/31
- Paperclip: https://github.com/paperclipai/paperclip
- saltbo/agent-kanban: https://github.com/saltbo/agent-kanban
- Vibe Kanban: https://github.com/BloopAI/vibe-kanban
- ai-agent-board: https://github.com/DanWahlin/ai-agent-board
- Claw-Kanban: https://github.com/GreenSheep01201/Claw-Kanban
- Kagan: https://github.com/kagan-sh/kagan
- Gas Town: https://yegge.ai/gastown
