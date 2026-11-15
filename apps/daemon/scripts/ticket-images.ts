// An owner-side device check for ticket images (#14, #34): file a ticket with six 10 MB images through the running
// daemon, the way the web app does, wait for the assignee to pick it up, and compare what arrived in the team's
// machine with what was sent. It runs ON THE MAC MINI (the daemon's port is local, and so is the token):
//
//   bun apps/daemon/scripts/ticket-images.ts --assignee <id> --project <id> [--count 6] [--mb 10] [--timeout 900]
//
// It reads the bearer token from ~/.config/i-inc/web-token (never printed), makes the images (a JPEG header and
// random bytes, so each is exactly the size asked for), posts them with a new low-effort chore in one multipart
// `POST /api/tickets`, and reads each one back from the daemon. Then it watches the ticket's events until
// `attachments-copied` for the assignee, and runs `sha256sum` over `.inc/attachments/` in the team's machine
// (`container machine run -i -u employee -n inc-<team> -- bash -s`, only while `machine ls` shows it running, so
// it never boots one). It prints a line per image and how long pick-up took. The ticket is left for the owner
// to close. Exit code: 0 when every image arrived intact, 1 when one didn't (or the ticket failed), 2 on a
// timeout or any error reaching the daemon or the machine, 64 on a bad command line.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { configDir, readOwnerOnly } from "../src/config.ts";
import { parseMachineListing, workDir } from "../src/machines.ts";
import { urlProblem } from "./converse.ts";

// biome-ignore lint/suspicious/noExplicitAny: the API's JSON is read loosely, the way a client would.
type Any = any;

/** Runs a script in a machine and gives back its exit code and output. */
export type InMachine = (machine: string, script: string) => Promise<{ code: number; output: string }>;

export interface CheckOptions {
  /** The daemon, such as http://127.0.0.1:7420. */
  baseUrl: string;
  /** The daemon's bearer token. Never written to `out`. */
  token: string;
  assignee: string;
  project: string;
  count?: number;
  /** Each image's size in bytes. Default: 10 MB, the most a ticket takes. */
  bytes?: number;
  timeoutMs?: number;
  pollMs?: number;
  out?: (text: string) => void;
  fetch?: typeof fetch;
  inMachine?: InMachine;
  sleep?: (ms: number) => Promise<void>;
}

export interface CheckResult {
  /** 0 all intact, 1 an image differs or the ticket failed, 2 a timeout or something unreachable. */
  code: 0 | 1 | 2;
  ticket: string | null;
  /** Images whose stored copy (read back from the daemon) matched. */
  stored: number;
  /** Images whose copy in the worktree matched. */
  copied: number;
  /** From filing the ticket to its draft PR, and to the images being in the worktree. */
  prMs?: number;
  copiedMs?: number;
  detail?: string;
}

const MB = 1024 * 1024;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** An image of exactly `bytes` that the daemon takes as a JPEG (it tells types by their leading bytes). */
export function fakeJpeg(bytes: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(bytes);
  b.set(randomBytes(bytes));
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
}

/** The script that hashes a ticket's images in its worktree; one `<sha256>  <file>` line each. */
export function hashScript(ticketId: string): string {
  return ["set -e", `cd ${workDir(ticketId)}/.inc/attachments`, "sha256sum -- *"].join("\n");
}

/** `sha256sum` output as file name → hash. */
export function readHashes(output: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of output.split("\n")) {
    const r = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (r) m.set(r[2] as string, r[1] as string);
  }
  return m;
}

/** Files the ticket, waits for pick-up and compares hashes. Never rejects. */
export async function checkTicketImages(o: CheckOptions): Promise<CheckResult> {
  const out = o.out ?? ((t: string) => void process.stdout.write(t));
  const fetchFn = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const inMachine = o.inMachine ?? containerRun();
  const base = o.baseUrl.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${o.token}` };
  const count = o.count ?? 6;
  const bytes = o.bytes ?? 10 * MB;
  const result: CheckResult = { code: 2, ticket: null, stored: 0, copied: 0 };
  const fail = (code: 1 | 2, detail: string): CheckResult => {
    out(`${detail}\n`);
    return { ...result, code, detail };
  };
  const bad = urlProblem(o.baseUrl);
  if (bad) return fail(2, bad);
  try {
    // 1. The images, and the ticket with them in one upload.
    const images = Array.from({ length: count }, (_, i) => {
      const data = fakeJpeg(bytes);
      return { name: `check-${i + 1}.jpg`, data, hash: sha256(data) };
    });
    const form = new FormData();
    form.set(
      "ticket",
      JSON.stringify({
        title: `Device check: ${count} images of ${(bytes / MB).toFixed(1)} MB arrive in the worktree`,
        project: o.project,
        type: "chore",
        effort: "low",
        assignee: o.assignee,
        doneWhen: [
          "Nothing to build: this ticket only checks that its images reach your worktree. Change nothing and say you're done.",
        ],
      }),
    );
    for (const im of images) form.append("image", new Blob([im.data], { type: "image/jpeg" }), im.name);
    const started = Date.now();
    const made = await fetchFn(`${base}/api/tickets`, {
      method: "POST",
      // Like the web app: an upload carries the header that only a same-site client can add (api.ts).
      headers: { ...auth, "x-i-inc-upload": "1" },
      body: form,
    });
    const body = (await made.json().catch(() => ({}))) as Any;
    if (made.status !== 201 || !body.ticket?.id) {
      return fail(
        made.status === 401 ? 2 : 1,
        `the daemon refused the ticket (${made.status}): ${body.error ?? "no reason given"}`,
      );
    }
    const id = String(body.ticket.id);
    result.ticket = id;
    const attached: { n: number; name: string }[] = body.ticket.attachments ?? [];
    out(`ticket ${id} filed with ${attached.length} of ${count} images in ${Date.now() - started} ms\n`);
    if (attached.length !== count) return fail(1, `the ticket has ${attached.length} images, not ${count}`);

    // 2. What the daemon stored, read back.
    const expected = new Map<string, string>();
    for (const [i, a] of attached.entries()) {
      const sent = images[i] as (typeof images)[number];
      const file = `${a.n}-${a.name}`;
      expected.set(file, sent.hash);
      const got = await fetchFn(`${base}/api/tickets/${id}/attachments/${a.n}`, { headers: auth });
      const hash = got.ok ? sha256(new Uint8Array(await got.arrayBuffer())) : `HTTP ${got.status}`;
      if (hash === sent.hash) result.stored++;
      out(`stored  ${file}  ${hash === sent.hash ? "same" : `DIFFERS (${hash})`}\n`);
    }
    if (result.stored !== count)
      return fail(1, `${count - result.stored} stored images differ from what was sent`);

    // 3. The assignee picks it up: the draft PR, then the copy into the worktree.
    // The daemon stamps events with this machine's clock, so they are timed from just before the upload.
    const deadline = Date.now() + (o.timeoutMs ?? 900_000);
    for (;;) {
      const r = await fetchFn(`${base}/api/tickets/${id}`, { headers: auth });
      const view = (await r.json().catch(() => ({}))) as Any;
      const events: Any[] = Array.isArray(view.events) ? view.events : [];
      const pr = events.find((e) => e.type === "pr-opened");
      const copied = events.find(
        (e) =>
          e.type === "attachments-copied" &&
          e.employeeId === o.assignee &&
          e.upTo >= (attached.at(-1)?.n ?? 0),
      );
      const failed = events.find((e) => e.type === "failed");
      if (pr) result.prMs = pr.at - started;
      if (copied) {
        result.copiedMs = copied.at - started;
        break;
      }
      if (failed)
        return fail(
          1,
          `the ticket failed before its images were copied: ${failed.reason ?? "no reason given"}`,
        );
      if (Date.now() > deadline) return fail(2, `no pick-up of ticket ${id} within the timeout`);
      await sleep(o.pollMs ?? 2000);
    }
    out(
      `picked up: draft PR after ${seconds(result.prMs)}, images in the worktree after ${seconds(result.copiedMs)}\n`,
    );

    // 4. What arrived in the machine.
    const team = await teamOf(fetchFn, base, auth, o.assignee);
    const machine = `inc-${team}`;
    const run = await inMachine(machine, hashScript(id));
    if (run.code !== 0)
      return fail(2, `couldn't hash the images in ${machine} (exit ${run.code}): ${run.output.trim()}`);
    const found = readHashes(run.output);
    for (const [file, hash] of expected) {
      const got = found.get(file);
      if (got === hash) result.copied++;
      out(`copied  ${file}  ${got === hash ? "same" : got ? `DIFFERS (${got})` : "MISSING"}\n`);
    }
    if (result.copied !== count)
      return fail(1, `${count - result.copied} images in ${machine} differ or are missing`);
    out(
      `all ${count} images arrived intact in ${machine}. Close ticket ${id} in the app when you're done.\n`,
    );
    return { ...result, code: 0 };
  } catch (e) {
    return fail(2, `couldn't finish the check: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const seconds = (ms: number | undefined) => (ms === undefined ? "?" : `${(ms / 1000).toFixed(1)} s`);

/** The assignee's team, as the daemon names machines (`inc-<team>`); "company" when it's on none. */
async function teamOf(fetchFn: typeof fetch, base: string, auth: Record<string, string>, employee: string) {
  const r = await fetchFn(`${base}/api/teams`, { headers: auth });
  const teams: { id: string; members: string[] }[] = ((await r.json().catch(() => ({}))) as Any).teams ?? [];
  return teams.find((t) => t.members.includes(employee))?.id ?? "company";
}

/** Runs the script over `machine run -i … bash -s` as employee, only if `machine ls` shows the machine running. */
export const containerRun =
  (bin = "/usr/local/bin/container"): InMachine =>
  async (machine, script) => {
    const ls = spawnSync(bin, ["machine", "ls"], { encoding: "utf8" });
    if (ls.status !== 0) return { code: 2, output: `container machine ls failed: ${ls.stderr || ls.error}` };
    const row = parseMachineListing(ls.stdout).find((r) => r.name === machine);
    if (row?.state !== "running")
      return { code: 2, output: `${machine} isn't running, and this never boots one` };
    return new Promise((resolve) => {
      const child = spawn(bin, ["machine", "run", "-i", "-u", "employee", "-n", machine, "--", "bash", "-s"]);
      let output = "";
      child.stdout.on("data", (c) => {
        output += c;
      });
      child.stderr.on("data", (c) => {
        output += c;
      });
      child.on("error", (e) => resolve({ code: 2, output: e.message }));
      child.on("close", (code) => resolve({ code: code ?? 2, output }));
      child.stdin.end(`${script}\n`);
    });
  };

// ---- The command line -------------------------------------------------------------------------------

const usage =
  "usage: bun apps/daemon/scripts/ticket-images.ts --assignee <id> --project <id> [--count <n>] [--mb <size>] [--timeout <seconds>] [--url <daemon>] [--token-file <path>]";

export interface Parsed {
  assignee: string;
  project: string;
  count: number;
  bytes: number;
  timeoutMs: number;
  url: string;
  tokenFile: string;
}

/** The command line, or the reason it is wrong. */
export function parseArgs(argv: string[]): Parsed | string {
  const p: Parsed = {
    assignee: "",
    project: "",
    count: 6,
    bytes: 10 * MB,
    timeoutMs: 900_000,
    url: "http://127.0.0.1:7420",
    tokenFile: join(configDir(), "web-token"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = () => argv[++i] ?? "";
    if (a === "--assignee") p.assignee = value();
    else if (a === "--project") p.project = value();
    else if (a === "--count") p.count = Number(value());
    else if (a === "--mb") p.bytes = Math.round(Number(value()) * MB);
    else if (a === "--timeout") p.timeoutMs = Number(value()) * 1000;
    else if (a === "--url") p.url = value();
    else if (a === "--token-file") p.tokenFile = value();
    else return `unknown argument ${a}`;
  }
  if (!p.assignee) return "--assignee is required";
  if (!p.project) return "--project is required";
  if (!Number.isInteger(p.count) || p.count < 1 || p.count > 6)
    return "--count is 1 to 6 (a ticket takes six at a time)";
  if (!Number.isFinite(p.bytes) || p.bytes < 4 || p.bytes > 10 * MB)
    return "--mb is more than 0 and at most 10";
  if (!Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0) return "--timeout is a number of seconds";
  return urlProblem(p.url) ?? p;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(`${args}\n${usage}`);
    process.exit(64);
  }
  let token: string;
  try {
    token = readOwnerOnly(args.tokenFile).trim();
  } catch (e) {
    console.error(`couldn't read the token file ${args.tokenFile}: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  const r = await checkTicketImages({
    baseUrl: args.url,
    token,
    assignee: args.assignee,
    project: args.project,
    count: args.count,
    bytes: args.bytes,
    timeoutMs: args.timeoutMs,
  });
  process.exit(r.code);
}
