# M1 runbook: one employee, one ticket, by hand

M1 runs on the owner's Mac mini, in a Claude Code session there, because cloud sessions can't
reach the home tailnet. Its job is to prove, or disprove, the parts of the spec that only real
hardware can answer (spec §13, "To verify in M1"), before the daemon (M3) is built on top of them.

Read `docs/spec.md` first, especially §5 "Lenient permissions, hard walls", §6, §12 and §13.

## Ground rules

- **Ask the owner before every system-level change**: installing software, anything with `sudo`,
  `pf` rules, LaunchAgents, and each sign-in. Show the exact command first.
- **Never weaken a wall** to make something work. If a step needs the machine to reach the LAN,
  the tailnet or the host's services (other than i.inc's API and Ollama), stop and ask.
- **Secrets never go into the repo** (it's public): no tokens, no account names, no hostnames or IP
  addresses of the home network. Findings use placeholders such as `<mini>`.
- **Verify commands against the current docs** before running them. Apple container is new, and
  flags change: read https://github.com/apple/container/blob/main/docs/container-machine.md and the
  project's own docs, rather than relying on memory.
- **Record as you go** in `docs/m1-findings.md` (the template is below): what was run, what
  happened, and the answer to each question. A failed check is a result, not a problem to hide.
- Scripts that are worth keeping go under `tools/m1/`. Commit on a branch and open a PR at the end.

## Steps

### 1. Host check (read only)

- macOS version, chip, cores, memory and free disk. Confirm the spec's numbers in §12.
- Is Ollama installed and running, which models are pulled, and which address does it listen on?
- Are Colima or Docker running? (They should stay stopped.)

### 2. Apple container and one machine

- Install Apple container (from its signed release), and start its system service.
- Create one persistent machine for a test employee called `m1-test`, with no home-directory mount,
  about 4 CPUs and 6 GB of memory (spec §12), and a Linux distribution the harnesses support.
- Record: create time, boot time, idle memory on the host, and how the machine's network is
  attached (which interface and subnet the `pf` rules will need to target).

### 3. The walls (`pf`)

Write a `pf` anchor for the machines' subnet that:

- allows outbound internet;
- blocks the LAN ranges, the tailnet range (100.64.0.0/10) and every service on the host,
  **except** i.inc's API port and Ollama's port;
- blocks all inbound connections to the machines;
- logs outbound connections, so the domains each employee contacts can be listed.

Then prove it from inside the machine: the internet works; the router, another LAN device, a
tailnet address and a host service are all unreachable; Ollama is reachable. Keep the anchor file
in `tools/m1/pf/` with placeholders in place of real addresses, and record how to load and unload it.

### 4. Harnesses, adapters and sign-in

Inside the machine, install Claude Code, Antigravity and OpenCode, and each one's ACP adapter or
server (see https://agentclientprotocol.com/get-started/agents). Antigravity replaced Gemini CLI for
Google AI Pro accounts on June 18, 2026 (spec §13). Sign in to the owner's Claude Pro and Google
AI Pro accounts **inside the machine**, with the owner doing each login. Record whether a
browser-less sign-in flow works, and where each tool stores its credential.

### 5. Drive an employee over ACP

Write a small probe, `tools/m1/acp-probe.ts` (run with Node 22 or Bun), that starts an adapter
**inside the machine** over stdio from the host (via the container tool's exec), and then:

1. sends `initialize`, `session/new` and a short prompt;
2. sets the harness's bypass mode (Claude Code `bypassPermissions`, Antigravity's equivalent,
   OpenCode allow-all), and auto-approves any `session/request_permission`;
3. streams the updates, and logs every tool call;
4. records whether Claude Code's `rate_limit_event` (status and `resetsAt`) comes through the
   adapter. If it doesn't, record what the "limit reached" error looks like instead.

### 6. A real ticket, then an engine switch

- Pick a small, real Duet ticket with the owner.
- Using a fine-grained GitHub token that can only push branches and open PRs on Duet (the GitHub App
  comes in M3), have the test employee take it to a **draft PR** on a branch
  `inc/<id>-<slug>`.
- Halfway through (for example after the plan), stop the Claude session and continue on Gemini
  from a resume brief: the ticket, the plan, the progress notes, `git log`, and the last error.
  Record what the second engine got right and what it lost.

### 7. The remaining unknowns

- Does Docker (or another container runtime) work inside a machine, given nested virtualization?
- Can the machine be stopped and restarted without losing the worktree or the sign-ins?
- What does one machine cost in host memory, idle and busy? How many fit at once (the K in §9)?
- The mini's power draw, idle and busy, for My desk's electricity estimate.

## Findings template (`docs/m1-findings.md`)

```md
# M1 findings

Date, macOS version, Apple container version.

| Question | Answer | Evidence |
| --- | --- | --- |
| ACP stdio works through the machine boundary | yes / no / partly | … |
| Sign-in works inside the machine (each harness) | … | … |
| `rate_limit_event` passes through the Claude adapter | … | … |
| `pf` walls hold (internet ok; LAN, tailnet, host blocked; Ollama ok) | … | … |
| Ollama reachable from a machine | … | … |
| Docker inside a machine | … | … |
| Resume on another engine from a brief | … | … |
| Machine memory idle / busy, and K for this host | … | … |
| Host power idle / busy (W) | … | … |

## What the spec should change
```

## Done when

- `docs/m1-findings.md` answers every question above.
- `tools/m1/` holds the `pf` anchor (with placeholders) and the ACP probe.
- A draft PR exists on Duet from the test employee, and it was switched to Gemini partway.
- A PR on i-inc carries the findings, the tools, and any spec changes they call for.
