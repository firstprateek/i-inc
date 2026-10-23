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

**Status:** built, and in daily use. Milestones M0 to M4 are done, M5 and M6 (the Personal Assistant) are partly
built. This document is the design. [architecture.md](architecture.md) says what is built and
wins where they differ, and §16 lists what is not built yet.

**Redesigned on 2026-10-17:** a sandbox per team instead of a machine per employee, signed in once
to each subscription, and reviewed work pushed straight to main by default instead of a pull
request per ticket. [architecture.md](architecture.md) is the current picture, and wins where it
differs from this spec; the sections affected (§5 and §6) say so.

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
- agent teams that coordinate with each other (the only teams are the groups of employees that share a
  sandbox, and a team is the trust boundary, §5);
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
| run the company | see this month's spend, output, quality, each employee's record, the roadmap, and the bottleneck, on My desk | ✓ |
| upgrade the hardware | add a host or models to the local pool without re-hiring anyone | ✓ |
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
   same branch, plan and notes. The report says "started on Claude Sonnet; moved to Gemini 3 Pro for checks after 3 failed check runs".
   → *An employee is its memory; its engine can be swapped.*
7. **Hiring.** You hire Juno as a UX Designer and set:
   - the engine: Gemini Flash on your Google AI Pro account;
   - the projects: listy and the website;
   - the working hours: nights only.

   i.inc builds Juno's machine, and Juno's first ticket is orientation: reading the handbook (a
   copy is in the machine, and the brief carries its map) and each project's `CLAUDE.md`,
   then writing project pages in its brain.
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
3. **Walls around the machine, not rules on each command.** Inside its team's sandbox an employee may do
   anything, with no permission prompts, and it has the open internet. Safety comes from five things:
   - the VM boundary, with the team as the trust boundary (one sandbox and one Unix user per team, and
     agents have root, so teammates' agents trust each other);
   - keeping employees off your home network and tailnet;
   - a bot GitHub identity that is never given write credentials inside a sandbox: every push is made by
     the daemon on the host (§5);
   - a guard on what the host itself runs: code deploys only with your approval or from a pull request
     you merged;
   - one-tap requests for actions that need your own credentials.

   A PA's walls are tighter, because it handles your private data: a sandbox of its own, no root, no
   internet, local engines only, and no credentials (§7).
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
| Engine | harness + model + account: Claude Code · Opus · "Claude Pro"; Antigravity · Gemini 3.1 Pro · "Google AI Pro"; OpenCode · qwen3 · "Local". One engine for everything by default, or one per duty (see "Engine per duty" below) |
| Fallback engines and switch rules | See "Engines and switching" below |
| Usage caps | Per ticket, per day and per week. Tokens where the harness reports them; otherwise a share of the account's window, or hours |
| Defaults | Effort level, and a review preference (for example, prefer a reviewer from another vendor) |
| Team | Which team's sandbox it works in. The sandbox (CPUs, memory, disk) is the team's, set in Company → Settings → Teams |
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
and local models.

- i.inc assumes nothing about how large an account is. It learns each account's windows from what
  the harnesses report.
- When an account runs out, the work pauses. Running out early on is expected and fine.
- Two employees on the same account share its limits.
- Each account has a **cost** you enter: a monthly fee or a price per token. Each host has a
  purchase price and its power draw. My desk uses them (§10).

**A local account is a pool of models on a host.** For example, a Mac Studio might serve a 27B dense
model, a 30B MoE and a small classifier. Each model in the pool is its own engine. Its capacity is
memory rather than a token window:

- i.inc knows which models are loaded and how much memory they and the machines use. On one host,
  models and machines compete for the same RAM.
- Loading a large model takes a while, so the scheduler prefers engines whose model is already
  loaded, and counts loading time as waiting.
- Adding a host or a bigger machine adds models to the pool without changing any employee.

The account kinds plug in, so a **private cloud** (a rented GPU running open models, reached over
Tailscale, paid by the hour and started only when there's work) can be added later. It is not in v1.
Home data stays on local engines; letting a private cloud process it would loosen a wall, so it would
be an explicit opt-in per account.

### Hiring

Once you've made the choices above, i.inc:

1. puts the employee in a team, and so in that team's sandbox (built from the base image the first time;
   a PA gets a team and a sandbox of its own);
2. clones the projects when a ticket first needs them;
3. creates the brain from a template;
4. if the account is new, shows a sign-in link on your phone.

The employee's first ticket is orientation. It reads each project's `CLAUDE.md` and then writes
project pages in its brain. Like every session, it gets the handbook's map and the pages that match
its task in its brief, and a copy of the handbook in its machine (§5, "The brain").

**Orientation closes only when its done-when is met.** When the session ends, the daemon collects what the
employee wrote in its brain copy and checks the pages it was asked for: a page under `projects/` for each
project, or for a PA the two pages of §7. A page counts if this ticket's sessions wrote it, with a title and a
description they wrote, at least 40 words and no placeholders (not the example copied). If one is missing, the employee gets one more session with a brief
that says what it did not write and how. If that fails too, the ticket goes to Needs you with the reason, and
"Keep going" gives it two more sessions; it is never marked done. The daily tidy-up is held to its done-when
the same way (the report it started from must be empty).

### Engines and switching: identity is memory

Every machine has all the harnesses installed: Claude Code, Antigravity, Codex and OpenCode, each speaking
ACP. Claude Code and Codex go through maintained adapters, Antigravity through its own ACP server, and OpenCode
natively. The engine chosen for a session decides which harness runs on which account. Each
team's sandbox signs in to the owner's subscriptions once, when the team is set up (`tools/host/sign-in-*.sh`):
Claude Code with `claude auth login`, Codex with its device-code sign-in, and Antigravity with its own
sign-in. The owner chose this over Claude's model-only
token (`claude setup-token`), accepting that a full Claude login also reaches the owner's claude.ai
connectors (mail, calendar, drive) from inside the sandbox. A token can still be given to any
account instead, and i.inc then injects it into each session.

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

Switches are visible: the card and the report say, for example, "started on Claude Sonnet; moved to
Gemini 3 Pro for checks after 3 failed check runs". A switch lasts for the rest of its stage, so the
next stage starts on the employee's usual engine again. Track records are kept per engine, so you learn which engine
suits which role.

### Engine per duty

An employee can have one engine per duty instead of one for everything. For example:

| Duty | Engine |
| --- | --- |
| Plan, build | Local 27B dense |
| Review small changes, triage, summaries | Local 30B MoE |
| Fallback | Wait, or Claude Sonnet |

- The engine is chosen by code, at stage boundaries, by this table. No model routes work to another
  model, and a session never changes model partway through a stage.
- The card and the report show which engine did each stage, and track records stay per engine.
- A single engine is the default, and hiring presets fill the table in for you.
- Models are engines, not employees. Several employees can share one model, and one employee can use
  several.

### Helper models

A **helper model** is a small, fast local model, such as a classifier, that the daemon's code calls
for quick yes/no decisions. It is never an employee's engine and never works a ticket. It answers
questions like:

- is this chat message a question, or an ask for new work?
- does this email need a reply, or is it a newsletter? (so the PA's larger model reads less)
- does this ticket match a standing order?
- does this transcript look stuck? (an input to switch rules)
- does this web errand brief contain anything taken from home data?

Helper models run locally, so they may see home data. Their answers only steer code paths; anything
that matters still reaches you as a proposal or shows on the card. In the core, a helper model is an
interface with a scripted fake in tests, like the ACP agent.

### Lenient permissions, hard walls

> Since 2026-10-17, "the machine" is a **team's sandbox**, shared by the team's employees and signed
> in once to each subscription ([architecture.md](architecture.md)). The walls are unchanged.

- **The team is the trust boundary (decided in T67, 2026-10-21).** A team has one sandbox and one Unix user,
  and its agents have root, because they need to install things and run Docker. Root can read every user's
  files, so a Unix user per employee would isolate nothing unless root went, and that would break ordinary
  work; a machine per employee would reverse the sandbox-per-team decision. So the agents of one team trust
  each other: a prompt-injected agent can read and change a teammate's working copies and brain copy.
  What must not be shared is not: a PA gets its own team and sandbox (no root, no internet; T66, below),
  brain edits made while a teammate's session overlapped are marked untrusted (§5, "The brain"), and no
  write credential is in any sandbox (below).

- **Inside the machine** the harness runs in its bypass mode: Claude Code bypassPermissions,
  OpenCode allow-all, and Antigravity's equivalent. i.inc's ACP client also approves any
  permission request. The
  employee can install anything, run servers, and use Docker, which needs no nested
  virtualization.
- **Network:**
  - The employee has open outbound internet: packages, docs, web search, GitHub and model APIs. A
    PA is the exception: it has no internet at all (§7).
  - It can't reach your LAN, your tailnet, other machines (T70) or other services on the host. The
    exceptions are i.inc's API and Ollama, plus the DHCP and DNS every machine needs. Ollama stays
    on loopback, and machines reach it through a relay on their gateway, so nothing outside the
    machines can reach it. IPv6 is refused rather than walled off, because the LAN's prefix
    changes.
  - Nothing can connect in from outside.
  - The host firewall (`pf` on the Mac mini) enforces this, and the domains each employee contacts
    are logged.
  - **A PA's sandbox is walled tighter, and this is now enforced** (once the owner has installed the
    new walls: docs/handoff.md, T66). The walls are closed unless opened: a machine reaches the
    internet and DNS only if its address is in a pf table `<open_machines>` (`tools/m1/pf/i-inc-machines.pf`),
    and every other address gets only DHCP and Ollama on the gateway. So a PA's sandbox has no
    internet, no DNS (a lookup through the host's resolver is a way out for what the PA has read), and
    nothing on the LAN, the tailnet or the host; a new, unknown or made-up address is shut in until
    declared. Apple container 1.4.1 can't put a machine on a network of its own (`machine create`
    has no `--network` option), which is why the walls name the machines they let out rather than
    the one they shut in.
  - **How the table is kept.** The daemon reads each machine's address from `container machine ls`
    and writes the running machines that may reach the internet (all but a PA's sandbox) to
    `/var/run/i-inc/open-machines`. The walls job (`tools/host/walls.sh`, root) takes only plain
    addresses of the machines' network from it, loads them with the rules, reads the table back from
    pf, kills the connections of an address that left it, and writes what pf holds to
    `/var/run/i-inc-walls.open` every minute.
  - **The daemon fails closed.** Before anything runs in a machine (agent, script, brain copy,
    callback, sign-in probe) it reads the machine's live address and checks it against that file: in
    it for an engineers' machine, not in it for a PA's sandbox; a PA's sandbox that is not running is
    refused. A machine that woke at a new address waits (up to 90 s) until the walls let it out. A
    PA's sandbox is created only if the walls are up to date, and a running one whose address is let
    out is stopped.
  - **A PA's sandbox has no root.** The image gives the employee passwordless sudo, with which a PA
    could give its machine an address that is in the table. When the daemon makes or boots a PA's
    sandbox it first runs a fixed script as root that removes the user's sudoers entry and its
    groups that are root in all but name (sudo, admin, docker), and checks as the user that `sudo -n`
    fails, before every launch. Updates to a PA's sandbox are written as root (`-u root`).
  - **Ollama is not a free pipe.** The relay on the gateway (`tools/m1/ollama-forward.mjs`) is an HTTP
    proxy with an allowlist: chat, generate, embed, embeddings, tags, show, ps and the OpenAI-style
    chat, completions, embeddings and models calls, only on exact paths, and only for models already
    installed on the host. A pull, push, create, copy, delete or blob call, a cloud model and a model
    that isn't installed (which includes any name with a registry host) are refused, and the request body is
    parsed and re-written so what is checked is what Ollama reads, so a sandbox can't make the host fetch from, or send a prompt to,
    a server of its choosing.
  - **Machines can't reach each other (T70, verified on the mini on 2026-10-22).** The machines share one bridge,
    and macOS switches a frame from one machine to another without handing it to the host's IP stack, so
    pf's rules on the bridge never saw it: two machines could reach each other over TCP, UDP and ping, and
    a PA's sandbox could hand data to an engineers' machine that has the internet. macOS has no
    `pfil_bridge` sysctl for this; the bridge's own filter flags (`IFBF_FILT_MEMBER | IFBF_FILT_ONLYIP`,
    set by `tools/host/bridge-filter.sh` through the kernel's `BRDGSFILT` call) make pf run on each
    member interface, and the rules drop, there, any frame to or from another machine's address
    (unicast, broadcast, multicast, IPv4 or IPv6, any protocol) and any frame that is not ARP or IP. The
    host keeps what every machine needs from it: DHCP, DNS for open machines, the Ollama relay. The
    walls job sets the flags and reads them back every minute, and takes the marker away (so no machine
    runs) if they don't hold, a bridge member isn't one the rules name, or the member rules aren't loaded.
    Not covered: a machine with raw-socket root crafting frames with forged source addresses to another
    machine's hardware address and a destination that isn't a machine's; engineers' machines have that
    root, a PA's sandbox doesn't. Closing it would take per-machine MAC and address locks on the bridge
    (`ifconfig bridge100 hostfilter`). Verified on the mini: TCP and ping between two machines are blocked both ways,
    open machines keep the internet, DNS, Ollama and DHCP, and a 100 MB download completes.
- **GitHub** uses a bot identity: one GitHub App, "i.inc bot", installed on the repos you choose.
  - **A sandbox never holds a credential that can write (T68).** Agents run with bypassed permissions and
    can be prompt-injected, and the bot may update `main` (direct mode), which the deployer puts on the
    host. So a machine is signed in to GitHub with a read-only token limited to the repos its
    sessions work on (none if a session needs none), renewed while it runs. Every push is made by the
    daemon on the host, from a git bundle of exactly the commit that was checked (the checked sha, nothing
    else), after it has verified the bundle and scanned what it brings for credentials; the write token
    stays in the daemon's memory. Opening and updating PRs, reading CI and managing issues are the
    daemon's too.
  - **Direct mode is advisory against a poisoned agent.** A builder and its reviewer share a sandbox, and
    the checks run there too, so a poisoned builder could fake its own checks and review. Therefore, in
    the repo the mini runs (i-inc), any change to code the host executes (everything but `docs/**/*.md`
    and top-level `*.md`, never agent instruction files) waits for your one-tap OK, which is bound to the
    exact commit sha and the patch-id of the diff shown on the card. The deployer deploys a commit only if
    it is docs-only, or the daemon's ledger records your approval of it, or it belongs to a pull request
    you merged. Anything else is skipped and you are told.
    Editing CI/CD workflows, running Actions and Pages are privileged requests: a token that can do
    them reaches the repo's Actions secrets from GitHub's runners, outside the walls.
  - Commits read as "Ada (i.inc)".
  - A ruleset on `main` limits who may update it ([github-app.md](github-app.md)): in owner-merges mode only
    you merge, on GitHub, and GitHub itself enforces it. Such a ticket closes by itself when it sees the
    PR merged; its card shows "Merge on GitHub" and "Close without merging". (Approve doing the merge
    with your account is not built.)
- **Privileged requests (not built yet).** Sometimes an employee needs something beyond its powers, such as a
  deploy secret, a repo setting or a new repo. The design is a Needs you card naming the exact action, which
  you approve and i.inc does with your account, so employees can still set up CI/CD from start to finish.
  Today an agent says so in its report and you do it yourself (a workflow change with
  `tools/host/push-for-owner.sh`).
- **Audit:** every tool call in the ACP stream is logged, so you audit afterwards instead of approving
  beforehand.

### The brain

The brain follows the conventions of the owner's own LLM wiki:

- It has an `INDEX.md` map, with pages under `tools/`, `patterns/`, `projects/` and `reference/`.
- It is written only at task boundaries, and only with facts that are durable, non-obvious and
  reusable.
- It is committed after each edit.
- Each page starts with frontmatter (`title`, `description`, `tags`, `updated`, `sources`), and links
  other pages as `[[slug]]`. The map is generated from the descriptions, and a disposable SQLite index
  (rebuilt from git) makes the pages searchable. `apps/daemon/scripts/brain-migrate.ts` moves older
  pages to this format.
- It is plain markdown, so any engine can load it through its global memory file
  (`~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, `AGENTS.md`).
- It lives in git on the host (the Mac mini), outside the machine, so rebuilding the machine never
  loses it. Brains and the handbook are never pushed to GitHub, because project repos may be
  public; they are backed up locally.

Knowledge comes in two layers, shared and personal:

- **The handbook** is the company's shared brain: facts useful to every employee, such as how a tool
  behaves, a pattern that works, or where things are. It has two kinds of page:
  - **facts**, which any employee adds at a task boundary; the edit applies at once and you can revert
    it from the Brain changes feed;
  - **policies** (how the company works). An edit to a policy page that an agent makes in its brain copy
    applies without approval too (owner's decision, T58): the change sends you a push and can be reverted.
    A retro that proposes a policy as JSON (an employee whose brain copy is unavailable) still waits for
    your approval, as do proposals that were already waiting.
- **The brain** is the employee's own: its personality and working style, and lessons tied to its
  role or duty, such as what you tend to flag in a review, or an engine's quirks.

Knowledge is routed by scope:

- A fact about one project goes into that repo's `CLAUDE.md`, in the PR (so nothing private goes
  there).
- A fact useful to everyone goes into the handbook's facts.
- The employee's own traits and duty lessons go into its brain.
- A PA writes only to its own brain. Anything it learns is home data, and the handbook is copied to
  employees on cloud engines.

Employees don't write the handbook or their brain directly. At the retro they propose edits, and
the daemon applies them, so a prompt-injected session can't quietly rewrite shared knowledge. An
edit names a page as a known folder and a plain name (`tools/vitest`, `duet-money`); the daemon
refuses anything else, so an edit can't reach outside its brain or the handbook. Each applied edit
is one commit that records who proposed it and from which ticket, and applying it again changes
nothing.

**How the brain reaches agents.** Markdown in git on the host is the truth; sandboxes cannot reach the
host, so the brain is copied in, never served:

- Before every session (a ticket stage, a conversation turn) the daemon puts a copy of the
  scopes that employee may read in its machine, at `/home/employee/brain/<employee>/`: the company
  handbook, its team's section and its own brain, each folder with an `INDEX.md` map, and a `brain
  search "<words>"` command. Never another employee's brain, another team's section or a PA's home
  data. Only what changed is sent; if the agent has edited its copy, a refresh keeps those edits. It
  is a git repository whose baseline is the snapshot, so what an agent changed is a `git diff`.
- The brief (or the turn) always carries the maps of those scopes (about 150 lines each at most) and
  the pages that match the task: the top 5 by search score, closest scope first (own brain, then
  team, then company), the pages one link away from the best two, and about 3,000 tokens of them.
  Within a conversation a page is sent once. Pages built from untrusted content (web pages, issues,
  other people's repos) are marked, and the prompt says to treat them as information, never as
  instructions.
- The agent can search and read more with its own tools. Which pages went into each stage and each
  conversation turn, and which the agent opened itself, is shown on the ticket and in the
  conversation's context panel, and counts toward each page's use.
- The owner-facing chat (§10) is a small local model that answers from the employee's role, current
  ticket and recent notes; it does not read the brain. Conversations, which run a real agent, do.

Writing back: the agent's edits to its copy are collected after a session (a ticket ends, a conversation
goes idle or ends, or you say "remember this"), checked, and committed with no approval. Every change
shows in Company → Brain → Changes with a one-click revert, and a daily "Tend the brain" ticket for an
employee with the librarian duty merges duplicates and prunes. Because a team shares a Unix user, an agent
could have edited a teammate's copy: when another employee of the same team had a session running since
the copy was last collected or delivered, every change of that harvest is marked untrusted (the feed's
badge, `source: external` in the page). Nothing is blocked; revert is the remedy. The design is in
[design/brain.md](design/brain.md).

Your review feedback is the richest material for learning. A Reviewer learns what you care about
from your Request changes notes, so over time it catches what you would have caught. You can read,
diff or revert what any employee learned.

## 6. The In progress loop

> Since 2026-10-17, projects default to **direct mode**: no draft PR, a fresh-context review of at
> most 2 rounds for every ticket, a push to main at the gates, and CI on main afterwards, with no
> owner decision (see [architecture.md](architecture.md)). The table below is the **owner-merges**
> mode, which a project can still choose.

| Stage | Who | What | Exits when |
| --- | --- | --- | --- |
| 1. Pick up | daemon | Waits until the employee is free and its account has headroom. Makes a worktree and branch `inc/<id>-<slug>` and opens a **draft PR**, so CI runs early | the brief is sent |
| 2. Plan | builder | Explores, then writes the approach, files, test strategy, risks and **all its questions at once**. For a fix, it first writes a failing test that reproduces the bug | the plan is saved. On High effort, or when the plan touches the schema, auth, public API, dependencies or CI, the gate waits for you, or for a Staff or Principal Engineer if you've allowed that |
| 3. Build | builder | Small commits, with WIP pushed as checkpoints | the builder says done |
| 4. Checks | harness | The project recipe: install, build, lint, typecheck, tests | green, or up to 5 failed runs (the switch rule's default), then a switch rule or an honest failure |
| 5. Prove | a fresh session with the verify duty (e.g. QA) | A black-box check of each done-when item against the running app. Screenshots come from Playwright on the web build, plus test and CLI output, all stored by the harness | every item ✓ with evidence, or ✗ with a reason |
| 6. Review | another employee with the review duty (same vendor is fine), plus a UX Designer when the UI changed, if you have one | Checks out the branch **in its own machine** and runs it. Returns findings marked blocking, should-fix or nit, each with file:line, and checks the builder's claims against the diff | a verdict |
| 7. Address | builder | Fixes each finding or replies with why not. Then back to 4, to 5 if the UI changed, and a re-review of **only the changes** | approved, or out of rounds, which goes to you with both sides |
| 7b. Done-when check | a fresh session that is not the builder's: another employee with the verify duty, else one with the review duty, else the builder's seat on a different engine, else its own engine with a clean context | A short, read-only, low-effort check of each done-when item against the diff and the checks' results: met, not met or can't tell, each with evidence. Skipped, with a note, only when the ticket has no done-when ("No done-when to check"), and recorded without a second check when the prove stage already proved every item. It runs at low effort where the harness has that level, and the worktree is compared before and after: a checker that changed files has them put back, and the ticket goes to you | every item met. Something not met goes back to the builder **once**, with the unmet items; still not met, or can't tell, goes to you with the result for each item, never to done. The result shows on the ticket page under "What was asked", and in the report |
| 8. Final gates | harness | Rebase on the latest `main`, full checks, GitHub CI green, every done-when ✓, a secret scan, diff-size and protected-path checks | all pass |
| 9. Report | the builder drafts, the reviewer confirms, the harness fills in the facts | The one-page report becomes the PR body; the PR is marked ready, the ticket moves to Review, and you get a push notification | — |
| 10. Your decision | you | **Merge on GitHub** (the ticket links to the PR; i.inc looks at the PR about every 5 minutes and closes the ticket as merged by itself once it sees it merged), **Close without merging** (closes the PR, keeps the branch), or Request changes (back to 7 with your note first). Approve alone does not merge, and is refused while the PR is open | — |
| 11. Retro | builder and reviewer | Each proposes 0–2 edits: brain edits and handbook facts apply at once, and so do policy edits made in the brain copy (you get a push and can revert). Track records are not built | — |

**Effort sets how far the loop goes.**

| Effort | Stages | Review rounds | Gate |
| --- | --- | --- | --- |
| Low | 1, 3, 4, 7b, 8, 9 | 0 | — |
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
- Reviewers and verifiers are scheduled like any other work. When a ticket reaches Prove or
  Review, it waits for a free employee with that duty, and the card says who it waits for. A
  builder whose own ticket is waiting may review someone else's work meanwhile; their own ticket
  then waits for them in turn.
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
  processed only by local engines. The planned model is qwen3.8 27B, set up later. i.inc refuses to
  give a PA a cloud engine, and its switch rules can only wait or move to another local engine,
  never to a cloud one. A PA's OpenCode is pinned to local providers, since OpenCode also offers
  hosted models of its own.
- **The PA never holds your credentials.** The daemon keeps the Google (or other) tokens and offers
  the PA a small set of **home tools**: search mail, read a thread, create a draft, propose an event,
  read free/busy, and file a web errand. Every call is logged.
- **No open internet.** Unlike an engineer's machine, a PA's machine reaches only i.inc's API and
  Ollama. Whatever it prepares can only leave through a proposal you see. Today that is Ollama
  only (i.inc's API port joins it when the daemon serves one to machines), enforced by the walls
  described in §5, including the block on traffic between machines (verify after install: docs/handoff.md, T70). Because the sandbox has no internet, only a local engine can
  run in it: hiring or editing a PA refuses any duty's engine, fallbacks included, that isn't a
  local one. If none is set up, it says so ("none is set up yet: add one in Setup"), and the hiring
  form says the same; the local engine is OpenCode on Ollama (`tools/m1/install-harnesses.sh`), added
  as an engine in Setup.
- **A PA works on a small model, in a machine with nothing to install.** Every PA brief and every turn of a
  PA's conversation carries a short note on its machine: no internet, no sudo, no installs; the tools it has (a
  shell, git, node, jq, grep, its file tools, the `brain` command and `rg` when they are there) and the ones it
  cannot use (`gh` and `docker` are installed but need the internet). The brain section it carries is cut for its small
  window: 40 map lines and 1,500 tokens of pages (at most 3), against 150 lines and 3,000 tokens (5 pages) for a cloud
  engine. Its model is `qwen3-8b-32k`, `qwen3:8b` with a 32,768-token window set on the model itself
  (`tools/host/ollama-pa-model.sh`), because a prompt that does not fit is cut without a word and the endpoint
  OpenCode uses cannot set the window per request. Its orientation is its own, in short numbered jobs with the
  exact path and the page format to copy: read its home brain and the handbook's non-code pages, write
  `reference/how-i-help-at-home` (with a "My tools" section where it records what works offline) and a starter
  `patterns/errands`. An errand it runs is done when it proposes something or says why nothing is needed, not
  with an empty result. The owner can check it works with `apps/daemon/scripts/converse.ts` (docs/handoff.md,
  "Checking a PA works").
- **Web work is split off.** A flight search needs the internet but not your mail. The PA files a
  **web errand** with a structured brief (for example: from, to, dates, cabin, preferences). A fresh,
  throwaway session with open internet and no home data runs it, on any engine, and returns the
  results. Briefs are logged, and you can ask to approve each one before it runs.
- **The PA's brain stays home too.** It holds personal facts, so it lives only on the host (with
  local backups) and is never pushed to GitHub. A copy of it goes into the PA's own sandbox only, and a PA
  always has a sandbox to itself (hiring makes it a team of one), because everyone in a sandbox shares one
  Unix user.

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
  warning or rejected) and `resetsAt` for the 5-hour and weekly windows. It passes through the ACP
  adapter as a `usage_update` whose `_meta["_claude/rateLimit"]` also carries how much of each
  window is used (confirmed in M1).
- **Google AI Pro, through Antigravity:** its ACP server reports no usage, so its limits are learned
  from its errors. Gemini CLI no longer serves Google AI Pro accounts (§13).
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
- **Artifacts live on the host**, next to the event log: plans, reviews, and proof such as
  screenshots and test output. The report in i.inc shows them.
- **Proof in the PR:** proof images are copied into the PR body, so the PR stands on its own. An
  image that is private (the verifier marks it when it shows personal data or secrets, or the
  project is set to keep proof private) stays on the host, and the PR gets a link that only works on
  the tailnet. Repos may be public, so the default for a public repo errs towards private when in
  doubt.
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

- **No fixed team size.** Machines sleep when idle and wake when work arrives. The design caps the machines
  awake at once per host at K, with the rest waiting in the queue, K defaulting to what the host's RAM allows
  and more hosts raising it (the cap is not built; idle machines sleep, and at most three conversations are
  live per team).
- **Machines can be rebuilt; brains are kept.** Rebuilding is manual (`tools/host/update-machine.sh`); a
  reset button and a nightly base-image update are not built. Brains and the handbook are git repos on the
  host. The database has a daily backup (`i-inc.db.autobak-<date>`, 30 days) and a quick integrity check at
  startup.
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

> **As built**, the app has three areas: **Conversations**, **Work** (Board, Releases) and **Company** (Team,
> Brain, Projects, Usage, Settings), and **Needs you** is a page of its own, not a tab (T61, T64). The names
> below are the design's: the Office is Company → Team (the floor) and Usage (account meters); the Board is
> Work → Board; Chat is Conversations (the old small-model chat is still reachable from its list, as
> "Old chat"); My desk is split into Usage (spend, where work waited) and Releases. Output, quality, your
> time, scorecards and the roadmap are not built. [layout.md](layout.md) has the routes.

There are three main views, plus My desk. Each answers a different question, and each is a way into
the others.

- **Office:** who is doing what, right now? It's the desktop home. Each employee has a desk and an
  avatar, and its monitor shows the live status line. Out of tokens reads as a coffee break ("back
  at 3:40 pm"), off hours as an empty desk, and Needs you as a raised hand. The account meters sit
  beside the floor.
- **Board:** where does all the work stand? To do → In progress → Review → Done, plus a Needs you badge.
  It spans all your projects and Home, and each card has a stage strip. Cards move themselves; you press
  buttons.
- **Chat:** one thread per employee, for talking one to one.
  - Questions ("why this approach?") are answered from the employee's role, its current ticket and
    its recent notes, by the local model. (Conversations, which run a real agent, also read the brain.)
  - Asks for new work become a draft ticket in the chat, and one tap puts it on the board. For a PA,
    an ask becomes an errand straight away (§7).
  - A message to an employee in the middle of a ticket reaches it at the next stage boundary, or
    right away if you mark it urgent.
  - Everything that needs you also appears in that employee's chat. Answering in the chat or in the
    inbox resolves both.
- **My desk:** how is the company doing, and what is holding it back? It's your corner office: the
  running company seen as a CEO sees it. Every number on it points at something you can change.
  - **The bottleneck**, at the top: where work waited longest this week and the lever for it, e.g.
    "tickets waited 9 h for Claude Pro while Kit was idle: move Kit to Gemini, or add an account".
    Often it's you: "plan gates waited 6 h for you".
  - **Spend this month** by account and host, cost per merged PR, and how much of each
    subscription was used. It counts hardware and electricity by default, with deliberately simple
    maths, an estimate you can trust rather than a meter:
    - a subscription: its monthly fee;
    - API usage: tokens × price, where the harness reports tokens;
    - hardware: purchase price ÷ 36 months (you can change the months);
    - electricity: (idle watts × idle hours + busy watts × busy hours) ÷ 1000 × your price per kWh.
      Busy hours are the hours local engines or machines were working, from the event log; the rest
      of the month is idle. You enter the two wattages once per host (for example 7 W idle and 60 W
      busy for the mini).
  - **Output:** merged PRs, releases and errands per project, with weekly trends.
  - **Quality:** first-pass approval rate, review rounds, honest failures, reverts.
  - **Your time:** minutes per merged PR, and how long Needs you waited for you.
  - **Employees:** a scorecard per employee and per engine (tickets, first-pass rate, rounds, cost,
    switches), showing counts next to rates so that small numbers don't mislead.
  - **Roadmap:** each project's **goals** (a goal groups tickets) and their progress. A Product
    Manager keeps goals up to date, and changes wait for you. Goals live only in i.inc; they don't
    sync with GitHub milestones in v1.

  Everything on it is derived from the event log, plus the account costs you enter. The weekly
  company report is a snapshot of My desk.
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
- **Done means merged.** In owner-merges mode a ticket is done when its PR is merged on GitHub, and i.inc
  notices that itself. Releases are cut from Work → Releases (or automatically per project with
  `autoRelease`); a Release Please PR card is not built.
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

The first host is the home Mac mini: macOS 26.2, an M4 with 10 cores, 32 GB of RAM and about 330
GB of free disk. Before any machine, the host itself uses about 12 GB. Ollama uses 6–10 GB while a
model is loaded (qwen3:8b at a 32k context: 8.1 GB).

- **Machines:** about 4 CPUs and 6 GB each. A machine takes memory only as it needs it, but it
  never gives any back until it restarts: 0.6 GB just after booting, 4.6 GB after a day of work.
  So the mini keeps about 2 machines awake while a local model is loaded, or 3 without one. A
  machine is stopped after each ticket, and it wakes in under a second.
- **A Mac Studio**, if one is bought (96 GB), becomes a second or main host. It has room for more
  machines, macOS VMs, and a pool of local models (for example a 27B dense, a 30B MoE and a small
  classifier as a helper model). Models and machines share its RAM, and long coding contexts need
  large caches, so the pool may keep two models loaded and swap the third. Adding it changes the
  local account's pool, not the employees. M1–M2 will measure what we need first.
- **Apple container** (1.4.1 on the mini since M1) runs one lightweight VM per container.
  `container machine` gives a persistent Linux VM with `home-mount=none`, CPU and memory settings.
  Its home mount is read-write by default, and its memory is half the host's, so both are always
  set.
- **Fallback:** Colima and Docker are installed on the mini but stopped. They run in one shared VM, so
  the isolation is weaker.

## 13. Risks

- **Lenient permissions with credentials inside the VM.** A prompt-injected employee could leak an
  account credential (a subscription sign-in lives in its team's sandbox) or misuse its bot powers.
  Several things limit the damage:
  - it can't reach the LAN, and a sandbox holds no GitHub credential that can write (T68);
  - the bot can't change settings or workflows, and in owner-merges mode can't merge;
  - code the host runs deploys only with your approval or from a PR you merged;
  - tokens are short-lived or revocable;
  - everything is audited.

  What stays open: the agents of one team trust each other (the team is the trust boundary, §5), and in
  direct mode the checks and the review run in the builder's own sandbox, so against a poisoned agent they
  are advisory. (One machine cannot reach another: T70, verified on the mini, §5.)
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
- **Google moved subscription use from Gemini CLI to Antigravity.** On June 18, 2026, Gemini CLI
  stopped serving Google AI Pro, Ultra and free personal accounts. Only API keys and enterprise
  licences still work there, and the CLI silently falls back to asking for an API key. So the
  Google engine runs through Antigravity's ACP server instead. Vendors can move a subscription
  again, which is one more reason engines stay swappable.
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
  - A first My desk: spend, output and the bottleneck card.
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
  - The full My desk: scorecards, quality, your time, and goals for the roadmap.
  - The local model pool, engine per duty, and helper models.
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

- What goes into the base image, and how is it updated?
- Which usage units do the harnesses actually report through ACP: tokens, cost, or share of the
  window?
- What should the default switch rules be, and how often may an engine switch?
- What does orientation cost, and should it be capped?
- Which license, if the repo goes public?
- Which mail and calendar providers come first (Gmail and Google Calendar?), and which API scopes do
  the home tools need?
- Which outbound permissions should the hiring presets offer as rules?
- Which small model makes a good helper model, and how fast must it answer?
- Should the PA's chat be kept forever, or trimmed after its facts reach the brain?

## 16. What is built, and what is not

The sections above are the design. Where they differ from [architecture.md](architecture.md), that page wins.

**Built:** hiring and settings (teams, engines, accounts, roles, duties); the pipeline in direct and
owner-merges mode with checkpoints, resume and honest failures; engine switching and engine per duty;
the scheduler (standing orders, working hours, caps, account headroom); the board, tickets, reports,
follow-up proposals and releases; Conversations on the AHP host, with permission modes (bypass is the
default), steering, push and "Open the session" on any ticket stage; the brain (retrieval into every
brief and turn, harvested edits with a changes feed and revert, a daily tidy-up); the GitHub App with host-side
pushes; automatic deploys behind the guard; the PWA with push; the walls, the Ollama relay and the PA's
sandbox (own team, no root, no internet); daily database backups, a low-disk gate and resume after a
graceful stop.

**Not built yet (future work):**
- Agents asking you questions in the middle of a conversation. No adapter supports it today, so a question
  reaches you as ordinary text in the reply ([design/conversations.md](design/conversations.md)).
- Agent teams talking to each other (aligned with A2A), and MCP tools and skills (aligned with ARD).
- The PA's home tools (mail, calendar, contacts) and web errands. The errand loop, outbound permissions and
  the PA's walls are built, but nothing connects them to a mailbox yet.
- Privileged requests, and Approve merging with your account.
- Done-when checked for every ticket (T72, in progress): a low-effort code ticket has no `prove` stage, and a medium or high
  ticket skips it when nobody on the team has the verify duty. Orientation, tidy and errands are checked (T71).
- Track records and scorecards, goals and the roadmap, the weekly company report, and the Output, Quality and
  Your-time parts of My desk.
- Proof screenshots captured by the harness and copied into the PR (proof is text evidence per done-when item).
- A cap on machines awake at once per host, and the local model pool with memory-aware scheduling.
- A Feedback button, and a browser smoke test in CI (CI runs `check`, `typecheck` and `test`; `pnpm e2e` is run by hand).
- Per-device login tokens, a native app, and a private cloud.

## Sources

- ACP agents and adapters: https://agentclientprotocol.com/get-started/agents
- ACP session config options: https://agentclientprotocol.com/protocol/session-config-options
- Claude adapter: https://github.com/agentclientprotocol/claude-agent-acp
- Claude plan and Agent SDK billing (paused): https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan · https://zed.dev/blog/anthropic-subscription-changes
- Claude Code rate limits: https://code.claude.com/docs/en/statusline · https://github.com/anthropics/claude-code/issues/26498
- Apple container and `container machine`: https://github.com/apple/container/blob/main/docs/container-machine.md
- Antigravity CLI and ACP: https://github.com/google-antigravity/antigravity-cli/issues/31 · its ACP
  server in the registry: https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp
- Gemini CLI stops serving individual accounts (June 18, 2026):
  https://github.com/google-gemini/gemini-cli/discussions/28017
- Paperclip: https://github.com/paperclipai/paperclip
- saltbo/agent-kanban: https://github.com/saltbo/agent-kanban
- Vibe Kanban: https://github.com/BloopAI/vibe-kanban
- ai-agent-board: https://github.com/DanWahlin/ai-agent-board
- Claw-Kanban: https://github.com/GreenSheep01201/Claw-Kanban
- Kagan: https://github.com/kagan-sh/kagan
- Gas Town: https://yegge.ai/gastown
