# Codex in team sandboxes

Team sandboxes run the official maintained ACP adapter `@agentclientprotocol/codex-acp@2.2.2`
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
Clients should use the model and effort values returned by each ACP session because those values
depend on the account and selected model. Adapter rate-limit snapshots are not yet exposed as
structured ACP data; current error/quota handling uses the adapter's turn errors.

Upstream pins and interfaces: [adapter v2.2.2 release](https://github.com/agentclientprotocol/codex-acp/releases/tag/v2.2.2),
[adapter package manifest](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/package.json),
[adapter README](https://github.com/agentclientprotocol/codex-acp/blob/v2.2.2/README.md),
[Codex CLI device login](https://developers.openai.com/codex/auth#login-on-headless-devices).
