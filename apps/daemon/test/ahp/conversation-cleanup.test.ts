// Archived conversations' working copies go with the sandbox cleanup (T52's script and rules), the
// cleanup lock holds conversations back, and live conversations count as the daemon's work.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MachineOps, Storage } from "../../src/storage.ts";
import { cleanupScript, readCleanup } from "../../src/storage-script.ts";
import { testApp } from "../setup.ts";
import { sessionRig, until } from "./session-rig.ts";
import { type Any, turnStarted } from "./support.ts";

let root: string;
let work: string;
let home: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
    {
      encoding: "utf8",
    },
  );

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "inc-conv-clean-")));
  work = join(root, "work");
  home = join(root, "home");
  mkdirSync(work);
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const base = () => ({
  work,
  ids: [] as string[],
  dryRun: false,
  cacheCapKb: 1_000_000,
  docker: false,
  trim: false,
});
const run = (script: string) => {
  const r = spawnSync("bash", ["-s"], {
    input: script,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: home },
  });
  return readCleanup(r.stdout + r.stderr);
};

/** A conversation's copy as workspace.ts makes it: a worktree on conv/<id>, never pushed. */
function convCopy(id: string, { unpushed = false, dirty = false } = {}) {
  const origin = join(root, "origin.git");
  const repo = join(work, "app");
  if (!existsSync(origin)) {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
    writeFileSync(join(repo, "a.txt"), "a");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");
    git(repo, "push", "-q", "origin", "HEAD:main");
    git(repo, "fetch", "-q");
  }
  const path = join(work, `conv-${id}`);
  git(repo, "worktree", "add", "-q", "-b", `conv/${id}`, path, "origin/main");
  mkdirSync(join(path, "node_modules", "p"), { recursive: true });
  writeFileSync(join(path, "node_modules", "p", "big"), "x".repeat(100_000));
  if (unpushed) {
    writeFileSync(join(path, "work.txt"), "work");
    git(path, "add", "work.txt");
    git(path, "commit", "-q", "-m", "work");
  }
  if (dirty) writeFileSync(join(path, "scratch.txt"), "not committed");
  return path;
}

describe("the cleanup script and archived conversations", () => {
  it("removes a clean archived conversation's copy, reports it as conv-<id>, and git forgets the worktree", () => {
    const path = convCopy("ab12cd34");
    const other = convCopy("keepme01"); // not listed: archived-ness is the daemon's call
    const r = run(cleanupScript({ ...base(), convs: ["ab12cd34"] }));
    expect(r.removed.map((x) => x.ticket)).toEqual(["conv-ab12cd34"]);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(git(join(work, "app"), "worktree", "list")).not.toContain("conv-ab12cd34");
    expect(git(join(work, "app"), "worktree", "list")).toContain("conv-keepme01");
  });

  it("keeps a copy with unpushed commits, or uncommitted changes, until it is aged", () => {
    const unpushed = convCopy("0000aaaa", { unpushed: true });
    const dirty = convCopy("0000bbbb", { dirty: true });
    let r = run(cleanupScript({ ...base(), convs: ["0000aaaa", "0000bbbb"] }));
    expect(r.removed).toEqual([]);
    expect(r.kept).toEqual([
      { ticket: "conv-0000aaaa", reason: "unpushed" },
      { ticket: "conv-0000bbbb", reason: "uncommitted" },
    ]);
    expect(existsSync(unpushed) && existsSync(dirty)).toBe(true);
    // past unpushedKeepDays the owner's setting lets them go
    r = run(
      cleanupScript({ ...base(), convs: ["0000aaaa", "0000bbbb"], convsAged: ["0000aaaa", "0000bbbb"] }),
    );
    expect(r.removed.map((x) => x.ticket).sort()).toEqual(["conv-0000aaaa", "conv-0000bbbb"]);
    expect(existsSync(unpushed) || existsSync(dirty)).toBe(false);
  });

  it("keeps any copy git can't read, even an aged one", () => {
    const path = convCopy("0000cccc");
    writeFileSync(join(path, ".git"), "gitdir: /nowhere\n"); // broken link
    const r = run(cleanupScript({ ...base(), convs: ["0000cccc"], convsAged: ["0000cccc"] }));
    expect(r.removed).toEqual([]);
    expect(r.kept[0]).toMatchObject({ ticket: "conv-0000cccc" });
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a repo copy that merely lost its .git, whatever its age (only a no-project folder is plain)", () => {
    const path = convCopy("0000dddd");
    rmSync(join(path, ".git"));
    writeFileSync(join(path, "mine.txt"), "m");
    const r = run(cleanupScript({ ...base(), convs: ["0000dddd"], convsAged: ["0000dddd"] }));
    expect(r.kept[0]).toMatchObject({ ticket: "conv-0000dddd", reason: "notcheckout" });
    expect(existsSync(path)).toBe(true);
  });

  it("treats a no-project folder as plain: empty goes at once, with files when aged", () => {
    const empty = join(work, "conv-e0000001");
    const files = join(work, "conv-f0000001");
    const young = join(work, "conv-f0000002");
    for (const d of [empty, files, young]) mkdirSync(d);
    writeFileSync(join(files, "notes.md"), "n");
    writeFileSync(join(young, "notes.md"), "n");
    const ids = ["e0000001", "f0000001", "f0000002"];
    const r = run(
      cleanupScript({ ...base(), convs: ids, convsScratch: ids, convsAged: ["e0000001", "f0000001"] }),
    );
    expect(r.removed.map((x) => x.ticket).sort()).toEqual(["conv-e0000001", "conv-f0000001"]);
    expect(r.kept).toEqual([{ ticket: "conv-f0000002", reason: "notcheckout" }]);
    expect(existsSync(young)).toBe(true);
  });

  it("refuses a symlink or a folder that isn't where it says, and a dry run changes nothing", () => {
    const target = join(root, "elsewhere");
    mkdirSync(target);
    writeFileSync(join(target, "precious"), "p");
    symlinkSync(target, join(work, "conv-5111c000"));
    const real = convCopy("0000eeee");
    const r = run(cleanupScript({ ...base(), convs: ["5111c000"], convsAged: ["5111c000"] }));
    expect(r.refused).toEqual([{ ticket: "conv-5111c000", reason: "symlink" }]);
    expect(existsSync(join(target, "precious"))).toBe(true);
    const dry = run(cleanupScript({ ...base(), convs: ["0000eeee"], dryRun: true }));
    expect(dry.removed.map((x) => x.ticket)).toEqual(["conv-0000eeee"]);
    expect(existsSync(real)).toBe(true);
  });

  it("takes only plain ids, and tickets' copies are cleaned as before in the same run", () => {
    expect(() => cleanupScript({ ...base(), convs: ["../x"] })).toThrow("not a conversation id");
    expect(() => cleanupScript({ ...base(), convs: ["a"], convsAged: ["$(id)"] })).toThrow(
      "not a conversation id",
    );
    const c = convCopy("0000ffff");
    const t = join(work, "inc-9");
    git(join(work, "app"), "worktree", "add", "-q", "-b", "inc/9", t, "origin/main");
    const r = run(cleanupScript({ ...base(), ids: ["9"], convs: ["0000ffff"] }));
    expect(r.removed.map((x) => x.ticket).sort()).toEqual(["0000ffff".replace(/^/, "conv-"), "9"].sort());
    expect(existsSync(c) || existsSync(t)).toBe(false);
  });
});

describe("storage decides which conversations to clean", () => {
  const GB = 1024 ** 3;
  const DAY_MIN = 24 * 60;
  function fakeOps() {
    const scripts: string[] = [];
    const ops: MachineOps = {
      machineFor: (e) => (e === "zed" ? "inc-design" : "inc-engineering"),
      listMachines: async () => [
        { name: "inc-engineering", state: "running", diskBytes: 20 * GB },
        { name: "inc-design", state: "running", diskBytes: 20 * GB },
      ],
      runIn: async (_m, script) => {
        scripts.push(script);
        return "@@df 20971520 8388608\n@@df-after 20971520 8388608\n@@done";
      },
    };
    return { ops, scripts };
  }
  async function setup() {
    const app = await testApp();
    app.deps.registry.setTeam({ id: "engineering", name: "Engineering", members: ["ada", "kit"] });
    const { ops, scripts } = fakeOps();
    const storage = new Storage({
      db: app.db,
      clock: app.clock,
      registry: app.deps.registry,
      tickets: app.deps.tickets,
      events: app.deps.store,
      paths: { home: home, dbPath: join(home, "i.db"), knowledgeDir: join(home, "k") },
      ops,
      machineBusy: async () => false,
      hostBusy: () => false,
      ticketActive: () => false,
      footprint: () => ({}),
      trim: false,
      archivedConversations: () => app.deps.conversations?.forCleanup() ?? [],
    });
    return { app, storage, scripts };
  }

  it("names an archived conversation once it is past the retention, only in its employee's machine", async () => {
    const { app, storage, scripts } = await setup();
    const mk = async (employeeId: string, project: string | null) =>
      (await app.call("POST", "/api/conversations", { employeeId, ...(project ? { project } : {}) })).body
        .conversation as Any;
    const old = await mk("ada", "Duet");
    const live = await mk("ada", "Duet"); // never archived
    const other = await mk("zed" in {} ? "ada" : "quinn", null);
    await app.call("PATCH", `/api/conversations/${old.id}`, { archived: true });
    await app.call("PATCH", `/api/conversations/${other.id}`, { archived: true });

    // Just archived: not old enough
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(scripts[0]).not.toContain("for cid in");
    app.clock.advance(4 * DAY_MIN);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(scripts[1]).toContain("for cid in");
    expect(scripts[1]).toContain(old.id);
    expect(scripts[1]).not.toContain(live.id);
    expect(scripts[1]).toContain("AGED='  '"); // young: nothing unpushed goes
    // a machine that isn't theirs is not told about them
    await storage.cleanMachine("inc-design", { manual: true });
    expect(scripts[2]).not.toContain(old.id);
    // past unpushedKeepDays (30) they are aged, and a no-project one is plain
    app.clock.advance(27 * DAY_MIN);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(scripts[3]).toContain(`AGED=' conv-${old.id}`);
    expect(scripts[3]).toContain(`SCRATCH=' conv-${other.id} '`);
  });
});

describe("conversations and the daemon's housekeeping", () => {
  it("waits for a cleanup holding the machine, says why in the chat, then goes ahead", async () => {
    let held = false;
    let release!: () => void;
    const freed = new Promise<boolean>((r) => {
      release = () => {
        held = false;
        r(true);
      };
    });
    const t = await sessionRig();
    t.sessions.attachApp({
      storage: { machineOf: () => "inc-engineering", holding: () => held, untilFree: () => freed },
      awake: () => {},
    });
    const c = await t.create();
    const a = await t.client(c);
    t.time.now += 20 * 60_000;
    t.sessions.sweep();
    await until(() => t.sandbox.agents[0]?.exitCode !== undefined);
    held = true; // a cleanup takes the machine
    a.dispatch(c.chat, turnStarted("plain hello", "t1"));
    await until(() => t.host.chatState(c.chat)?.activity?.includes("being cleaned up"));
    expect(t.sandbox.agents).toHaveLength(1); // nothing started yet
    expect(t.host.chatState(c.chat)?.activeTurn?.responseParts[0]).toMatchObject({
      kind: "systemNotification",
    });
    release();
    await until(() => t.host.chatState(c.chat)?.turns.length === 1);
    expect(t.host.chatState(c.chat)?.turns[0]?.state).toBe("complete");
    expect(t.host.chatState(c.chat)?.activity).toBeUndefined();
  });

  it("gives up with a reason if the cleanup runs on", async () => {
    const t = await sessionRig();
    t.sessions.attachApp({
      storage: { machineOf: () => "m", holding: () => true, untilFree: async () => false },
      awake: () => {},
    });
    await expect(t.create()).rejects.toThrow(/still being cleaned up/);
    expect(t.sandbox.launches).toEqual([]);
  });

  it("tells the daemon a machine is awake and in use while a conversation's agent lives, and not after", async () => {
    const awake: string[] = [];
    const t = await sessionRig();
    t.sessions.attachApp({
      storage: { machineOf: () => undefined, holding: () => false, untilFree: async () => true },
      awake: (e) => awake.push(e),
    });
    expect(t.sessions.liveEmployees()).toEqual([]);
    const c = await t.create("c1", { employee: "kit" });
    expect(awake).toEqual(["kit"]);
    expect(t.sessions.liveEmployees()).toEqual(["kit"]);
    t.time.now += 20 * 60_000;
    t.sessions.sweep();
    await until(() => t.sessions.liveEmployees().length === 0);
    expect(c.session).toBeTruthy();
  });

  it("counts a running conversation turn as the daemon's work, for /api/health, the drain and VACUUM", async () => {
    const { FakeAgent, FakeChat, FakeClock, FakeHarness, FakeHelper, FakeMachines } = await import(
      "@i-inc/core/testing"
    );
    const { createApp } = await import("../../src/app.ts");
    const { seedDemo } = await import("../../src/demo.ts");
    const { ScriptedBackend, TestClient, gate } = await import("./support.ts");
    const backend = new ScriptedBackend();
    backend.providers = () => ["opus"];
    const app = await createApp({
      dbPath: ":memory:",
      knowledgeDir: mkdtempSync(join(tmpdir(), "inc-k-")),
      clock: new FakeClock(),
      agent: new FakeAgent(),
      harness: new FakeHarness(),
      helper: new FakeHelper(),
      chat: new FakeChat(),
      machines: new FakeMachines(),
      ahpBackend: backend,
    });
    seedDemo(app.deps.registry);
    expect(app.daemon.busy()).toBe(false);
    const res = await app.handle(
      new Request("http://i.inc/api/conversations", {
        method: "POST",
        body: JSON.stringify({ employeeId: "ada" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const c = ((await res.json()) as Any).conversation;
    const client = new TestClient(app.ahp.host);
    await client.init(["ahp-root://", c.ahpChat]);
    const g = gate();
    backend.script = async () => {
      await g.promise;
      return { kind: "complete" };
    };
    client.dispatch(c.ahpChat, turnStarted("work", "t1"));
    await until(() => app.ahp.host.hasActiveTurn(c.ahpChat));
    expect(app.daemon.busy()).toBe(true); // /api/health and VACUUM's idle check read this
    g.resolve();
    await app.ahp.host.idle();
    await until(() => !app.daemon.busy());
    expect(app.daemon.busy()).toBe(false);
  });

  it("keeps a machine up (neither cleaned nor stopped) while a conversation's agent is live", async () => {
    const app = await testApp();
    expect(await app.daemon.machineBusy("inc-engineering")).toBe(false);
    app.daemon.storage = { machineOf: () => "inc-engineering" } as never;
    app.daemon.onMachineBusy((m) => m === "inc-engineering");
    expect(await app.daemon.machineBusy("inc-engineering")).toBe(true);
    expect(await app.daemon.machineBusy("inc-design")).toBe(false);
  });
});

describe("a conversation's copy is never forgotten", () => {
  const DAY_MIN = 24 * 60;

  /** A storage that runs the cleanup script for real (bash) over the temp work folder. */
  async function realStorage(machineFor: (e: string) => string = () => "inc-engineering") {
    const app = await testApp();
    app.deps.registry.setTeam({ id: "engineering", name: "Engineering", members: ["ada", "kit"] });
    const names = new Set<string>(["inc-engineering", "inc-old"]);
    const ops: MachineOps = {
      machineFor,
      listMachines: async () => [...names].map((name) => ({ name, state: "running" as const, diskBytes: 1 })),
      runIn: async (_m, script) => {
        const r = spawnSync("bash", ["-s"], {
          input: script,
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", HOME: home },
        });
        return r.stdout + r.stderr;
      },
    };
    const storage = new Storage({
      db: app.db,
      clock: app.clock,
      registry: app.deps.registry,
      tickets: app.deps.tickets,
      events: app.deps.store,
      paths: { home, dbPath: join(home, "i.db"), knowledgeDir: join(home, "k") },
      ops,
      work,
      machineBusy: async () => false,
      hostBusy: () => false,
      ticketActive: () => false,
      footprint: () => ({}),
      trim: false,
      archivedConversations: () => app.deps.conversations?.forCleanup() ?? [],
    });
    if (app.deps.conversations) app.deps.conversations.machineOf = (e) => machineFor(e);
    return { app, storage };
  }
  const make = async (app: Awaited<ReturnType<typeof testApp>>, employeeId = "ada") =>
    (await app.call("POST", "/api/conversations", { employeeId })).body.conversation as Any;
  async function dispose(app: Awaited<ReturnType<typeof testApp>>, c: Any) {
    await app.call("PATCH", `/api/conversations/${c.id}`, { archived: true });
    await app.ahp.host.disposeSession(c.ahpSession);
  }

  it("keeps the row of a disposed conversation, archived and hidden, and the cleanup removes its copy by the same rules", async () => {
    const { app, storage } = await realStorage();
    const clean = await make(app);
    const unpushed = await make(app);
    const archivedOnly = await make(app);
    const live = await make(app);
    const copies = {
      clean: convCopy(clean.id),
      unpushed: convCopy(unpushed.id, { unpushed: true }),
      archived: convCopy(archivedOnly.id),
      live: convCopy(live.id),
    };
    await dispose(app, clean);
    await dispose(app, unpushed);
    await app.call("PATCH", `/api/conversations/${archivedOnly.id}`, { archived: true });

    // gone from the API and from the host, still in the table as a tombstone
    expect((await app.call("GET", `/api/conversations/${clean.id}`)).status).toBe(404);
    const listed = (await app.call("GET", "/api/conversations?archived=all")).body.conversations.map(
      (c: Any) => c.id,
    );
    expect(new Set(listed)).toEqual(new Set([archivedOnly.id, live.id]));
    expect(listed).not.toContain(clean.id);
    expect(app.ahp.host.sessionState(clean.ahpSession)).toBeUndefined();
    const row = app.db.all(
      "SELECT archived_at, disposed_at FROM conversations WHERE id = ?",
      clean.id,
    )[0] as Any;
    expect(row.archived_at).toEqual(expect.any(Number));
    expect(row.disposed_at).toEqual(expect.any(Number));

    // the retention days pass: the clean copies of archived and of disposed conversations go; unpushed work stays
    app.clock.advance(4 * DAY_MIN);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(existsSync(copies.clean)).toBe(false);
    expect(existsSync(copies.archived)).toBe(false);
    expect(existsSync(copies.unpushed)).toBe(true); // kept: unpushed commits
    expect(existsSync(copies.live)).toBe(true); // never archived
    // ...for unpushedKeepDays, and then it goes too
    app.clock.advance(27 * DAY_MIN);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(existsSync(copies.unpushed)).toBe(false);
    expect(existsSync(copies.live)).toBe(true);
  });

  it("finds a copy in the machine it was made in, after a team change or an employee leaving", async () => {
    let where = "inc-old";
    const { app, storage } = await realStorage((e) => (e === "kit" ? where : "inc-engineering"));
    const c = await make(app, "kit"); // made while kit's machine was inc-old
    const copy = convCopy(c.id);
    where = "inc-engineering"; // kit moved to another team
    await dispose(app, c);
    app.clock.advance(4 * DAY_MIN);
    const scripts: string[] = [];
    const run = (storage as unknown as { d: { ops: MachineOps } }).d.ops.runIn;
    (storage as unknown as { d: { ops: MachineOps } }).d.ops.runIn = async (m, sc) => {
      scripts.push(`${m}:${sc.includes(`cid in ${c.id}`)}`);
      return run(m, sc);
    };
    await storage.cleanMachine("inc-engineering", { manual: true });
    await storage.cleanMachine("inc-old", { manual: true });
    expect(scripts).toContain("inc-old:true"); // the machine it was made in
    expect(scripts).not.toContain("inc-engineering:true");
    expect(existsSync(copy)).toBe(false);
  });

  it("cleans the copy of a conversation whose project was removed, and one whose agent crashed", async () => {
    const { app, storage } = await realStorage();
    const c = await make(app);
    const copy = convCopy(c.id);
    app.deps.registry.removeProject("Duet");
    await dispose(app, c);
    app.clock.advance(4 * DAY_MIN);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(existsSync(copy)).toBe(false);
  });

  it("after a restart between disposing the session and noting it, the row becomes a tombstone", async () => {
    const { app, storage } = await realStorage();
    const c = await make(app);
    const copy = convCopy(c.id);
    await app.call("PATCH", `/api/conversations/${c.id}`, { archived: true });
    app.ahp.host.hooks.onSessionDisposed = undefined as never; // the daemon stopped right here
    await app.ahp.host.disposeSession(c.ahpSession);
    expect(
      (app.db.all("SELECT disposed_at FROM conversations WHERE id = ?", c.id)[0] as Any).disposed_at,
    ).toBeNull();
    const { ConversationService } = await import("../../src/ahp/conversations.ts");
    const again = new ConversationService(app.db, app.ahp.host, app.deps.registry, app.clock);
    expect(
      (app.db.all("SELECT disposed_at FROM conversations WHERE id = ?", c.id)[0] as Any).disposed_at,
    ).toEqual(expect.any(Number));
    expect(again.list({ archived: "all" })).toEqual([]);
    expect(again.forCleanup().map((x) => x.id)).toEqual([c.id]);
    app.clock.advance(4 * DAY_MIN);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(existsSync(copy)).toBe(false);
  });

  it("after a restart between making a session and its row, the session gets a tombstone row and is disposed", async () => {
    const { app } = await realStorage();
    const made = await app.ahp.host.createSession({
      provider: "opus",
      workingDirectories: ["file:///home/employee/work/conv-ab12cd34"],
      meta: {
        "iinc.conversation": "ab12cd34",
        "iinc.employee": "ada",
        "iinc.project": "Duet",
        "iinc.branch": "conv/ab12cd34",
      },
    });
    expect(app.deps.conversations?.bySession(made.session)).toBeUndefined();
    const { ConversationService } = await import("../../src/ahp/conversations.ts");
    const again = new ConversationService(app.db, app.ahp.host, app.deps.registry, app.clock);
    await new Promise((r) => setTimeout(r, 20));
    expect(again.forCleanup()).toMatchObject([{ id: "ab12cd34", employeeId: "ada", project: "Duet" }]);
    expect(app.ahp.host.sessionState(made.session)).toBeUndefined(); // disposed: no live agent, no leaked session
  });
});

describe("a conversation of an employee who left", () => {
  it("is suspended at the next sweep, however recently it was used", async () => {
    let here = true;
    const t = await sessionRig({ host: { employeeKnown: () => here } });
    const c = await t.create();
    expect(t.sandbox.live).toHaveLength(1);
    t.sessions.sweep();
    expect(t.sandbox.live).toHaveLength(1); // still here
    here = false;
    t.sessions.sweep();
    await until(() => t.sandbox.last.exitCode !== undefined);
    expect(t.sessions.status()[0]?.live).toBe(false);
    expect(c.session).toBeTruthy();
  });
});
