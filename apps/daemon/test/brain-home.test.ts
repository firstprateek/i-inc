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

  it("refuses to put a PA in a team with other people, by hiring, by moving, by editing a team, or by a change of role", async () => {
    const r = await brainRig();
    const hire = await r.call("POST", "/api/employees", hirePa("sam", { teamId: "engineering" }));
    expect(hire.status).toBe(400);
    expect(hire.body.error).toMatch(/home data, which needs a sandbox of its own/);
    expect(r.app.deps.registry.employees().some((e) => e.id === "sam")).toBe(false);

    // Moving the PA we have into the engineers' team
    const move = await r.call("PUT", "/api/employees/pip", { teamId: "engineering" });
    expect(move.status).toBe(400);
    expect(r.app.deps.registry.teamOf("pip").id).toBe("home-pip");

    // Adding an engineer to the PA's team, by hiring, by moving, or by editing the team
    const into = await r.call("POST", "/api/employees", {
      id: "lee",
      name: "Lee",
      role: "Senior Engineer",
      duties: ["build"],
      engines: { default: "opus", fallbacks: [] },
      teamId: "home-pip",
    });
    expect(into.status).toBe(400);
    expect((await r.call("PUT", "/api/employees/ada", { teamId: "home-pip" })).status).toBe(400);
    expect(
      (await r.call("PUT", "/api/teams/home-pip", { name: "Pip's home", members: ["pip", "ada"] })).status,
    ).toBe(400);
    expect(
      (await r.call("PUT", "/api/teams/engineering", { name: "Engineering", members: ["ada", "kit", "pip"] }))
        .status,
    ).toBe(400);
    // A change of role into a PA, while the team has others
    const role = await r.call("PUT", "/api/employees/kit", {
      role: "Personal Assistant",
      engines: { default: "qwen", fallbacks: [] },
    });
    expect(role.status).toBe(400);
    expect(r.app.deps.registry.employee("kit").role).toBe("Senior Engineer");
    // Editing a PA's prompt in its own team is fine.
    expect((await r.call("PUT", "/api/employees/pip", { prompt: "Be brief." })).status).toBe(200);
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
    const removal = r.runs.filter((x) => x.script.includes("@@removed"));
    expect(removal).toHaveLength(1);
    expect(removal[0]).toMatchObject({ employeeId: "pip", machine: "inc-engineering" });
    // Nothing of pip's went anywhere, and asking again doesn't send another removal.
    expect(r.runs.some((x) => x.script.includes("__INC_TAR__"))).toBe(false);
    await r.feed.sync("pip");
    expect(r.runs.filter((x) => x.script.includes("@@removed"))).toHaveLength(1);
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

  it("keeps a PA's home data out of work that goes to a repository", async () => {
    const r = await shared();
    const code = await r.feed.forTicket({
      employeeId: "pip",
      sessionId: null,
      allowHome: false,
      query: { title: "dentist address", project: "Duet", doneWhen: [] },
    });
    expect(code.text).not.toContain("homedata");
    expect(code.text).not.toContain("Your own brain");
    expect(code.pages.map((p) => p.scope)).not.toContain("brain:pip");
    // The copy for such a session has no personal folder either.
    expect(existsSync(r.copy("pip", "personal"))).toBe(false);
    const errand = await r.feed.forTicket({
      employeeId: "pip",
      sessionId: null,
      allowHome: true,
      query: { title: "dentist address", project: "Home", doneWhen: [] },
    });
    expect(errand.text).toContain("homedata");
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
    rmSync(join(r.knowledgeDir, "brains", "ada"), { recursive: true, force: true });
    expect((await r.feed.sync("ada")).ok).toBe(true);
    expect(existsSync(r.copy("ada", "personal/tools/x.md"))).toBe(false);
    expect(existsSync(dirname(r.copy("ada", "company/INDEX.md")))).toBe(false);
  });
});
