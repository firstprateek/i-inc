// The owner's device check for ticket images (scripts/ticket-images.ts) against the in-process daemon: the upload
// is the real multipart API, the stored copies are read back, and pick-up is played by the real attachment
// script into a temp root, hashed by the real hash script in bash. A changed or missing copy, a failed ticket, a
// timeout and a stopped machine each end with the exit code they should, and the token is never printed.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkTicketImages,
  containerRun,
  fakeJpeg,
  hashScript,
  type InMachine,
  parseArgs,
  readHashes,
} from "../../scripts/ticket-images.ts";
import { sniffImage } from "../../src/images.ts";
import { attachmentScript, WORK_ROOT } from "../../src/workspace.ts";
import { testApp } from "../setup.ts";

const TOKEN = "s3cret-token-value";
const KB = 1024;

const bash = (script: string): Promise<{ code: number; output: string }> =>
  new Promise((resolve) => {
    const child = spawn("bash", ["-s"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (c) => {
      output += c;
    });
    child.stderr.on("data", (c) => {
      output += c;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.stdin.end(script);
  });

/** A machine whose /home/employee/work is a temp folder. */
function fakeMachine() {
  const root = mkdtempSync(join(tmpdir(), "ticket-images-"));
  const machines: string[] = [];
  const inMachine: InMachine = (machine, script) => {
    machines.push(machine);
    return bash(script.replaceAll(WORK_ROOT, `${root}/`));
  };
  return {
    root,
    machines,
    inMachine,
    run: (script: string) => bash(script.replaceAll(WORK_ROOT, `${root}/`)),
  };
}

async function rig() {
  const app = await testApp();
  const fetchFn = ((url: string | URL | Request, init?: RequestInit) =>
    app.handle(new Request(url, init))) as typeof fetch;
  const machine = fakeMachine();
  const lines: string[] = [];
  /** Plays pick-up: copies the stored images into the worktree, as the workspace does, and logs the events. */
  const pickUp = async (id: string, o: { corrupt?: number; skip?: number } = {}) => {
    const worktree = `${WORK_ROOT}inc-${id}`;
    for (const file of app.deps.tickets.attachments(id)) {
      if (file.n === o.skip) continue;
      const data = file.n === o.corrupt ? fakeJpeg(file.data.length) : file.data;
      const r = await machine.run(attachmentScript({ worktree, file: { ...file, data } }));
      expect(r.output).toContain("@@attached");
    }
    const at = Date.now();
    const upTo = Math.max(...app.deps.tickets.attachments(id).map((a) => a.n));
    await app.deps.store.append(id, [
      { type: "pr-opened", at, pr: { number: 1, url: "https://github.com/o/r/pull/1" }, employeeId: "ada" },
      { type: "attachments-copied", at, employeeId: "ada", upTo },
    ] as never);
  };
  const run = (
    over: Partial<Parameters<typeof checkTicketImages>[0]> = {},
    onWait?: (id: string) => unknown,
  ) => {
    let waited = false;
    return checkTicketImages({
      baseUrl: "http://127.0.0.1:7420",
      token: TOKEN,
      assignee: "ada",
      project: "Duet",
      bytes: 256 * KB,
      timeoutMs: 5000,
      pollMs: 1,
      fetch: fetchFn,
      inMachine: machine.inMachine,
      out: (t) => void lines.push(t),
      sleep: async () => {
        if (waited) return;
        waited = true;
        const id = lines.join("").match(/ticket (\S+) filed/)?.[1] as string;
        await (onWait ?? pickUp)(id);
      },
      ...over,
    });
  };
  return { app, machine, run, pickUp, lines, text: () => lines.join("") };
}

describe("ticket-images.ts", () => {
  it("files six images, reads them back, and finds the same six in the worktree (exit 0)", async () => {
    const t = await rig();
    const r = await t.run();
    expect(r).toMatchObject({ code: 0, stored: 6, copied: 6 });
    expect(r.copiedMs).toBeGreaterThanOrEqual(0);
    const out = t.text();
    expect(out).toMatch(/ticket \S+ filed with 6 of 6 images/);
    expect(out.match(/^stored {2}\d+-check-\d\.jpg {2}same$/gm)).toHaveLength(6);
    expect(out.match(/^copied {2}\d+-check-\d\.jpg {2}same$/gm)).toHaveLength(6);
    expect(out).toContain("all 6 images arrived intact in inc-company");
    expect(t.machine.machines).toEqual(["inc-company"]);
    // a low-effort chore the owner can tell apart, assigned as asked, with its images
    const ticket = t.app.deps.tickets.get(r.ticket as string)?.ticket;
    expect(ticket).toMatchObject({ type: "chore", effort: "low", assignee: "ada", project: "Duet" });
    expect(ticket?.title).toMatch(/^Device check: 6 images/);
    expect(ticket?.attachments?.map((a) => a.size)).toEqual(Array(6).fill(256 * KB));
  });

  it("hashes the machine of the assignee's team", async () => {
    const t = await rig();
    t.app.deps.registry.addTeam({ id: "core", name: "Core", members: ["ada"] });
    expect((await t.run({ count: 1 })).code).toBe(0);
    expect(t.machine.machines).toEqual(["inc-core"]);
  });

  it("names a copy that differs, and one that is missing (exit 1)", async () => {
    const t = await rig();
    const r = await t.run({}, (id) => t.pickUp(id, { corrupt: 2, skip: 5 }));
    expect(r).toMatchObject({ code: 1, stored: 6, copied: 4 });
    expect(t.text()).toMatch(/^copied {2}2-check-2\.jpg {2}DIFFERS \([0-9a-f]{64}\)$/m);
    expect(t.text()).toMatch(/^copied {2}5-check-5\.jpg {2}MISSING$/m);
    expect(t.text()).toContain("2 images in inc-company differ or are missing");
  });

  it("stops when the ticket fails before the copy (exit 1)", async () => {
    const t = await rig();
    const r = await t.run({}, (id) =>
      t.app.deps.store.append(id, [
        { type: "failed", at: Date.now(), stage: "pickup", reason: "no machine", tried: [] },
      ] as never),
    );
    expect(r).toMatchObject({ code: 1, copied: 0 });
    expect(t.text()).toContain("the ticket failed before its images were copied: no machine");
  });

  it("gives up after the timeout when nobody picks it up (exit 2)", async () => {
    const t = await rig();
    const r = await t.run({ timeoutMs: 30 }, () => new Promise((res) => setTimeout(res, 40)));
    expect(r.code).toBe(2);
    expect(t.text()).toMatch(/no pick-up of ticket \S+ within the timeout/);
  });

  it("says why the daemon refused the ticket, and never prints the token", async () => {
    const t = await rig();
    const r = await t.run({ project: "" });
    expect(r).toMatchObject({ code: 1, ticket: null });
    expect(t.text()).toContain("the daemon refused the ticket (400): a ticket needs a project");
    expect(t.text()).not.toContain(TOKEN);
  });

  it("won't send the token in the clear to another machine", async () => {
    const t = await rig();
    const r = await t.run({ baseUrl: "http://mini.tailnet:7420" });
    expect(r.code).toBe(2);
    expect(t.text()).toContain("the token would be sent in the clear");
  });
});

describe("the pieces", () => {
  it("makes images of exactly the size asked for, which the daemon takes as JPEG", () => {
    const b = fakeJpeg(10 * 1024 * KB);
    expect(b.length).toBe(10 * 1024 * KB);
    expect(sniffImage(b)).toBe("image/jpeg");
  });

  it("reads sha256sum's lines, text or binary mode", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(readHashes(`${a}  1-x.jpg\n${b} *2-y.jpg\nnoise\n`)).toEqual(
      new Map([
        ["1-x.jpg", a],
        ["2-y.jpg", b],
      ]),
    );
  });

  it("hashes in the ticket's worktree, and refuses an id that isn't one", () => {
    expect(hashScript("34")).toContain("cd /home/employee/work/inc-34/.inc/attachments");
    expect(() => hashScript("../x")).toThrow();
  });

  it("never runs anything in a machine that isn't running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-container-"));
    const bin = join(dir, "container");
    const calls = join(dir, "calls");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `echo "$@" >> ${calls}`,
        'if [ "$2" = ls ]; then',
        '  echo "ID IMAGE OS ARCH STATE ADDR"',
        '  echo "inc-core i linux arm64 1.2G stopped -"',
        '  echo "inc-web i linux arm64 1.2G running 192.168.64.3"',
        "  exit 0",
        "fi",
        "cat",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    expect(await containerRun(bin)("inc-core", "echo hi")).toEqual({
      code: 2,
      output: "inc-core isn't running, and this never boots one",
    });
    expect(readFileSync(calls, "utf8")).toBe("machine ls\n");
    // a running one gets the script on stdin, through machine run as employee
    expect(await containerRun(bin)("inc-web", "echo hi")).toEqual({ code: 0, output: "echo hi\n" });
    expect(readFileSync(calls, "utf8")).toBe(
      "machine ls\nmachine ls\nmachine run -i -u employee -n inc-web -- bash -s\n",
    );
  });

  it("reads the command line", () => {
    expect(parseArgs(["--assignee", "ada", "--project", "Duet"])).toMatchObject({
      assignee: "ada",
      project: "Duet",
      count: 6,
      bytes: 10 * 1024 * KB,
      timeoutMs: 900_000,
      url: "http://127.0.0.1:7420",
    });
    expect(
      parseArgs(["--assignee", "ada", "--project", "Duet", "--count", "2", "--mb", "0.5"]),
    ).toMatchObject({
      count: 2,
      bytes: 512 * KB,
    });
    expect(parseArgs(["--project", "Duet"])).toBe("--assignee is required");
    expect(parseArgs(["--assignee", "ada", "--project", "Duet", "--count", "7"])).toMatch(/1 to 6/);
    expect(parseArgs(["--assignee", "ada", "--project", "Duet", "--mb", "11"])).toMatch(/at most 10/);
    expect(parseArgs(["--assignee", "ada", "--project", "Duet", "--url", "http://10.0.0.2:7420"])).toMatch(
      /in the clear/,
    );
    expect(parseArgs(["--nope"])).toBe("unknown argument --nope");
  });
});
