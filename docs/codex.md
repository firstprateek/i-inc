# Codex in team sandboxes

Team sandboxes run the maintained ACP adapter `@agentclientprotocol/codex-acp@2.2.2`
and its matching `@openai/codex@0.160.1` CLI. The adapter is pinned in the employee image, and
`acp-codex` sets `CODEX_PATH` to that CLI so both commands use the same Codex release and the same
`/home/employee/.codex` authentication state. New machines contain no credentials.

## Provisioning

For a new team machine, build/deploy the employee image through the reviewed image procedure in
[images/employee/README.md](../images/employee/README.md), then start the team's sandbox through the
app so `inc-<team-id>` exists. For a machine created from an older image, an owner may update only
that existing team sandbox from the repository checkout on the mini:

```sh
sh tools/host/provision-codex.sh <team-id>
```

The helper requires a fresh `/var/run/i-inc-walls.ok` marker and refuses missing machines. It
installs the exact adapter and CLI versions in the employee's local npm prefix and copies only the
Codex launcher support files into that sandbox. It does not create/delete machines or install
packages on the mini host.

## Owner sign-in

After the machine exists and Codex is provisioned, the owner can sign in from a terminal on the
mini. These owner-run commands have not been executed as part of implementation or review; run them
only after reviewing the target team ID and the device-login prompt:

```sh
sh tools/host/sign-in-codex.sh <team-id>
```

The script runs the pinned CLI's `codex login --device-auth` interactively inside the named
sandbox. Open the official device page it prints and enter the one-time code there; never paste or
share the code. Device-code authentication may need to be enabled for Codex in the account's
ChatGPT security settings or by its workspace administrator. No sign-in is needed for image checks.

To check setup without printing account identity, run:

```sh
sh tools/host/codex-status.sh <team-id>
```

It prints only `true` or `false`. Both sign-in and status require the fresh walls marker and an
existing machine. The sandbox home is shared by the team's agents; their code can use the signed-in
Codex account, just as it can use the other harness sign-ins stored in that sandbox.

The ACP adapter advertises model, reasoning-effort, approval and sandbox configuration options.
The daemon selects the configured engine model, ticket reasoning effort, and full-access mode from
the values advertised by each ACP session before sending work. It reports a clear failure if the
configured choice is unavailable; it does not silently substitute a model. Options depend on the
account and selected model. Adapter rate-limit snapshots are not yet exposed as
structured ACP data; current error/quota handling uses the adapter's turn errors.

Upstream pins and interfaces: [adapter v2.2.2 release](https://github.com/agentclientprotocol/codex-acp/releases/tag/v2.2.2),
[adapter package manifest](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/package.json),
[adapter README](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/README.md),
[Codex CLI device login](https://developers.openai.com/codex/auth#login-on-headless-devices).

## Add an employee and verify

In Setup → Engines and accounts, add the subscription account and an engine with the Codex CLI
harness, a model ID supported by that account, and that account selected. Codex is a cloud engine
and cannot be marked local. In Hiring, select that engine as the default or for a duty, and choose
fallbacks as needed. The inline engine creator offers the same provider. Employees retain their
role, instructions and brain when their engine changes. Interactive employee chat continues to use
the local chat service, as it does for the other harnesses.

After owner sign-in, check Setup → Sandboxes for the Codex sign-in badge. Run a small code ticket
with this engine and inspect its session transcript, selected engine and final checks. A successful
login alone does not verify model access or a completed turn; confirm those together with the owner.
No live subscription turn or employee-image build was performed during development; mocked protocol
and host-helper tests plus an isolated published-package unauthenticated handshake were run.
