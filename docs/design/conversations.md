# Conversations (V1 design)

Status: approved 2026-10-20. Corrected by the AHP spike ([ahp-spike.md](ahp-spike.md)): AHP is 1.0, not pre-1.0, and
`serverSeq` is one counter for the whole host. The host core, the action store, the `/ahp` transport and the
conversations table and REST routes are built (T59a, contract C22 in [coord.md](../coord.md)); the session host
and the ACP mapper follow (T59b). The Conversations screen is T60.

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
  pushes go through the bot, and protected paths (`.github/`, release config) still wait for you.

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
   redacted and capped before it is kept, and big attachments live in content blobs. Ticket transcripts
   move onto the same store later (replacing `ticket_session_items`), so ticket stages become watchable live.
4. **Transport.** A WebSocket endpoint (`/ahp`) on the daemon's own port, behind the same login as the
   rest of the API (cookie or bearer, plus the protocol's `authenticate` when enabled), with the Host and
   Origin checks, keepalive pings, a frame size limit and a slow-consumer limit.
   Everything that is not a session stays plain REST.

The spike (T55, [ahp-spike.md](ahp-spike.md)) answered the open questions:
- The official `@microsoft/agent-host-protocol` 1.0.0 works under Bun and Node (types, reducers, client,
  WebSocket transport). We pin it exactly and build our own host on its reducers; `@ahpd/sdk` is a
  reference, not a dependency. (The package's `declare const enum`s trip our `isolatedModules`, so
  `apps/daemon/src/ahp/wire.ts` holds the values we use as typed string constants.)
- The spec is 1.0 with Stable chat, session and root channels. Churn is narrow: pin, negotiate the version,
  keep agent-specific code in the mapper.
- Whether VS Code's Agents window can attach to an i.inc host over the tailnet is plausible (a
  `chat.remoteAgentHosts` setting) but unverified; it is an acceptance test for later, not a design driver.

## The screen (laptop first)

- **Left: conversation list.** Grouped as "Needs you" (a pending permission or question),
  "Running" and "Recent", plus a **New conversation** button that asks for an employee, a project
  (or none) and starts on the first message.
- **Centre: the thread.** Markdown with highlighted code; reasoning collapsed under "Thinking";
  tool calls as compact one-line cards (Read, Edit, Run, Search…) that expand to input and output;
  edits show a diff; long terminal output is truncated with "show all"; errors carry Retry.
- **Composer.** Multi-line, Enter sends and Shift+Enter breaks a line; paste or drop images and
  files; the agent's slash commands (from `available_commands_update`); mode and model pickers;
  a **Stop** button while a turn runs. Typing while it runs either **steers** the current turn or
  **queues** a message (AHP pending messages).
- **Right: context panel (collapsible).** Project and branch, files changed with diffs, the
  agent's plan, the brain pages used for this turn, and usage.
- **Phone:** the same stream in one column; the context panel becomes a sheet.

## Data and API

- Table `conversations(id, employee_id, project, branch, title, mode, engine_id, created_at,
  archived_at, ahp_session, ahp_chat)`, and `ahp_actions(server_seq, channel, at, action, origin)` (one
  `server_seq` for the whole host) plus `ahp_snapshots(channel, server_seq, state)`.
- REST: list, create, rename, archive conversations (`/api/conversations`, contract C22). WebSocket
  `/ahp`: everything live.
- The old chat stays for one release behind "Old chat", then goes. The local helper model stays
  for small classification jobs only.

## Build order

1. AHP spike and decision (done, T55).
2. Host core, state store and transport (T59a); session host and event mapper (T59b); then ticket
   stages moved onto them.
3. The Conversations screen.
4. "Make this a ticket" and "Open the session" between conversations and tickets.
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
- **One shared login token.** Fine for one owner on the tailnet. Per-device tokens come with the
  first non-browser surface.
