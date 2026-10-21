# AHP spike (T55): how to build the AHP host

Status: findings and recommendation for the owner's review, 2026-10-20. Companion to
[conversations.md](conversations.md) (the approved design) and [v1-plan.md](v1-plan.md). The prototype is
`spike/ahp-host/` on branch `spike/ahp`. Nothing in the main workspace changed (no new dependencies; `biome.json`
only ignores `spike/`).

## Verdict

**Do it, and build our own host on the official TypeScript package.** AHP is a good fit and the spike ran every flow
conversations.md needs, end to end, under Bun.

- Adopt `@microsoft/agent-host-protocol` 1.0.0 for **types, reducers, version negotiation, the client and the
  WebSocket transport**. The daemon runs the official reducers to hold authoritative state, and the web app runs the
  same reducers and the official client. That is the part with the least churn risk and the most value.
- Write the **host, ACP mapper and SQLite store ourselves**. About 1,200 lines in the prototype; the official package
  has no host, and the one third-party host (`@ahpd/sdk`) is a one-maintainer 0.x library with in-memory replay and
  its own persistence model. Keep it as a reference implementation and as a compatibility oracle, not as a dependency.
- The wire is **1.0.0 (released 2026-10-02) and the chat, session and root channels are marked Stable**, so the "pre-1.0,
  around 0.9" risk in conversations.md is out of date. The remaining churn is real but narrow (see Risks).

## 1. The packages and the spec

| | `@microsoft/agent-host-protocol` | `@ahpd/sdk` |
| --- | --- | --- |
| Who | Microsoft (`microsoft/agent-host-protocol`, `clients/typescript`) | One person (Luiz Fernando Softov, `softov/ahpd`), unaffiliated |
| Version | **1.0.0**, published 2026-10-03 (first publish 2026-05-29) | **0.13.0**, published 2026-10-20 (15 versions in six weeks) |
| Licence | MIT | MIT |
| Size | 393 KB tarball, 1.9 MB unpacked, 397 files | 1.8 MB tarball, 7.3 MB unpacked, 703 files |
| Dependencies | none | the Microsoft package; optional `ws`; `@ahpd/agent-acp` adds `@agentclientprotocol/sdk` (Apache-2.0) which needs `zod` as an undeclared peer |
| Exports | `.` (all types, enums, **reducers** for every channel, `isClientDispatchable`, `negotiateProtocolVersion`, `SUPPORTED_PROTOCOL_VERSIONS`), `./client` (`AhpClient`, subscriptions, `AhpStateMirror`), `./ws` (`WebSocketTransport`), `./hosts` (multi-host helper) | `createHost`, `listen` (Node, Bun, Deno), ports for files, terminals, git changesets, automations, users, vault; the `Agent` contract |
| Host server? | **No.** Client side only. | Yes: a full host |
| Runtime | Pure ESM, no `node:` imports, uses the global `WebSocket`. Browser bundle of client + ws + reducers: **49 KB minified, 11.9 KB gzip** | Needs Node >= 22.1 (`node:fs`, `child_process` in 60+ modules); `listen()` runs on Bun |

The spec ([versioning.md](https://github.com/microsoft/agent-host-protocol/blob/main/docs/specification/versioning.md)):
SemVer, with the spec and each language client on separate tracks. **Spec 1.0.0 shipped 2026-10-02** (0.8.0 on
08-18, 0.9.0 on 08-28: a fast cadence). A per-channel Node-style stability index applies: **Stable (2):** root, session,
chat, terminal, telemetry, resource watch. **Release candidate (1.2):** changeset, MCP. **1.1:** annotations.
**1.0 or experimental:** TCP, automations, canvas. Hosts accept `>=1.0.0 <2.0.0` or `>=0.9.0 <0.10.0`, and the
doc says outright that backwards-incompatible changes "are inevitable", so negotiate and check capabilities.
The published package offers `1.0.0` and `0.9.0`.

What the spec pages say, for the parts i.inc uses:

- **Lifecycle.** `initialize{protocolVersions[], clientId, initialSubscriptions}` returns `{protocolVersion, serverSeq,
  snapshots[]}`; no common version is `-32005` with `data.supportedVersions`. `ping` works before and after
  initialize. `reconnect{clientId, lastSeenServerSeq, subscriptions}` returns either `{type:"replay", actions[],
  missing[]}` or, when the gap is beyond the host's buffer, `{type:"snapshot", snapshots[]}`.
- **Auth.** Transport auth is outside the protocol (cookie, header or query during the HTTP upgrade). In-protocol,
  an agent lists `protectedResources` (RFC 9728 metadata); the client pushes a bearer with `authenticate`; the host
  answers `-32007` with the needed resources or sends an `auth/required` notification (not replayed). i.inc's agents
  declare none, so `authenticate` is a no-op for us; ACP sign-in failures stay a `session/creationFailed`.
- **Subscriptions.** `subscribe` returns `{snapshot:{resource,state,fromSeq}}`; every later action has a larger
  `serverSeq`. **`serverSeq` is one counter per host, not per channel** (so `ahp_actions(channel, server_seq, ...)` in
  conversations.md works with `server_seq` as a global primary key). Chat snapshots support `view.turns` plus
  `fetchTurns` paging. Windowed delivery (credit-based) exists for terminal-like firehoses. Protocol notifications
  (`root/sessionAdded`, `auth/required`) are not replayed; clients re-list.
- **Chat channel (Stable).** `ChatState` has `turns`, `activeTurn`, `queuedMessages` (steering and queued, one list),
  `draft`, `changesets`, `status` bits (Idle, Error, InProgress, InputNeeded, IsRead, IsArchived). Response parts:
  `markdown`, `reasoning`, `toolCall`, `contentRef`, `inputRequest`, `systemNotification`, `error`. Tool calls move
  `streaming -> pending-confirmation -> running -> (pending-result-confirmation) -> completed | cancelled`, and a
  pending confirmation carries `options[]` (approve or deny, labelled, grouped), an `edits` preview and
  `confirmationTitle`. Client actions: `chat/turnStarted`, `chat/turnCancelled`, `chat/toolCallConfirmed`,
  `chat/pendingMessageSet`, `chat/inputCompleted`, `chat/draftChanged`, read and archive flags. The server validates
  every client action and echoes a bad one back with `rejectionReason`; **the first `toolCallConfirmed` wins** because
  later ones find the call no longer pending.
- **Session channel.** `lifecycle` (creating, ready, failed), `chats[]` catalogue, `defaultChat`, a `config`
  (schema + values) and `inputNeeded[]`, a roll-up of every pending confirmation or question across chats, so the
  "Needs you" list and push notifications need no per-chat subscription. The host must keep the session's chat
  summaries consistent with the chats (`session/chatUpdated`).
- **Changesets (RC).** `ahp-changeset:` channels give "files changed" with before and after content, per session, chat or
  turn. The host computes them (git); the prototype does not.

## 2. Runtime fit

Everything was exercised by running it, from a scratch install and then in `spike/ahp-host`.

| Check | Bun 1.4.2 | Node 24.9 |
| --- | --- | --- |
| Import the types/reducers, `/client`, `/ws`, `/hosts` | ok | ok |
| Official `AhpClient` + `WebSocketTransport` talking to our host | ok (demo) | ok (`src/node-client-check.mjs`) |
| `@ahpd/sdk` `createHost` + `listen`, with `@ahpd/agent-acp` driving our fake agent | ok, reports runtime `bun` (`src/probe-ahpd.ts`) | ok, reports runtime `node` (same script) |
| Host: `Bun.serve` WebSocket upgrade, `bun:sqlite`, `node:child_process` for the agent | ok | n/a (host is Bun-only) |

Things to know:

- **Const enums break our TypeScript settings.** The package ships `declare const enum` (`ActionType`, `ToolCallStatus`,
  `SessionStatus`, ...). The repo's `tsconfig.base.json` has `isolatedModules` + `verbatimModuleSyntax`, which turns every
  `ActionType.X` into error TS2748 (82 errors in the spike). The values do exist at runtime, so Bun runs fine. We need either
  a `pnpm patch` of the `.d.ts` files (`const enum` to `enum`), or local string-literal constants cast to the package's
  action types. Decide before writing real code. The spike's own tsconfig leaves those two flags off.
- **`isClientDispatchable`'s signature leaves out `ChatAction`** (works at runtime for chat actions; the type guard
  just doesn't accept them). Wrap it.
- **The client SDK is thinner than its README suggests.** It has no auto-reconnect (one `AhpClient` per transport; you
  call `reconnect()` yourself and apply the result, which `Mirror` in `src/client.ts` does in about 15 lines).
  Subscription queues are bounded and **drop envelopes for a slow consumer** (4096 by default). `AhpStateMirror` mirrors
  root, session and others but **has no chat map**, so the web app uses `chatReducer` directly. Plan on writing the
  store layer ourselves, around the reducers.
- Under Node the global `WebSocket` cannot set headers, which is the same limit a browser has: cookie or `?tkn=` it is.
- `bun install` fails here with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (corporate CA; `npm install` works). Not an AHP problem.

## 3. The prototype

`spike/ahp-host/` (own `package.json`, not in the pnpm workspace). About 1,200 lines of host plus tests and demo.

| File | What it is |
| --- | --- |
| `src/fake-acp-agent.ts` | Scripted ACP agent on stdio: thought + message chunks, `tool_call` + updates (with locations, text and diff content), `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `usage_update`, `session/request_permission` with all four option kinds, a "slow" script that waits for `session/cancel`, `session/load`. |
| `src/acp.ts` | ACP client over `node:child_process` stdio. Same wire handling as `apps/daemon/src/acp.ts` but long-lived, with agent requests routed to callbacks. |
| `src/map.ts` | **The mapper.** One `TurnMapper` per prompt turn; plus the reverse helpers (`promptBlocks`, `permissionOutcome`, `configFromAcp`). |
| `src/host.ts` | The host: channels (root, session, chat), the official reducers, global `serverSeq`, subscriptions, `reconnect` replay, action validation and rejection, `inputNeeded` roll-up, turns, cancel, queued messages, mode changes, crash recovery. |
| `src/store.ts` | `bun:sqlite`: `channels` (initial state), `ahp_actions(seq, channel, action, origin)`, `ahp_snapshots`, content `blobs`, prune floor. |
| `src/serve.ts` | `Bun.serve` WebSocket at `/ahp`: the daemon's own cookie or bearer check, plus `?tkn=`, plus an Origin allowlist. `ahpWebsocket(host)` and `upgradeAhp(...)` are written to drop into the daemon's existing `Bun.serve`. |
| `src/client.ts`, `src/demo.ts` | The official client plus a mirror; the end-to-end scenario below. |
| `src/host.test.ts` | 17 tests: the mapping table as executable cases, the confirm race, deny path, queue, mode validation, restart rebuild, reconnect replay. |
| `src/probe-ahpd.ts` | Comparison: the third-party host + ACP backend wrapping the same fake agent. |

### Re-run it

```sh
cd spike/ahp-host
npm install                 # bun install fails behind the corporate CA; the lockfile is package-lock.json
bun test                    # 17 tests, ~0.5 s
bun src/demo.ts             # the end-to-end run below; exits non-zero on any failed assertion
PORT=4999 bun src/main.ts & # then, for the Node client check:
PORT=4999 node src/node-client-check.mjs
bun src/probe-ahpd.ts       # the @ahpd/sdk comparison (node src/probe-ahpd.ts works too)
../../node_modules/.bin/tsc --noEmit -p .   # typecheck with the repo's TypeScript 7
```

### What the demo proved (output of `bun src/demo.ts`)

```
 1. host up; upgrade without the token -> 401; Cookie i_inc and ?tkn= both accepted
 2. initialize -> protocolVersion 1.0.0; createSession -> subscribe: session ready, defaultChat, config.mode
    (modes named as the agent names them: Always ask | Accept edits | Plan only | Bypass permissions)
 3. client B joins the same session and chat (B.lastSeq == A.lastSeq)
 4. A sends a message -> ACP session/prompt. Both see "Edit src/app.ts" pending-confirmation with options
    allow-once(approve,g0) allow-always(approve,g1) reject-once(deny,g0) reject-always(deny,g1);
    session.inputNeeded=1, session status bits=24 (InputNeeded); the edit preview is a ContentRef
 5. A approves, then B denies the same card: B gets rejectionReason "...already answered"; ACP saw
    {"outcome":"selected","optionId":"allow-once"}; turn complete with parts reasoning, markdown, read,
    plan, edit (fileEdit, +1/-1), markdown; A's and B's reduced state identical; diff fetched by resourceRead
 6. B disconnects at serverSeq 30; A changes mode (-> ACP session/set_mode) and runs a second turn;
    B reconnects with lastSeenServerSeq=30: replay of 22 actions (31..52), B state == A state
 7. cancel: slow turn -> chat/turnCancelled -> ACP "received session/cancel"; partial text kept;
    no further actions for the cancelled turn (late ACP chunks dropped)
 8. SIGKILL the host; restart on the same SQLite file: 60 actions + 5 snapshots on disk, "rebuilt 3 channels at
    serverSeq 60; replayed 12 actions after snapshots"; chat state byte-identical to before; listSessions works;
    next message resumes the ACP session with session/load; new serverSeqs start at 61 (no reuse)
 9. SIGKILL during a streaming turn: restart marks the turn error (host_restarted), keeps the partial text;
    after pruning the log, a stale reconnect gets type "snapshot" (spec: gap beyond the buffer)
ALL STEPS PASSED
```

`bun test` also covers the **simultaneous** confirm race (`Promise.all` of an approve from A and a deny from B:
exactly one is rejected, and it is B), the deny path (`reject_once` goes to ACP, the tool call ends `cancelled`, the
agent carries on), a second `turnStarted` during a turn (rejected) and a queued message becoming the next turn.

### Comparison: the same fake agent through `@ahpd/sdk` + `@ahpd/agent-acp`

It works out of the box on Bun (about 15 lines of setup; it needs `honoursTrust: true` or it refuses the folder). It
produces nearly the same action sequence, the same four confirmation options and the same plan-as-pseudo-tool-call,
which is a useful independent confirmation that our mapping is what others converge on. Differences that matter to us:

- **No durable log.** Replay is an in-memory ring of the last 1,000 envelopes (with a byte budget); chat history is
  whatever the agent backend can re-read. Our design needs an action log in SQLite shared with ticket transcripts.
- It brings 700 files of things we do not want in the daemon (users, vault, automations, usage, policies, plugins).
- Its mode appears as a `permissionMode` key it defines, not the agent's own named modes.
- It tracks VS Code's wire closely (its `UPSTREAM.md` is a changelog of where VS Code's host moved ahead of the
  published protocol), which is valuable to read, but it is one person's project.

## 4. Mapping: ACP to AHP

The forward rows are the `TurnMapper` cases in `src/map.ts`, each with a test in `src/host.test.ts`. **GAP** means AHP
has no first-class place for it; the workaround column is what the prototype does.

### Agent to client (ACP `session/update` and requests to AHP)

| ACP | AHP action or state | Notes |
| --- | --- | --- |
| `agent_message_chunk` (text) | first chunk `chat/responsePart` (markdown part), the rest `chat/delta` on that `partId` | A tool call closes the part, so the next text opens a new one. **GAP:** image, audio and resource chunks from the agent are dropped; a `contentRef` response part could carry them. |
| `agent_thought_chunk` | `chat/responsePart` (reasoning part), then `chat/reasoning` deltas | Renders as the collapsed "Thinking". |
| `tool_call` (title, kind, status, rawInput, content, locations) | `chat/toolCallStart` (`kind` -> `toolName`, `title` -> `displayName`); `chat/toolCallReady` with `confirmed: not-needed` when status is not `pending`, `toolInput` = JSON of `rawInput` | A `pending` call stays `streaming` until an update or a permission request. **GAP: `locations`** has no field; kept in `_meta["iinc.locations"]`. |
| `tool_call_update` status `in_progress` | `chat/toolCallReady` (first time); `chat/toolCallContentChanged` for new content | Content change only applies to a running call. |
| `tool_call_update` status `completed` or `failed` | `chat/toolCallComplete{success, pastTenseMessage, content[], error}` | |
| tool content `content` text / image | `text` / `embeddedResource` result content | |
| tool content `diff` | `fileEdit{before, after: ContentRef, diff:{added,removed}}` | **The host must serve the `ContentRef` URIs** (here `resourceRead` on `ahp-content:/<sha>`, blobs in SQLite). Before and after are whole files; the UI draws the diff. |
| tool content `terminal` | text `[terminal id]` | **GAP:** AHP wants a terminal channel (`ahp-terminal:`); only relevant if we offer the ACP terminal capability, which today we do not. |
| `plan` | pseudo tool call `x-iinc-plan`: checklist text as content, entries in `_meta["iinc.plan"]`, completed at turn end | **GAP:** no plan part or state. The `x-` prefix is the spec's reserved extension space. |
| `available_commands_update` | `session/metaChanged` (`iinc.commands`) and served through the stable `completions` command | **GAP:** no slash-command list in state. |
| `current_mode_update` | `session/configChanged{mode}` | Modes are session config, see below. |
| `config_option_update` | `session/configChanged{values}` | **GAP:** the config **schema** cannot change after `createSession` (no action for it). Values can. |
| `user_message_chunk` | none | Only appears when replaying `session/load`; the host owns the transcript, so a live conversation ignores it. Importing a foreign session would turn these into `turnStarted`. |
| `usage_update` (unstable: context used and size) | `chat/usage` `_meta` | Token counts come from the prompt result's `_meta`. `_claude/rateLimit` stays a host concern (account meters), not AHP. |
| `session_info_update` (unstable title) | `session/titleChanged` | Not exercised in the spike. |
| unknown `sessionUpdate` | ignored and counted | Forward compatible by construction. |
| `session/request_permission` | `chat/toolCallReady` without `confirmed` = `pending-confirmation` with `options[]`, `confirmationTitle`, `edits` preview; plus `session/inputNeededSet` | `allow_*` -> `approve`, `reject_*` -> `deny`; ACP `optionId` is the AHP option `id`. **GAP:** AHP has no once-or-always flag, so the mapper puts it in `group` (0 once, 1 always); the labels carry the meaning. |
| prompt result `stopReason` | `end_turn` -> `chat/turnComplete`; `cancelled` -> `chat/turnCancelled`; other -> `chat/error` | An ACP error is `chat/error` with `resumable:false`. |

### Client to agent (AHP actions and commands to ACP)

| AHP | ACP | Notes |
| --- | --- | --- |
| `createSession` | spawn agent, `initialize`, `session/new{cwd, mcpServers}` | The host answers after `session/new`, so the first snapshot already has the agent's modes and options. |
| resume after idle or restart | `session/load` if `agentCapabilities.loadSession`, else `session/new` plus a continuation brief | Proven with the fake agent (step 8). Replayed history is ignored. |
| `chat/turnStarted` (text + attachments) | `session/prompt` blocks: `text`; image attachments -> `image` (needs `promptCapabilities.image`); other embedded -> `resource`; resource -> `resource_link` | **GAP:** annotation and chat attachments have no ACP form; flatten to text if we ever use them. |
| `chat/turnCancelled` | answer outstanding permission requests `cancelled`, notify `session/cancel` | The host ends the turn at once; the agent's late updates are dropped. |
| `chat/toolCallConfirmed` | `session/request_permission` response `{outcome: selected, optionId}` or `cancelled` | No `selectedOptionId`: approve picks `allow_once`, deny picks `reject_once`. **GAP:** `editedToolInput` cannot reach ACP, so advertise `editable:false`. |
| `session/configChanged{mode}` | `session/set_mode` | Other keys -> `session/set_config_option`. The host validates against the schema first (unknown key or value is rejected). |
| `chat/pendingMessageSet` `queued` | host queue, next `session/prompt` when idle | Proven (test). |
| `chat/pendingMessageSet` `steering` | treated as queued | **GAP:** ACP has no mid-turn injection. Options: queue it, or cancel and re-prompt. |
| `chat/turnResume` | none | **GAP:** ACP cannot resume a failed turn; we set `resumable:false`. A "continue" re-prompt is the honest equivalent. |
| `createChat` (extra chats), fork | extra `session/new` on the same agent process | Fork would copy history into a brief. Not built. |
| title, read, archived, draft | host state only | No ACP side. |
| changesets | host computes from git | No ACP side. |
| ACP `fs/*`, `terminal/*` requests | none | We offer neither today (`acp.ts`), so nothing to map. |

### Modes, permission modes and plans

- **Modes are session config.** ACP `session/new` returns `modes` (and `configOptions`); the host builds
  `SessionState.config` from them: a `mode` property with `enum` = the agent's mode ids and `enumLabels` = its names
  (`Always ask`, `Accept edits`, `Plan only`, `Bypass permissions`), `sessionMutable:true`. The composer picker reads the
  schema, so "named as the agent names them" is exactly what AHP's model gives. The default (bypass) is
  `createSession{config:{mode:<bypass id>}}`, then `session/set_mode`; the existing `bypassMode` regex in `acp.ts` finds it.
  The spec's own examples use `mode: agent | plan` and `autoApprove: boolean` the same way.
- **Per-chat mode needs spec 1.1.0.** `chat/configChanged` and `chatMutable` exist on spec `main` (unreleased) but not in
  the 1.0.0 package. With 1.0.0, mode is per session, which is fine while a session has one chat.
- **Plans have no home.** "Plan only" is just a mode value. The agent's plan (the checklist) has no part type; the
  spike's pseudo tool call works and replays correctly. Worth proposing a real part upstream.
- **"Needs you"** is `SessionState.inputNeeded`, which the prototype fills from pending confirmations (step 4).

## 5. VS Code: can it attach to a third-party AHP host over Tailscale?

**Desktop VS Code: yes in practice, but not in Microsoft's published docs. The browser Agents window: unclear, lean no.**

- Microsoft's [remote agent sessions](https://code.visualstudio.com/docs/agents/run/remote-agent-sessions.md) page
  documents three ways to connect: SSH, dev tunnels, and the browser Agents window at `insiders.vscode.dev/agents`
  (which reaches your machine through a dev tunnel and signs in with GitHub). It never mentions connecting by URL or
  to a non-Microsoft host. It does name the setting `chat.remoteAgentHostsEnabled`. The
  [architecture page](https://code.visualstudio.com/docs/agents/concepts/agent-host.md) says `code agent host` listens
  on localhost behind a connection token, and `--tunnel` exposes it.
- The third-party `ahpd` project documents (and tracks against VS Code 1.141.1 source) a `settings.json` entry that
  attaches VS Code to any host by address:

  ```jsonc
  "chat.remoteAgentHostsEnabled": true,
  "chat.remoteAgentHosts": [{ "name": "i-inc", "address": "wss://iinc.<tailnet>.ts.net/ahp", "connectionToken": "<token>" }]
  ```

  Its docs say `address` takes a bare `host:port` or a full `ws://` or `wss://` URL and that the token is sent as
  `?tkn=<token>` or as `Authorization: Bearer`. So the auth VS Code expects is **a connection token, not OAuth**
  (OAuth only comes into play if an agent declares `protectedResources`). The spike's `/ahp` accepts the cookie, a
  bearer header and `?tkn=`, so it already matches.
- **Not verified here** (the brief forbade installing extensions or changing settings), so "yes" rests on the third
  party's reading of VS Code's source. Two things to expect when we test it: VS Code 1.141 offers wire version `0.10.0`,
  which the published package does not know (the official `negotiateProtocolVersion` would answer `0.9.0`, and VS
  Code then falls back to legacy behaviours); a host that wants to look current treats `0.10.0` as an alias of the
  1.0.0 contract. And VS Code expects its own agent set, models and session config keys, so our host would show up
  with the agents we publish and be usable but plain.
- The browser window: its documented path is a dev tunnel plus GitHub sign-in. Nothing documents pasting a wss URL
  there. Treat it as no until someone tries.

Verdict for the design: "other surfaces for free" is plausible for desktop VS Code with a one-line setting, and is a good
**acceptance test** for the host later. It should not drive the host's shape.

## 6. Recommendation

### What to adopt

1. **Adopt the official package** (pin exactly, `1.0.0`; bump deliberately): types, reducers, `negotiateProtocolVersion`,
   `isClientDispatchable`, and in the web app `AhpClient` + `WebSocketTransport` (12 KB gzipped).
2. **Build the host ourselves** in `apps/daemon`: JSON-RPC dispatcher, subscriptions, sequencing, action log and
   snapshots in the daemon's SQLite (the prototype's `store.ts` is the schema), the ACP mapper, the session host. The
   AHP host is mostly bookkeeping around reducers we do not have to write.
3. **Do not depend on `@ahpd/sdk`.** Read its `agent-acp` mapping and `UPSTREAM.md` as a reference, and run the same
   scripted agent through it as a cross-check when the mapper changes. Revisit only if it grows a second maintainer
   and a durable store.
4. **Our own types are not needed**: the package is small, MIT, dependency-free and browser-safe, which was the
   fallback in conversations.md. The fallback stays unused.

### Transport inside the existing `Bun.serve`

`apps/daemon/src/main.ts` already has one `Bun.serve({ port, hostname, idleTimeout, fetch })`. Add a `websocket` handler
object and a `/ahp` branch to `fetch` (`upgradeAhp` and `ahpWebsocket` in `src/serve.ts` are written for this):

- Auth is the same lock as the REST API (`authorized()` in `api.ts`: the `i_inc` cookie or a bearer), checked in the
  upgrade before AHP starts. A browser sends the cookie on a same-origin WebSocket; Bun (tests, CLI) sends the bearer; add
  `?tkn=` only for VS Code. Reuse the `I_INC_HOSTS` Host check and add an Origin allowlist, because browsers attach
  cookies to cross-site WebSocket handshakes (`SameSite=Strict` is the first lock, Origin the second).
- Everything that is not a session stays REST. `/api/events` (SSE) can stay until the Work screens move over.
- Keep-alive: the AHP client sends `ping` about every 25 s (same as the SSE heartbeat); Bun answers WebSocket pings and
  `sendPings` is on.

### Reconnect through the Tailscale Service

The daemon is already reached as `https://iinc.<tailnet>.ts.net` via `tailscale serve --service=svc:iinc --https=443
http://127.0.0.1:7420`. A WebSocket is an HTTP upgrade through that same listener, so it should work as `wss://` on the
same name; third-party guides describe exactly this setup, but **I did not test it** (no access to the mini, by the
rules). Test it early: hold a socket open idle through the Service and time when it drops.

Reconnect is designed in, not bolted on: the web app keeps `lastSeenServerSeq`, and on any close (phone sleep, Wi-Fi
change, daemon restart for a deploy) reconnects with backoff and sends `reconnect`. The host answers from the SQLite
log, so a deploy or a crash loses nothing (proved in steps 8 and 9). The deployer's "drain" can stay short because
conversations no longer need to finish a turn to survive a restart (an interrupted turn is marked failed and the
user can send "continue"). Re-list sessions after reconnect because notifications are not replayed.

### Estimate (one developer who knows the codebase)

| Piece | Days | Notes |
| --- | --- | --- |
| Protocol core: dispatcher, subscriptions, sequencing, validation and rejections, reconnect, `inputNeeded`, `0.10.0` alias | 2-3 | Prototype covers it; harden and test. |
| SQLite store: schema and migration, snapshot policy, pruning, ContentRef blobs, ticket transcripts moved onto it (replaces `ticket_session_items`) | 3-4 | The migration and keeping tickets working is most of this. |
| Session host: `machineLaunch` into the team sandbox, working copy per conversation, idle suspend and `session/load` resume with fallback brief, per-team limit, credentials | 4 | Largest unknown is how each real adapter behaves on `session/load`. |
| Mapper against the real agents (Claude, Codex, Antigravity): modes and config options, rate-limit metadata, images, errors, abnormal exits, bypass default | 3 | Fake agent covers the shapes; the real ones will surprise us. |
| Changesets (files changed and diffs panel) from git | 2-3 | Can follow the first screen. |
| Web client layer: store on the official client and reducers, optimistic apply and reconcile, reconnect with backoff, Lit bindings | 4-5 | The SDK does not do reconnect or a chat mirror. |
| Tests, hardening, two-client and restart end-to-end | 2-3 | |
| **Host + mapper + store (first four rows)** | **12-15** | About 3 weeks. Plus the web layer: 4-5 more. |

### Risks

- **Spec churn is narrower than feared but real.** 1.0.0 landed 18 days ago after three releases in six weeks; VS Code's
  own host is already ahead on the wire (`0.10.0`), and spec `main` has 1.1.0 changes (`chat/configChanged`, a steering
  list). Mitigation: pin exactly, keep agent-specific code in the mapper, negotiate the version, accept `0.10.0`, treat
  Stable channels as the only dependency (root, session, chat), and keep changesets behind a capability check.
- **Our TypeScript settings vs `const enum`.** Solve before the first real commit (patch, or constants).
- **Gaps that need workarounds on our side:** plans, slash commands, locations, once-or-always, steering, dynamic config
  schema, chat title. All are in `_meta` or pseudo tool calls today; propose upstream if they matter.
- **Gaps that are limits of ACP, not AHP:** mid-turn steering, resuming a failed turn, editing a tool's input.
- **Bypass-by-default** is unchanged by AHP; the walls stay. One thing improves: confirmations now have an audit trail in
  the action log.
- **Single-socket assumption:** one shared login token means every client is "the owner". Per-device tokens still wait
  for the first non-browser surface, as in conversations.md.
- **Pending confirmations do not survive a host restart** (the ACP agent dies with it). On restart the turn is marked
  failed; the card disappears with it. Fine for V1; say so in the UI.

### Corrections to conversations.md

Small, for the owner to fold in when this is accepted: the spec is **1.0.0, not around 0.9**; `serverSeq` is **host-global**;
`chat/reasoning` and `chat/toolCallConfirmed` are right; modes are **session config** (`session/configChanged`) in 1.0.0,
per-chat only from 1.1.0; and add `session/inputNeededSet` as the "Needs you" source.
