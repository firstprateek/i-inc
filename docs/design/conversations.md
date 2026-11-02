# Conversations (V1 design)

Status: approved 2026-10-20, and built (the host, the screen, push, shipping a conversation's work, and Open the session). Corrected by the AHP spike ([ahp-spike.md](ahp-spike.md)): AHP is 1.0, not pre-1.0, and
`serverSeq` is one counter for the whole host. The host core, the action store, the `/ahp` transport and the
conversations table and REST routes are built (T59a, contract C22 in [coord.md](../coord.md)), and so are the
session host and the ACP mapper (T59b: `apps/daemon/src/ahp/session-host.ts`, `acp-mapper.ts`). Ticket stages are on the
host too (T69, below): each stage's session is a read-only chat, and `ticket_session_items` stays the record. The
Conversations screen is T60.

## Goal

An excellent agentic conversation surface, as good as Claude Desktop, Claude Code or Antigravity's
conversations: you talk to any employee about any project, watch the agent work live, approve or
steer it, and it can change code. Laptop browser first; the phone and other surfaces use the same
stream later.

## What is wrong today

- **"Chat" is not an agent.** It sends your message to a small local model (`qwen3:8b` on Ollama,
  `OllamaChat`), unstreamed, with no tools, no repo and no sandbox. One thread per employee.
- **Real agent sessions are one-shot and invisible.** The pipeline starts a new agent process per
  ticket stage, sends one prompt, and closes it (`AcpAgent.run`). You only see a transcript
  afterwards, and only text plus tool titles: plans, reasoning, tool output, diffs and modes are
  dropped.
- **Permissions are never yours.** Every session runs in the agent's bypass mode
  (`bypassPermissions` for Claude, `yolo` for Antigravity) and every permission request is
  auto-approved.
- **Live updates are coarse.** The event stream only says "ticket N changed"; the page then
  refetches everything. No replay after a disconnect.

## The model

- **Conversation:** a long-lived agent session with one employee (persona, brain, engine), on one
  project or none, in that employee's team sandbox, on its own working copy (a branch). You can
  have many per employee. Each has a title (auto-named from the first message), a permission mode,
  a model and effort, and can be archived.
- **Turn:** your message (with images or files) and the agent's response, streamed as parts:
  text, reasoning (collapsed), tool calls (status, input, output, a diff for edits), the agent's
  plan, questions for you, errors and token usage.
- **Conversations and tickets are two ways to do work.** A conversation is interactive; a ticket
  is the autonomous pipeline (plan, build, checks, review, prove, push). "Make this a ticket" hands
  a conversation's work to the pipeline; "Open the session" shows any ticket stage as a read-only
  conversation in the same view. Both can change code.

## Permission modes (owner's decision: conversations can do anything)

- The mode picker sits in the composer and lists **the agent's own advertised modes** (ACP session
  modes or config options), named as the agent names them, for example:
  - Claude: Always ask · Accept edits · Plan only · Bypass permissions
  - Codex: Read-only · Auto · Full access
- **Default: the agent's bypass-permissions mode** (owner's decision, 2026-10-20), changeable per
  conversation in one click; the app remembers a per-employee default if you change it.
- **Permission requests show inline** as a card: what the tool will do (the command, or the file
  diff) and the agent's options (Allow once, Always allow, Deny). The first answer from any device
  wins. If you are away, a push notification opens the card on your phone.
- What stays fixed whatever the mode: the sandbox walls (no home network, no tailnet, no mini),
  no write credential in the sandbox (every push is made by the daemon on the host, T68), and protected
  paths (`.github/`, release config, and in the repo the mini runs any host-executed code) still wait for you.

## Architecture: make the daemon an AHP host

[AHP, the Agent Host Protocol](https://microsoft.github.io/agent-host-protocol/) (Microsoft, MIT
licence, the protocol behind VS Code's Agent Host) standardises exactly what we need. It is at **1.0**
(released 2026-10-02) and its root, session and chat channels are marked Stable. A **host**
owns the authoritative state of agent sessions, talks **ACP to the agents** and **JSON-RPC to any
number of clients**. Clients subscribe to a channel, get a snapshot, then an ordered stream of
actions with a `serverSeq` (**one counter for the whole host**, not one per channel), and replay what
they missed after reconnecting. The first tool confirmation from any client wins. We use the official
`@microsoft/agent-host-protocol` 1.0.0 (pinned) for the types and reducers (and, in the web app, the
client); the host, mapper and store are ours, because the package has no host. See [AHP and ACP](https://github.com/microsoft/agent-host-protocol/blob/main/docs/guide/ahp-and-acp.md)
and [the VS Code write-up](https://code.visualstudio.com/blogs/2026/08/26/agent-host-architecture).

Why it fits:
- i.inc's daemon already is the ACP client for every agent; it becomes the AHP host.
- Live UI without refetch storms, and nothing lost on reconnect.
- Other surfaces (phone app, desktop app, possibly VS Code's Agents window) can attach to the same
  sessions without new back-end work. That covers the "decoupled front end" and "AHP" items.

Pieces in the daemon:
1. **Session host.** Keeps an ACP connection open per active conversation (`machineLaunch` into the
   team sandbox, working directory = the conversation's working copy), sends prompts, cancels,
   switches modes and models. Idle conversations suspend after a timeout (default 15 min) and
   resume with `session/load` where the adapter supports it, otherwise with a continuation brief
   (summary plus recent turns). A per-team limit on concurrent live conversations (default 3)
   protects the 12 GB sandbox.
2. **Event mapper.** ACP updates become AHP chat actions: `agent_message_chunk` → `chat/delta`;
   `agent_thought_chunk` → `chat/reasoning`; `tool_call` / `tool_call_update` →
   `chat/toolCallStart` / `chat/toolCallReady` / `chat/toolCallComplete` (with content and diffs);
   `session/request_permission` → a pending confirmation answered by `chat/toolCallConfirmed`;
   token usage → `chat/usage`, sent again as the agent reports how full its context is (at most every
   5 seconds and only on a change, for conversations and ticket stages; the reading goes in the usage's
   `_meta`, and each `chat/usage` replaces the turn's usage, so nothing adds up). A turn that is stopped
   or fails keeps its last reading. Everything agent-specific stays in the mapper. What AHP 1.0 has no place
   for goes in `_meta` (the full table is in [ahp-spike.md](ahp-spike.md)): the agent's **plan** is a
   pseudo tool call `x-iinc-plan` with the entries in `_meta["iinc.plan"]`, slash commands are in the
   session's `_meta["iinc.commands"]` (served by `completions`), tool-call `locations` are in
   `_meta["iinc.locations"]` (the last ones given are kept to the end of the call), and allow-once versus
   allow-always is the confirmation option's `group`.
   **Modes are session config** (`session/configChanged`, the agent's own names as the schema's enum
   labels); per-chat mode needs spec 1.1. **"Needs you"** is the session's `inputNeeded` list.
3. **State store.** Every channel's actions are appended to SQLite with their host-wide `serverSeq`
   (`ahp_actions`), with periodic snapshots (`ahp_snapshots`), so any client can replay and a restart
   rebuilds the state. The log is pruned behind snapshots (by age and by count), tool output is
   redacted and capped before it is kept, and big attachments live in content blobs. Ticket stages are on the
   same store (T69): each stage session is a read-only chat, watchable live and replayable. `ticket_session_items`
   stays the historical record the ticket page reads; it is not replaced.
4. **Transport.** A WebSocket endpoint (`/ahp`) on the daemon's own port, behind the same login as the
   rest of the API (cookie or bearer, plus the protocol's `authenticate` when enabled), with the Host and
   Origin checks, keepalive pings, a frame size limit and a slow-consumer limit.
   Everything that is not a session stays plain REST.

As built (T59b):
- A conversation's agent runs in its employee's team sandbox, in `/home/employee/work/conv-<id>`: a worktree
  of the project's repo on branch `conv/<id>`, made like a ticket's but never committed to or pushed, or an
  empty folder with no project. At most three conversations are live per team: opening a fourth suspends the
  least recently used idle one, and a message to a sleeping conversation when all three are busy waits in the
  queue with the reason shown in the chat. Creating a conversation when all three are busy is refused (409).
  Idle conversations suspend after 15 minutes; a daemon restart suspends them all. A crashed or killed agent
  ends the turn with an error and starts again on the next message.

Shipping a conversation's work (T62b, contract C22b in [coord.md](../coord.md)), the build order's step 4:
- **Make this a ticket** hands the conversation's branch and working copy to the pipeline. The ticket's branch is
  `conv/<id>` and it works in `conv-<id>`, assigned to the conversation's employee in the same team machine. It
  starts at the checks (pick-up, plan and build are marked done by the conversation), then prove, review and the gates.
  owner-merges ends in a draft PR taken out of draft for the owner; direct ends in a push to main after the review.
  Protected paths still wait for the owner. Uncommitted work is committed first (`--no-verify`, the pipeline's checks
  are the gate), after a scan for credentials: a finding refuses the whole thing and names the files, never the values.
- **Open a PR** (owner-merges only) skips the pipeline: commit, then the daemon pushes from a verified bundle on the
  host (the sandbox cannot push), a draft PR with a generated title and body, and its checks in the context panel. Direct-mode projects have no such button: their way to main is always a
  ticket, so it is always reviewed.
- **One agent in a copy.** While a ticket has the copy, the conversation's agent is stopped and the host refuses
  its turns ("This work is now ticket #N"). A ticket that is waiting for the owner still holds it. When the ticket is
  done or failed, the conversation continues on the updated branch, and its agent is told what happened to it.
- Both are idempotent (a double click finds the first one's ticket or PR), and both are refused, in a sentence, for a
  conversation with no project, while the agent is mid-turn, or with nothing changed.

The spike (T55, [ahp-spike.md](ahp-spike.md)) answered the open questions:
- The official `@microsoft/agent-host-protocol` 1.0.0 works under Bun and Node (types, reducers, client,
  WebSocket transport). We pin it exactly and build our own host on its reducers; `@ahpd/sdk` is a
  reference, not a dependency. (The package's `declare const enum`s trip our `isolatedModules`, so
  `apps/daemon/src/ahp/wire.ts` holds the values we use as typed string constants.)
- The spec is 1.0 with Stable chat, session and root channels. Churn is narrow: pin, negotiate the version,
  keep agent-specific code in the mapper.
- Whether VS Code's Agents window can attach to an i.inc host over the tailnet is plausible (a
  `chat.remoteAgentHosts` setting) but unverified; it is an acceptance test for later, not a design driver.

Open the session (T69, contract C22 "Ticket sessions"):
- **One read-only chat per stage session.** `AcpAgent.run` feeds every ACP update, through the same mapper, into a chat
  `ahp-chat:/stage:<session id>` of a read-only session `ahp-session:/ticket:<ticket id>`. The turn is the stage: the
  brief (cut) is the user message and the agent's work streams in as parts. Clients cannot act on these channels; the
  stage keeps its own permission handling. Agents that do not speak ACP are mapped from their transcript items.
- **On the ticket page,** each stage in Sessions has **Open the session**, which opens `#/ticket/<id>/session/<id>`: the
  conversation thread, read-only ("Watching #12 · build", a live mark while it runs, no composer), with the context
  panel (plan, files changed, usage). Back returns to the ticket; on a phone it is one column and the panel a sheet. A
  live stage updates as it works; a finished one replays from the store, also after a restart.
- **Limits.** The live view of a stage that ended before `stageViewDays` (30 by default) is let
  go of with the hourly maintenance; the transcript stays. Everything else is the host's existing eviction, caps and
  redaction.

## Agents and the daemon's end

An agent is a process in the team's sandbox, started through `container machine run -i`. If the
daemon dies (a crash, `kill -9`, a deploy that does not wait for it) the agent's stdin closes, and
an agent that does not treat that as the end keeps running; the restarted daemon would then start
a second one for the same conversation, and the first would live on. Three things prevent it
(`apps/daemon/src/reaper.ts`):

- **A note per launch.** Every launch has a token (`I_INC_AGENT`). The image's launcher
  (`images/employee/acp-env.sh`, which every `acp-*` launcher sources) writes
  `~/.inc-agents/<token>.pid` in the sandbox: `pid|start time|folder`. The launcher `exec`s the agent,
  so the pid is the agent's. Machines made before this need `tools/host/update-machine.sh <employee>`
  to get the new `acp-env.sh`; until then there is no note and nothing to find.
- **A sweep.** Before every launch (conversations and tickets), with the folder it is for, and once at
  startup over every `inc-*` machine that is up, a script stops each agent whose note is there, whose
  pid still has the recorded start time, and (on Linux) whose environment still holds the token:
  SIGTERM to it and its descendants, SIGKILL after three seconds, note removed. A note whose pid is gone or
  has another start time is stale and is only removed. Never by process name. The agents this daemon
  started itself (tokens it holds) are never touched.
- **A clean exit.** On SIGTERM or SIGINT the daemon stops accepting connections, sends `session/cancel`
  to every running turn, closes every agent's stdin, kills what is still there after 2.5 s, sweeps
  the sandboxes once more for anything that ignored both, folds the database's log back in and
  exits, all inside about 8 s (launchd gives 20). A second signal exits at once.

What `container machine run -i` does with the end of stdin, or with its own death, is not documented in
this repo, the `container` CLI is not installed on the development Mac, and nothing here was run on the
mini. So none of this relies on it: the sweep stops the process inside the machine whatever the client
does. It is worth one look on the mini, in a scratch machine, to see whether closing the client's stdin
reaches the process (`container machine run -i -n <scratch> -- sleep 1000 < /dev/null`, then
`ps` in the machine) and whether killing the client does.

## Questions from the agent: a known gap (future work)

The conversation daemon never raises an AHP input request (`session/inputNeeded` only ever lists
tool confirmations). Checked against the adapters' public documentation, not run: ACP defines
`elicitation/create` (a client method, "request structured information from the user") and
`elicitation/complete`, used only if the client advertises the `elicitation` capability, which this
daemon does not. Claude's adapter (`@agentclientprotocol/claude-agent-acp`) documents elicitation only
for its experimental v2 (`CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1`) and for MCP sign-in links, and says
nothing about Claude's `AskUserQuestion` tool; nothing was found for the Codex adapter. So today a
question reaches the owner as ordinary text in the reply, and an `elicitation/create` request, if an
adapter sent one anyway, is answered "not offered". To close the gap: advertise the capability, map
`elicitation/create` to an AHP `ChatInputRequest` part (the host and the `inputNeeded` roll-up already
carry those), answer it from the owner's `chat/inputAnswerChanged`, and check the request and answer
shapes against a real adapter on the mini first.

## The screen (laptop first)

- **Left: conversation list.** Grouped as "Needs you" (a pending permission or question),
  "Running" and "Recent", plus a **New conversation** button that opens the draft in the centre
  pane (no form in the list).
- **Centre, nothing open: New conversation.** One centred composer, like Claude's chat, with the
  employee (default: last used), the project (last used, or none) and the mode (the employee's
  remembered one, else bypass) as pickers; the conversation is created on the first send. It is also
  the view when the owner has no conversations or has not opened one.
- **Centre: the thread.** Markdown with highlighted code; reasoning collapsed under "Thinking";
  tool calls as compact one-line cards (Read, Edit, Run, Search…) that expand to input and output;
  edits show a diff; long terminal output is truncated with "show all"; errors carry Retry. A card
  counts the lines an edit changed in the whole file. The sides it keeps stop at 1 MB, or 32,000
  characters in a ticket's stage view, so an opened diff keeps the card's counts and says when some
  or all of the change is past that point.
- **Composer.** Multi-line, Enter sends and Shift+Enter breaks a line; paste or drop images and
  files; the agent's slash commands (from `available_commands_update`); mode and model pickers;
  a **Stop** button while a turn runs. Typing while it runs **queues** a message or sends it as a
  **steering** message (AHP pending messages). A steering message runs as the next turn, ahead of the
  queue; it does not interrupt the current turn, because ACP has no way to inject into a running one. To
  interrupt, press **Stop**. A chat holds one steering message, and a second would replace it, so while one
  waits another joins the queue instead: the composer says so, and the host does the same for a message it
  couldn't see coming (another tab, or a second press before the first's echo).
- **Right: context panel (collapsible).** Project and branch, files changed with diffs, the
  agent's plan, the brain pages used for this turn, and usage. Usage has a meter of how full the
  agent's context is, which moves during a turn; "Latest turn" shows only when a turn has reported tokens.
- **Phone:** the same stream in one column; the context panel becomes a sheet.

## Review (the Changes pane)

**Changes** in the thread's header opens a pane over the thread and the context panel: everything the conversation's
working copy changes against where its branch left the project's main, committed or not, with untracked files. It comes
from git, not from tool calls, so a change made by a shell command shows too. The panel's Files changed list stays, and
links into it.

- `GET /api/conversations/:id/changes`: `{ changes: { state, noProject, files, skipped, truncated, partial, reason? } }`, each
  file `{ path, added, removed, binary?, status }`, and status one of added, modified, deleted, type-changed. Renames show
  as a deletion and an addition. `partial`: something in the folder couldn't be read (no permission on a file or on a
  folder that isn't ignored, a pipe, a nested repo with no commit, files that kept going away), so the list may be missing
  files. The pane says so.
- `GET /api/conversations/:id/changes/file?path=`: `{ file: { state, path, before, after, withheld?, reason? } }`. Each side
  is `{ state, text? }`, and state one of none, text, binary, too-big, link, outside, other. A bad path is a 400.
- `state` is `ok`, or why the read didn't happen, with `reason` in one sentence: `asleep`, `busy` (the read outlasted its
  wait or its time limit), `no-copy` or `failed`. These are 200s. The pane says the sentence and offers Try again. A
  refresh that gets `asleep`, `busy` or `failed` says so above the list and the diff it already has, and leaves them,
  and any comment box, where they are; the same goes for the open file when it can't be read again.
- **Read-only, and the copy's word isn't taken.** No fetch, no token, and nothing in the copy is written:
  `apps/daemon/src/review.ts` lists from a scratch repository outside the folder, which sees the copy's objects and files
  and nothing else of it, not its index (flags and cached stats that hide a change), config, `.git/info/exclude` or
  hooks. Git finds what differs by content, and only those files are hashed, into the scratch objects, with the copy's
  out of sight: git touches an object it is asked to write and already has. So every tracked file is read on each list.
  Optional locks are off, and so are lazy fetches: `GIT_NO_LAZY_FETCH` needs git 2.45 and the image has 2.43, so no
  protocol is allowed either (`GIT_ALLOW_PROTOCOL=none`). And `G` from `ship-git.ts` has no hooks, filters, fsmonitor or external diffs.
- **No implicit boots.** It uses the runner that refuses a stopped machine (T75). A read holds an ordinary lease, so it
  runs beside an agent's turn: the pane shows what is there, says the agent is working (or waiting for an answer), and
  refreshes when the turn ends. Listings run one at a time, and a request made during one gets a read that starts
  after it, so that refresh can't come back with a list from before the turn's last edit.
- **No project,** or a project's copy with no commits or no repository: the scratch repository looks at the folder, and
  every file there is new.
- **Untrusted.** Paths must be relative, with no `..`, NUL, control character, leading `-`, `.git` or `.inc`, and a name
  that fails is left out and counted. Files stop at 1 MB, every kind of credential ship's scan stops is redacted (a key
  block keeps its lines, so line numbers hold, and a line in it that isn't key material stays in sight, so two markers
  can't hide code), and what is redacted is what ship's scan stops, so nothing can be hidden from review and still be
  pushed. For the same reason the diff withholds only the files ship stops by name (`.env`,
  `*.pem` and the like): they are listed but not served. A file with a name that only suggests secrets (`.envrc`,
  `prod.env`, `.pgpass`) can be pushed, so its diff shows, redacted like any other. Links are never followed, and the
  pane renders all of it as text.
- **Line comments** are the owner's, in this browser, per conversation, kept with the drafts (and forgotten with them at
  sign-out), across tabs. No route takes them. A line's number opens its box; the code itself is there to select. A
  half-written comment stays through another line, another file or closing the pane, and is only thrown away when the
  owner says so. It is never out of reach: past the point where a long diff is cut, its file opens with every line
  showing; once its file has left the list, Unfinished comments leads to it; and with no list or diff to show, that
  section holds the box itself. A read that lands while the owner types doesn't take them out of the box: focus and the
  caret go wherever it is drawn next. A comment sits under its line while the line still reads as it quoted it; after that it is listed above
  the diff as changed, never under whatever took the number. Past about 200 KB the newest are kept for this page only,
  and the pane says so.
- **Sending them.** Comments are added to the next message as `path:line`, the quoted line and the comment, and cleared
  once it is sent. A message that is a command (`/remember`) leaves them for the next one. **Send comments** sends them
  alone through the composer, so a running turn queues them and the composer's refusals hold, and what is in the box
  stays there. If the host refuses it later, or the owner removes it from the queue, it comes back in the box as text.
- **While the agent waits.** If it is stopped on a permission or a question the pane says so and **Answer** goes to the
  card. The thread's live region is hidden behind the pane, so the pane has its own, there from the start, which says
  when the agent starts working, needs an answer, or finishes, stops or hits an error.

## Files (the Files and Search tabs)

**Files** and **Search** sit beside **Changes** in the same pane, and show the working copy as it is, whether or not it
changed. Each read follows the Review rules above: it writes nothing, boots nothing, and believes nothing it is told.

- `GET /api/conversations/:id/files`: `{ files: { state, noProject, paths, skipped, truncated, partial, reason? } }`. In a repository,
  what the commit tracks plus what is new by the scratch index (so `.gitignore` counts and the copy's index and excludes
  don't), less what has gone. With no commit to go on, a bounded `find` that skips `.git`, `.inc` and `node_modules`. At
  most 20,000 paths.
- `GET /api/conversations/:id/files/read?path=`: `{ file: { state, path, side, withheld?, reason? } }`, one side as in a
  diff, by the same checks: 1 MB, redacted with its lines kept, links never followed. A file that usually holds secrets,
  by a wider rule than the diff's (`.envrc`, `prod.env`, `.pgpass` and `.ppk` too, and any case), is named but not served,
  and neither is anything reached through a link into `.git` or `.inc`. Search leaves out the same files. A bad path is a 400.
- `GET /api/conversations/:id/files/search?q=&case=1`: `{ search: { state, hits, truncated, partial, reason? } }`, each hit
  `{ path, line, text }`. A literal query of one line, at most 200 characters, with case ignored unless `case=1`.
- **Search looks at what the viewer shows.** `git grep -F` over what isn't ignored, in the scratch repository and with
  2 GB of memory, or a bounded `grep` with no commit, only says which files may hold the query. Those files, up to 200 and 6 MB
  in all and none over 1 MB, come out as the viewer reads them, each is redacted whole, and the query is looked for in
  that text. Redacting a line can't work: a value can sit lines from its label and a key has nothing near it. So what a
  search shows can't be other than what the viewer shows, a match inside what redaction took out is no match, and nothing
  counts what wasn't shown: a count that moved with the query would tell what is hidden, a letter at a time. Two things
  still move with a right guess, and only for someone who has planted files holding it: a match counts towards the file
  limits before anything is read, so past 200 files or 6 MB it can change which files are looked through; and a file
  brought out takes a few milliseconds more than one that isn't. Hits are at most 20 a file and 500 in all.
- **The pane.** Files is a tree with one tab stop and the tree keys, with a filter over paths; lists draw 400 rows at a
  time. The viewer has line numbers and the highlighter (up to 40 KB, plain after that) and draws 1,000 lines at a time,
  around the line asked for. Search runs when it is asked to, lists hits by file and opens the viewer at the line. Files
  and Search refresh when a turn ends; a search's results stay as they were until the owner searches again. Lists run
  one at a time here too, and a request made during one gets a read that starts after it.
- **`@file`.** Typing `@` at the start or after a space opens a list of matching paths, built like the slash list.
  Enter or Tab puts the path in as text (in backticks if it has a space). It stays shut during IME composition, and for an `@` the owner dismissed with
  Escape, until it has gone from the box. A draft has no working copy, so the list doesn't open there. The list of paths
  is remembered for 30 seconds or until a turn ends; a machine that is asleep is said in a sentence, and Enter still sends.
- **Read cards.** A Read card whose path is in the copy has a button that opens it in Files at the line, and the viewer
  says so if the file has gone since. The path is the call's locations, or its arguments (`file_path`, `offset`) while it
  has given none, so a running call has the button too. A ticket's read-only stage has none.
- **Closing the pane** keeps what Files and Search held, for this page, per conversation. On a phone, back closes it.

## Data and API

- Table `conversations(id, employee_id, project, branch, title, mode, engine_id, created_at,
  archived_at, ahp_session, ahp_chat)`, and `ahp_actions(server_seq, channel, at, action, origin)` (one
  `server_seq` for the whole host) plus `ahp_snapshots(channel, server_seq, state)`.
- REST: list, create, rename, archive conversations (`/api/conversations`, contract C22). WebSocket
  `/ahp`: everything live.
- The old chat is still there, behind "Old chat" in the list, and is meant to go. The local helper model stays
  for small classification jobs only.

## Build order

1. AHP spike and decision (done, T55).
2. Host core, state store and transport (T59a); session host and event mapper (T59b); then ticket
   stages moved onto them.
3. The Conversations screen.
4. "Make this a ticket" (done, T62b) and "Open the session" (done, T69) between conversations and tickets.
5. Push notifications for "Needs you" cards; then the phone layout.

## Risks

- **Spec churn.** AHP 1.0 is new (2026-10-02) and VS Code's own host is already ahead of it on the wire.
  Pin the package, negotiate the version, depend only on the Stable channels and keep agent-specific
  code in the mapper.
- **Sandbox capacity.** Long-lived agent processes compete with tickets. Idle suspend plus a
  per-team limit.
- **Subscription usage.** Conversations spend the same quota as tickets. The composer shows the
  account's 5-hour and 7-day meters and warns near the cap.
- **Bypass mode.** Safe only because of the walls. Keep the walls and redaction; never mount the
  owner's home into a sandbox.
- **One owner login.** Fine for one owner on the tailnet. Each login is its own revocable session (T63), and
  an open AHP socket closes with its session. Per-device tokens come with the first non-browser surface.
