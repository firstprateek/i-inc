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
   token usage → `chat/usage`. Everything agent-specific stays in the mapper. What AHP 1.0 has no place
   for goes in `_meta` (the full table is in [ahp-spike.md](ahp-spike.md)): the agent's **plan** is a
   pseudo tool call `x-iinc-plan` with the entries in `_meta["iinc.plan"]`, slash commands are in the
   session's `_meta["iinc.commands"]` (served by `completions`), tool-call `locations` are in
   `_meta["iinc.locations"]`, and allow-once versus allow-always is the confirmation option's `group`.
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
  edits show a diff; long terminal output is truncated with "show all"; errors carry Retry.
- **Composer.** Multi-line, Enter sends and Shift+Enter breaks a line; paste or drop images and
  files; the agent's slash commands (from `available_commands_update`); mode and model pickers;
  a **Stop** button while a turn runs. Typing while it runs **queues** a message or sends it as a
  **steering** message (AHP pending messages). A steering message runs as the next turn, ahead of the
  queue; it does not interrupt the current turn, because ACP has no way to inject into a running one. To
  interrupt, press **Stop**.
- **Right: context panel (collapsible).** Project and branch, files changed with diffs, the
  agent's plan, the brain pages used for this turn, and usage.
- **Phone:** the same stream in one column; the context panel becomes a sheet.

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
