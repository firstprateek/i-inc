// Home data and shared sandboxes (T57 review): a PA's brain is never copied into a sandbox anyone else
// works in, a PA gets a sandbox of its own, and a copy leaves the machine its employee left.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "./ahp/session-rig.ts";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

const hirePa = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id[0]?.toUpperCase() + id.slice(1),
  role: "Personal Assistant",
  duties: ["build"],
  engines: { default: "qwen", fallbacks: [] },
  ...extra,
});

describe("hiring a PA", () => {
  it("gives it a team and sandbox of its own, even when the company has one team", async () => {
    const r = await brainRig();
    const made = await r.call("POST", "/api/employees", hirePa("sam"));
    expect(made.status).toBe(201);
    const { registry } = r.app.deps;
    expect(registry.teamOf("sam").id).toBe("home-sam");
    expect(registry.teams().find((t) => t.id === "home-sam")?.members).toEqual(["sam"]);
    expect(registry.machineMates("sam")).toEqual([]);
    // Same with no team named and several teams, where a normal hire would be asked to choose.
    const second = await r.call("POST", "/api/employees", hirePa("tam"));
    expect(second.status).toBe(201);
    expect(registry.teamOf("tam").id).toBe("home-tam");
    // The engineers' sandbox is still theirs alone.
    expect(registry.machineMates("ada")).toEqual(["kit"]);
  });

  it("hires from the web form's request (a team named, with others in it) into a home team of its own, small", async () => {
    const r = await brainRig();
    const hire = await r.call("POST", "/api/employees", hirePa("sam", { teamId: "engineering" }));
    expect(hire.status).toBe(201);
    const { registry } = r.app.deps;
    expect(registry.teamOf("sam").id).toBe("home-sam");
    expect(registry.teams().find((t) => t.id === "home-sam")).toMatchObject({
      members: ["sam"],
      sandbox: { cpus: 2, memory: "4G" },
    });
    expect(registry.machineMates("ada")).toEqual(["kit"]);
    // The size is the owner's to change, like any team's.
    expect(
      (
        await r.call("PUT", "/api/teams/home-sam", {
          name: "Sam's home",
          members: ["sam"],
          sandbox: { cpus: 4, memory: "8G" },
        })
      ).status,
    ).toBe(200);
    // A PA hired into an empty team named by the owner stays there.
    registry.addTeam({ id: "errands", name: "Errands", members: [] });
    expect((await r.call("POST", "/api/employees", hirePa("tam", { teamId: "errands" }))).status).toBe(201);
    expect(registry.teamOf("tam").id).toBe("errands");
  });

  it("moves a PA that edits name a shared team for, or that sits in one, to a home team instead of failing", async () => {
    const r = await brainRig();
    const { registry } = r.app.deps;
    // The way it was before: a PA in the engineers' team.
    registry.setTeam({ id: "engineering", name: "Engineering", members: ["ada", "kit", "pip"] });
    expect(registry.machineMates("pip")).toEqual(["ada", "kit"]);
    const edit = await r.call("PUT", "/api/employees/pip", { prompt: "Be brief.", teamId: "engineering" });
    expect(edit.status).toBe(200);
    expect(registry.teamOf("pip").id).toBe("home-pip");
    expect(registry.teams().find((t) => t.id === "engineering")?.members).toEqual(["ada", "kit"]);
    // Naming a shared team again moves it again to the same home team; no second one is made.
    expect((await r.call("PUT", "/api/employees/pip", { teamId: "engineering" })).status).toBe(200);
    expect(
      registry
        .teams()
        .filter((t) => t.id.startsWith("home-"))
        .map((t) => t.id),
    ).toEqual(["home-pip"]);
    // A change of role into a PA, while the team has others, moves it too.
    const role = await r.call("PUT", "/api/employees/kit", {
      role: "Personal Assistant",
      engines: { default: "qwen", fallbacks: [] },
    });
    expect(role.status).toBe(200);
    expect(registry.teamOf("kit").id).toBe("home-kit");
    expect(registry.machineMates("ada")).toEqual([]);
  });

  it("still refuses to put anyone else in a PA's team, or a PA and others in a team", async () => {
    const r = await brainRig();
    const into = await r.call("POST", "/api/employees", {
      id: "lee",
      name: "Lee",
      role: "Senior Engineer",
      duties: ["build"],
      engines: { default: "opus", fallbacks: [] },
      teamId: "home-pip",
    });
    expect(into.status).toBe(400);
    expect(into.body.error).toMatch(/home data, which needs a sandbox of its own/);
    expect((await r.call("PUT", "/api/employees/ada", { teamId: "home-pip" })).status).toBe(400);
    expect(
      (await r.call("PUT", "/api/teams/home-pip", { name: "Pip's home", members: ["pip", "ada"] })).status,
    ).toBe(400);
    expect(
      (await r.call("PUT", "/api/teams/engineering", { name: "Engineering", members: ["ada", "kit", "pip"] }))
        .status,
    ).toBe(400);
    expect((await r.call("PUT", "/api/employees/pip", { prompt: "Be brief." })).status).toBe(200);
  });

  it("won't delete a team that holds a PA, which would put it in the shared machine", async () => {
    const r = await brainRig();
    const res = await r.call("DELETE", "/api/teams/home-pip");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Pip.*home data/);
    expect(r.app.deps.registry.teamOf("pip").id).toBe("home-pip");
    // Other teams delete as before.
    expect((await r.call("DELETE", "/api/teams/engineering")).status).toBe(200);
  });

  it("doesn't hire an engineer into a PA's home team just because it is the only one", async () => {
    const r = await brainRig();
    const { registry } = r.app.deps;
    registry.removeTeam("engineering");
    expect(registry.teams().map((t) => t.id)).toEqual(["home-pip"]);
    const res = await r.call("POST", "/api/employees", {
      id: "lee",
      name: "Lee",
      role: "Senior Engineer",
      duties: ["build"],
      engines: { default: "opus", fallbacks: [] },
    });
    expect(res.status).toBe(201);
    expect(registry.teamOf("lee").id).not.toBe("home-pip");
    expect(registry.machineMates("pip")).toEqual([]);
    // With engineering back, it is the one open team.
    registry.addTeam({ id: "engineering", name: "Engineering", members: ["ada"] });
    registry.addTeam({ id: "design", name: "Design", members: [] });
    const two = await r.call("POST", "/api/employees", {
      id: "mo",
      name: "Mo",
      role: "Senior Engineer",
      duties: ["build"],
      engines: { default: "opus", fallbacks: [] },
    });
    expect(two.status).toBe(400); // two open teams: choose
  });

  it("leaves no empty home team behind when the hire fails", async () => {
    const r = await brainRig();
    const { registry } = r.app.deps;
    const before = registry.teams().map((t) => t.id);
    const real = registry.saveEmployeeInTeam.bind(registry);
    registry.saveEmployeeInTeam = () => {
      throw new Error("disk full");
    };
    // A route that throws answers 500 (T63), with the details in the log and not in the answer.
    const res = await r.app.handle(
      new Request("http://i.inc/api/employees", {
        method: "POST",
        body: JSON.stringify(hirePa("sam")),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("disk full");
    registry.saveEmployeeInTeam = real;
    expect(registry.teams().map((t) => t.id)).toEqual(before);
    expect(registry.employees().some((e) => e.id === "sam")).toBe(false);
  });
});

describe("a PA's brain and a shared machine", () => {
  async function shared() {
    const r = await brainRig();
    r.commit("handbook", { "facts/gh.md": page("GitHub CLI", "gh", "Use gh.") });
    r.commit("pip", {
      "home/dentist.md": page("Dentist", "Where the owner's dentist is", "homedata: dentist at 5 Elm St."),
    });
    return r;
  }

  it("copies it into the PA's own sandbox", async () => {
    const r = await shared();
    expect(await r.feed.sync("pip")).toMatchObject({ ok: true, how: "full" });
    expect(existsSync(r.copy("pip", "personal/home/dentist.md"))).toBe(true);
    expect(r.runs.every((x) => x.machine === undefined)).toBe(true);
  });

  it("copies nothing, and takes out what was there once, when a PA shares its machine with anyone", async () => {
    const r = await shared();
    // The way it was before: a PA in the engineers' team (the registry allows it; the API no longer does).
    r.app.deps.registry.setTeam({ id: "engineering", name: "Engineering", members: ["ada", "kit", "pip"] });
    mkdirSync(r.copy("pip", "personal/home"), { recursive: true });
    writeFileSync(r.copy("pip", "personal/home/dentist.md"), "homedata: dentist at 5 Elm St.\n");
    const report = await r.feed.sync("pip");
    expect(report).toMatchObject({ ok: false, how: "skipped" });
    expect(existsSync(r.copy("pip"))).toBe(false);
    // One removal for each of its two copies (the one for errands and the one for code work).
    const removal = r.runs.filter((x) => x.script.includes("@@removed"));
    expect(removal).toHaveLength(2);
    expect(removal.map((x) => x.script).join()).toContain("/pip.code'");
    expect(removal[0]).toMatchObject({ employeeId: "pip", machine: "inc-engineering" });
    // Nothing of pip's went anywhere, and asking again doesn't send another removal.
    expect(r.runs.some((x) => x.script.includes("__INC_TAR__"))).toBe(false);
    await r.feed.sync("pip");
    expect(r.runs.filter((x) => x.script.includes("@@removed"))).toHaveLength(2);
    // Its prompt still gets its own pages.
    const ctx = await r.feed.forTicket({
      employeeId: "pip",
      sessionId: null,
      query: { title: "dentist", project: "Home", doneWhen: [] },
    });
    expect(ctx.copy).toBe(false);
    expect(ctx.text).toContain("homedata");
    // And the engineers' copies never held it.
    await r.feed.sync("ada");
    expect(existsSync(r.copy("ada", "personal/home"))).toBe(false);
  });

  it("keeps a PA's home data out of work that goes to a repository, in a copy of its own", async () => {
    const r = await shared();
    // Code work first: a copy beside the PA's own, with no personal folder.
    const code = await r.feed.forTicket({
      employeeId: "pip",
      sessionId: null,
      allowHome: false,
      query: { title: "dentist address", project: "Duet", doneWhen: [] },
    });
    expect(code.text).not.toContain("homedata");
    expect(code.text).not.toContain("Your own brain");
    expect(code.text).toContain("/pip.code/");
    expect(code.pages.map((p) => p.scope)).not.toContain("brain:pip");
    expect(existsSync(r.copy("pip.code", "company/facts/gh.md"))).toBe(true);
    expect(existsSync(r.copy("pip.code", "personal"))).toBe(false);
    expect(existsSync(r.copy("pip"))).toBe(false);
    // An errand next: the PA's own copy, which the code work can't have touched; and the other way round.
    const errand = await r.feed.forTicket({
      employeeId: "pip",
      sessionId: null,
      allowHome: true,
      query: { title: "dentist address", project: "Home", doneWhen: [] },
    });
    expect(errand.text).toContain("homedata");
    expect(errand.text).not.toContain("/pip.code/");
    expect(existsSync(r.copy("pip", "personal/home/dentist.md"))).toBe(true);
    const before = r.runs.length;
    await r.feed.forTicket({
      employeeId: "pip",
      sessionId: null,
      allowHome: false,
      query: { title: "x", project: "Duet", doneWhen: [] },
    });
    // No script touched the errand's folder: they have separate copies, and the code one was already current.
    expect(r.runs.slice(before).every((x) => !x.script.includes(`'${r.copy("pip")}'`))).toBe(true);
    expect(existsSync(r.copy("pip", "personal/home/dentist.md"))).toBe(true);
    // A conversation on a project is code work too.
    const turn = await r.feed.forTurn({
      employeeId: "pip",
      conversation: "c1",
      turn: "t1",
      message: "dentist address",
      project: "Duet",
      allowHome: false,
    });
    expect(turn.text).not.toContain("homedata");
    // Reads in either copy count; a path to a personal page in the code copy counts for nothing.
    const read = r.feed.noteRead(
      "pip",
      [r.copy("pip.code", "company/facts/gh.md"), r.copy("pip.code", "personal/home/dentist.md")],
      { kind: "session", id: 9 },
    );
    expect(read.map((x) => x.slug)).toEqual(["facts/gh"]);
  });

  it("takes out both of a PA's copies when it ends up sharing a machine", async () => {
    const r = await shared();
    await r.feed.sync("pip", true);
    await r.feed.sync("pip", false);
    expect(existsSync(r.copy("pip"))).toBe(true);
    expect(existsSync(r.copy("pip.code"))).toBe(true);
    r.app.deps.registry.setTeam({ id: "engineering", name: "Engineering", members: ["ada", "kit", "pip"] });
    await r.feed.sync("pip", false);
    expect(existsSync(r.copy("pip"))).toBe(false);
    expect(existsSync(r.copy("pip.code"))).toBe(false);
  });
});

describe("both of a PA's copies follow it", () => {
  async function twoCopies() {
    const r = await brainRig();
    r.commit("handbook", { "facts/gh.md": page("GitHub CLI", "gh", "Use gh.") });
    r.commit("pip", { "home/d.md": page("Dentist", "dentist", "homedata") });
    await r.feed.sync("pip", true);
    await r.feed.sync("pip", false);
    expect(existsSync(r.copy("pip"))).toBe(true);
    expect(existsSync(r.copy("pip.code"))).toBe(true);
    // each copy has its own record
    expect(r.app.deps.db.all("SELECT employee_id FROM brain_synced ORDER BY employee_id")).toEqual([
      expect.objectContaining({ employee_id: "pip" }),
      expect.objectContaining({ employee_id: "pip.code" }),
    ]);
    return r;
  }

  it("removes both when the PA moves to another team", async () => {
    const r = await twoCopies();
    r.app.deps.registry.addTeam({ id: "errands", name: "Errands", members: [] });
    expect((await r.call("PUT", "/api/employees/pip", { teamId: "errands" })).status).toBe(200);
    await r.feed.reconcile();
    expect(existsSync(r.copy("pip"))).toBe(false);
    expect(existsSync(r.copy("pip.code"))).toBe(false);
    expect(r.app.deps.db.all("SELECT * FROM brain_synced")).toEqual([]);
    const removed = r.runs.filter((x) => x.script.includes("@@removed"));
    expect(removed.map((x) => x.machine)).toEqual(["inc-home-pip", "inc-home-pip"]);
  });

  it("removes both when the PA leaves", async () => {
    const r = await twoCopies();
    r.app.deps.db.run("DELETE FROM company WHERE kind = 'employee' AND id = 'pip'");
    await r.feed.reconcile();
    expect(existsSync(r.copy("pip"))).toBe(false);
    expect(existsSync(r.copy("pip.code"))).toBe(false);
    expect(r.app.deps.db.all("SELECT * FROM brain_synced")).toEqual([]);
  });
});

describe("emptying a home team", () => {
  it("is refused, like deleting it, because the PA would land in the shared sandbox", async () => {
    const r = await brainRig();
    const res = await r.call("PUT", "/api/teams/home-pip", { name: "Pip's home", members: [] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Pip.*home data.*sandbox of its own/);
    expect(r.app.deps.registry.teamOf("pip").id).toBe("home-pip");
    // Renaming it, or resizing it, with the PA still in it, is fine; so is emptying an ordinary team.
    expect(
      (
        await r.call("PUT", "/api/teams/home-pip", {
          name: "Pip",
          members: ["pip"],
          sandbox: { cpus: 3, memory: "6G" },
        })
      ).status,
    ).toBe(200);
    expect((await r.call("PUT", "/api/teams/engineering", { name: "Engineering", members: [] })).status).toBe(
      200,
    );
  });
});

describe("a stopped machine", () => {
  it("is started by the daemon right before a stage: the brain feed forgets that it was down", async () => {
    const r = await brainRig();
    r.commit("handbook", { "facts/gh.md": page("GitHub CLI", "gh", "Use gh.") });
    r.setUp(false);
    expect(await r.feed.sync("ada")).toMatchObject({ ok: false, how: "skipped" });
    // The machine boots (the "down" answer is only seconds old); the daemon ensures it before the stage.
    r.machineUp.value = true;
    const ports = (
      r.app.daemon as unknown as { ports: { machines: { ensureUp: (id: string) => Promise<void> } } }
    ).ports;
    await ports.machines.ensureUp("ada");
    expect(await r.feed.sync("ada")).toMatchObject({ ok: true, how: "full" });
  });

  it("is not started to copy into: the session goes on without a copy", async () => {
    const r = await brainRig();
    r.commit("handbook", { "facts/gh.md": page("GitHub CLI", "gh", "Use gh.") });
    r.setUp(false);
    expect(await r.feed.sync("ada")).toMatchObject({ ok: false, how: "skipped" });
    expect(r.runs).toEqual([]);
    const ctx = await r.feed.forTicket({
      employeeId: "ada",
      sessionId: null,
      query: { title: "gh", project: "Duet", doneWhen: [] },
    });
    expect(ctx.copy).toBe(false);
    expect(r.runs).toEqual([]);
    r.setUp(true);
    r.clock.advance(1);
    expect((await r.feed.sync("ada")).ok).toBe(true);
  });

  it("is not started to take a copy out of; the removal is done once it is up", async () => {
    const r = await brainRig();
    r.commit("ada", { "tools/x.md": page("X", "x", "x") });
    await r.feed.sync("ada");
    const runs = r.runs.length;
    r.setUp(false);
    expect((await r.call("PUT", "/api/teams/design", { name: "Design", members: ["grace"] })).status).toBe(
      200,
    );
    expect((await r.call("PUT", "/api/employees/ada", { teamId: "design" })).status).toBe(200);
    await r.feed.reconcile();
    expect(r.runs.length).toBe(runs); // nothing was run in the stopped machine
    expect(existsSync(r.copy("ada", "personal/tools/x.md"))).toBe(true);
    expect(r.app.deps.db.all("SELECT machine FROM brain_synced")).toHaveLength(1);
    expect(r.logs.join("\n")).toContain("is removed when the machine is up");
    // Up again (the cached answer is a few seconds old; a new look is made after it).
    r.setUp(true);
    await r.feed.reconcile();
    expect(existsSync(r.copy("ada"))).toBe(false);
    expect(r.runs.at(-1)).toMatchObject({ employeeId: "ada", machine: "inc-engineering" });
    expect(r.app.deps.db.all("SELECT machine FROM brain_synced")).toEqual([]);
  });

  it("does not try to take a PA's old copy out of a machine that is stopped", async () => {
    const r = await brainRig();
    r.app.deps.registry.setTeam({ id: "engineering", name: "Engineering", members: ["ada", "kit", "pip"] });
    r.setUp(false);
    await r.feed.sync("pip");
    expect(r.runs).toEqual([]);
    r.setUp(true);
    await r.feed.sync("pip");
    expect(r.runs.filter((x) => x.script.includes("@@removed")).length).toBeGreaterThan(0);
  });
});

describe("a copy leaves the machine its employee left", () => {
  it("removes ada's copy from the old machine when she moves team", async () => {
    const r = await brainRig();
    r.commit("ada", { "tools/x.md": page("X", "x", "x") });
    await r.feed.sync("ada");
    expect(existsSync(r.copy("ada", "personal/tools/x.md"))).toBe(true);
    expect((await r.call("PUT", "/api/teams/design", { name: "Design", members: ["grace"] })).status).toBe(
      200,
    );
    expect((await r.call("PUT", "/api/employees/ada", { teamId: "design" })).status).toBe(200);
    await until(() => !existsSync(r.copy("ada")));
    expect(r.runs.find((x) => x.script.includes("@@removed"))).toMatchObject({
      employeeId: "ada",
      machine: "inc-engineering",
    });
    // The row is gone, and her new machine gets a whole copy.
    expect(r.app.deps.db.all("SELECT * FROM brain_synced")).toEqual([]);
    expect(await r.feed.sync("ada")).toMatchObject({ ok: true, how: "full" });
  });

  it("removes the copy of an employee who is gone", async () => {
    const r = await brainRig();
    mkdirSync(r.copy("ghost", "personal"), { recursive: true });
    writeFileSync(r.copy("ghost", "personal/a.md"), "# a\n");
    r.app.deps.db.run(
      "INSERT INTO brain_synced (machine, employee_id, snapshot_id, files, pending, at) VALUES ('inc-engineering', 'ghost', 'abcdabcdabcdabcd', '{}', '[]', 0)",
    );
    await r.feed.reconcile();
    expect(existsSync(r.copy("ghost"))).toBe(false);
    expect(r.app.deps.db.all("SELECT * FROM brain_synced")).toEqual([]);
  });

  it("removes the pages of a brain repo that was deleted from the copy", async () => {
    const r = await brainRig();
    r.commit("ada", { "tools/x.md": page("X", "x", "x") });
    await r.feed.sync("ada");
    rmSync(join(r.knowledgeDir, "brains", "ada"), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    expect((await r.feed.sync("ada")).ok).toBe(true);
    expect(existsSync(r.copy("ada", "personal/tools/x.md"))).toBe(false);
    expect(existsSync(dirname(r.copy("ada", "company/INDEX.md")))).toBe(false);
  });
});
