// Shipping a conversation's work (T62b): "Make this a ticket" and "Open a PR". The sandbox's scripts run in
// real bash against real git (a local bare repo is GitHub's remote), so a commit, a push, a rebase onto main
// and a protected path are the real thing. The agents and GitHub's pull request API are fakes.
import { afterEach, describe, expect, it } from "vitest";
import { type ShipRig, shipRig, until } from "./ship-rig.ts";

const rigs: ShipRig[] = [];
const make = async (...a: Parameters<typeof shipRig>) => {
  const r = await shipRig(...a);
  rigs.push(r);
  return r;
};
afterEach(() => {
  rigs.length = 0;
});

const ticketEvents = async (rig: ShipRig, id: string) =>
  (await rig.app.deps.store.read(id)).map((e) => e.type);

describe("make this a ticket, in direct mode", () => {
  it("commits what the agent left, enters the pipeline at the checks, and pushes to main after the review", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    c.write("hello.txt", "hello\n");
    const base = rig.originGit("rev-parse", "main");

    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {
      title: "Add a greeting file",
      doneWhen: ["hello.txt says hello"],
    });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    const id = r.body.ticket.id;
    expect(r.body.ticket).toMatchObject({
      title: "Add a greeting file",
      project: "Duet",
      conversation: c.conv.id,
      branch: `conv/${c.conv.id}`,
      assignee: "ada",
      doneWhen: ["hello.txt says hello"],
    });
    // The copy was committed on the conversation's branch, by the employee, with a plain message.
    expect(c.git("log", "-1", "--format=%an|%s")).toMatch(/^Ada \(i\.inc\)\|feat: Add a greeting file$/);
    expect(c.git("status", "--porcelain")).toBe("");

    await rig.settle();
    // Plan and build were done by the conversation; the pipeline began at the checks.
    const events = await ticketEvents(rig, id);
    expect(events.slice(0, 5)).toEqual([
      "ticket-created",
      "pr-opened",
      "stage-finished",
      "stage-finished",
      "stage-finished",
    ]);
    const s = await rig.app.daemon.state(id);
    expect(s.finished.slice(0, 3)).toEqual(["pickup", "plan", "build"]);
    expect(s.finished).toContain("checks");
    expect(s.finished).toContain("review");
    expect(s.finished).toContain("gates");
    expect(s.outcome).toBe("merged");
    // No session was spent on plan or build.
    expect(rig.agent.calls.map((x) => x.stage)).not.toContain("plan");
    expect(rig.agent.calls.map((x) => x.stage)).not.toContain("build");
    // The reviewed work is on main, and the ticket worked in the conversation's folder.
    expect(rig.originGit("rev-parse", "main")).not.toBe(base);
    expect(rig.originGit("show", "main:hello.txt")).toBe("hello");
    expect(rig.ciOn).toHaveLength(1);
  });
});

describe("make this a ticket, in owner-merges mode", () => {
  it("pushes the branch as the bot, opens one draft PR for the ticket, and ends with the PR ready for the owner", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("hello.txt", "hello\n");

    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(r.status).toBe(201);
    // No title or done-when sent: the conversation's own words.
    expect(r.body.ticket.title).toBe("plain add a greeting file");
    expect(r.body.ticket.doneWhen[0]).toContain("add a greeting file");
    expect(rig.originGit("rev-parse", `conv/${c.conv.id}`)).toBe(c.git("rev-parse", "HEAD"));
    expect(rig.prs.prs).toHaveLength(1);
    expect(rig.prs.prs[0]).toMatchObject({ head: `conv/${c.conv.id}`, base: "main", draft: true });
    expect(rig.prs.prs[0]?.title).toMatch(/^feat: plain add a greeting file$/);

    await rig.settle();
    const s = await rig.app.daemon.state(r.body.ticket.id);
    expect(s.status).toBe("ready");
    expect(s.pr).toMatchObject({ branch: `conv/${c.conv.id}`, number: 1 });
    // The report replaced the PR's text and took it out of draft; main is the owner's to merge.
    expect(rig.prs.prs).toHaveLength(1);
    expect(rig.prs.prs[0]?.draft).toBe(false);
    expect(rig.prs.calls).toContain("markReady PR_1");
    expect(rig.originGit("show", "main:README.md")).toBe("duet");
    expect(() => rig.originGit("show", "main:hello.txt")).toThrow();
    // CI ran on the branch the gates pushed (the PR's), not on main.
    expect(rig.ciOn).toEqual([rig.originGit("rev-parse", `conv/${c.conv.id}`)]);
  });

  it("uses the PR the quick path already opened, rather than a second one", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const pr = await rig.call("POST", `/api/conversations/${c.conv.id}/pr`, {});
    expect(pr.status).toBe(201);
    c.write("b.txt", "b\n");
    const t = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(t.status).toBe(201);
    expect(rig.prs.prs).toHaveLength(1);
    expect(t.body.ticket.id).toBeTruthy();
    expect(rig.originGit("show", `conv/${c.conv.id}:b.txt`)).toBe("b");
    const s = await rig.app.deps.store.read(t.body.ticket.id);
    expect(s.find((e) => e.type === "pr-opened")).toMatchObject({ pr: { number: 1 } });
  });
});

describe("open a PR", () => {
  it("commits, pushes through the bot and opens a draft with a generated title and body", async () => {
    const rig = await make({ mode: "owner-merges", files: { ".github/workflows/ci.yml": "name: ci\n" } });
    const c = await rig.conversation();
    c.write("src/greeting.ts", "export const hi = 'hi';\n");
    c.write(".github/workflows/ci.yml", "name: ci\non: push\n");

    const preview = await rig.call("GET", `/api/conversations/${c.conv.id}/ship?preview=1`);
    expect(preview.body.ship.copy.files.map((f: { path: string }) => f.path).sort()).toEqual([
      ".github/workflows/ci.yml",
      "src/greeting.ts",
    ]);
    expect(preview.body.ship.copy.protectedPaths).toEqual([".github/workflows/ci.yml"]);
    expect(preview.body.ship.copy.uncommitted).toBe(2);
    expect(rig.originGit("branch", "--list", `conv/${c.conv.id}`)).toBe("");

    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/pr`, {});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: true, pr: { number: 1, draft: true } });
    expect(r.body.pr.url).toBe("https://github.com/acme/duet/pull/1");
    const pr = rig.prs.prs[0];
    expect(pr?.title).toBe("feat: plain add a greeting file");
    expect(pr?.body).toContain("It is a draft");
    expect(pr?.body).toContain("`src/greeting.ts` (+1 −0)");
    expect(pr?.body).toContain("protected paths (.github/workflows/ci.yml)");
    // Pushed as the bot through the sandbox's sign-in; the work is on the branch, not on main.
    expect(rig.originGit("show", `conv/${c.conv.id}:src/greeting.ts`)).toContain("hi");
    expect(rig.originGit("log", "-1", "--format=%an", `conv/${c.conv.id}`)).toBe("Ada (i.inc)");
    expect(() => rig.originGit("show", "main:src/greeting.ts")).toThrow();
    // Not a ticket: nothing holds the conversation.
    expect((await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship).toEqual({
      ticket: null,
      pr: { number: 1, url: "https://github.com/acme/duet/pull/1" },
    });
    c.say("plain still here", "t2");
    await until(() => rig.app.ahp.host.chatState(c.conv.ahpChat)?.turns.length === 2);
  });

  it("is safe to press twice: the second finds the first's PR, and pushes only what is new", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const [one, two] = await Promise.all([
      rig.call("POST", `/api/conversations/${c.conv.id}/pr`, {}),
      rig.call("POST", `/api/conversations/${c.conv.id}/pr`, {}),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 201]);
    expect(one.body.pr.number).toBe(1);
    expect(two.body.pr.number).toBe(1);
    expect(rig.prs.prs).toHaveLength(1);

    c.write("b.txt", "b\n");
    const again = await rig.call("POST", `/api/conversations/${c.conv.id}/pr`, {});
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(rig.prs.prs).toHaveLength(1);
    expect(rig.originGit("show", `conv/${c.conv.id}:b.txt`)).toBe("b");
  });

  it("is not offered in direct mode, and says why", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const state = await rig.call("GET", `/api/conversations/${c.conv.id}/ship`);
    expect(state.body.ship).toMatchObject({ mode: "direct", canTicket: true, canPr: false });
    expect(state.body.ship.reason).toMatch(/straight to main/);
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/pr`, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("direct-mode");
    expect(r.body.error).toMatch(/Make this a ticket/);
    expect(rig.prs.prs).toHaveLength(0);
    expect(c.git("status", "--porcelain")).toContain("a.txt");
  });

  it("shows the PR and its checks, and says so plainly when GitHub can't be asked", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    await rig.call("POST", `/api/conversations/${c.conv.id}/pr`, {});
    const view = await rig.call("GET", `/api/conversations/${c.conv.id}/ship`);
    expect(view.body.ship.pr).toMatchObject({
      number: 1,
      state: "open",
      draft: true,
      checks: { state: "pending", total: 2, passed: 1 },
    });
    rig.prs.checkState = { state: "success", total: 2, passed: 2, failed: 0, pending: 0 };
    rig.clock.advance(1);
    expect((await rig.call("GET", `/api/conversations/${c.conv.id}/ship`)).body.ship.pr.checks.state).toBe(
      "success",
    );
    // GitHub is down: the panel still has the link, with a sentence instead of checks.
    rig.clock.advance(1);
    rig.prs.failWith = new Error("boom");
    const down = await rig.call("GET", `/api/conversations/${c.conv.id}/ship`);
    expect(down.status).toBe(200);
    expect(down.body.ship.pr).toMatchObject({ number: 1, url: "https://github.com/acme/duet/pull/1" });
    expect(down.body.ship.pr.problem).toMatch(/Couldn't ask GitHub/);
  });
});

describe("a dirty copy and the safeguards", () => {
  it("never commits a credential, names the file and not the value, and leaves the copy as it was", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    const secret = "gh\u0070_abcdefghijklmnopqrstuvwxyz0123456789";
    c.write("config.ts", `export const token = "${secret}";\n`);
    c.write("ok.ts", "export const fine = 1;\n");
    const head = c.git("rev-parse", "HEAD");

    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("secrets");
    expect(r.body.error).toContain("config.ts");
    expect(r.body.error).not.toContain(secret);
    expect(JSON.stringify(r.body)).not.toContain(secret);
    expect(c.git("rev-parse", "HEAD")).toBe(head);
    expect(c.git("status", "--porcelain")).toContain("config.ts");
    // Nothing was made, and the conversation is not held.
    expect((await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship).toBeUndefined();
    expect(rig.app.deps.tickets.all()).toHaveLength(0);
    const preview = await rig.call("GET", `/api/conversations/${c.conv.id}/ship?preview=1`);
    expect(preview.body.ship.copy.blockers[0]).toContain("config.ts");
    expect(JSON.stringify(preview.body)).not.toContain(secret);
    // A file that usually holds secrets is stopped by its name alone.
    rig.git(c.dir, "checkout", "-q", "--", ".");
  });

  it("stops a .env file by its name, and a private key by its content", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write(".env", "SOMETHING=1\n");
    c.write(
      "deploy.sh",
      "KEY='-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----'\n",
    );
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/pr`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toContain(".env");
    expect(r.body.error).toContain("deploy.sh");
    expect(r.body.error).not.toContain("MIIBOgIBAAJBAKj34");
    expect(rig.prs.prs).toHaveLength(0);
    expect(rig.originGit("branch", "--list", `conv/${c.conv.id}`)).toBe("");
  });

  it("commits what was staged, changed and new, but not the owner's images under .inc", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    c.write("new.txt", "new\n");
    c.write("README.md", "duet, changed\n");
    c.write(".inc/attachments/1-a.png", "png");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(r.status).toBe(201);
    expect(c.git("show", "--stat", "--format=", "HEAD")).toMatch(
      /new\.txt[\s\S]*README\.md|README\.md[\s\S]*new\.txt/,
    );
    expect(c.git("ls-files", ".inc")).toBe("");
  });

  it("refuses a conversation that has changed nothing", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("nothing");
    expect(r.body.error).toMatch(/nothing to ship yet/);
    expect(rig.app.deps.tickets.all()).toHaveLength(0);
    expect(
      (await rig.call("GET", `/api/conversations/${c.conv.id}/ship?preview=1`)).body.ship.copy.blockers,
    ).toEqual(["nothing has changed yet"]);
  });

  it("ships work that is already committed, and keeps the commits", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    c.write("done.txt", "done\n");
    c.git("add", "-A");
    c.git("commit", "-q", "-m", "agent's own commit");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(r.status).toBe(201);
    expect(c.git("log", "--format=%s", "-2")).toBe("agent's own commit\nbase");
    await rig.settle();
    expect((await rig.app.daemon.state(r.body.ticket.id)).outcome).toBe("merged");
  });
});

describe("protected paths still wait for the owner", () => {
  it("holds a direct-mode change to .github/ at the gates until the owner says yes", async () => {
    const rig = await make({ mode: "direct", files: { ".github/ci.yml": "a\n" } });
    const c = await rig.conversation();
    c.write(".github/ci.yml", "b\n");
    c.write("src.txt", "s\n");
    const base = rig.originGit("rev-parse", "main");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    const id = r.body.ticket.id;
    await rig.settle();
    const s = await rig.app.daemon.state(id);
    expect(s.status).toBe("needs-you");
    // The card says what the OK is for: the commit, a hash of the diff, and the diff itself.
    expect(s.needsYou).toMatchObject({
      kind: "protected-paths",
      paths: [".github/ci.yml"],
      sha: expect.stringMatching(/^[0-9a-f]{40}$/),
      patchId: expect.stringMatching(/^[0-9a-f]{64}$/),
      diff: expect.stringContaining("+b"),
    });
    expect(rig.originGit("rev-parse", "main")).toBe(base);
    // Still the ticket's: the conversation can't touch the copy while the owner decides.
    c.say("plain hello", "t9");
    await new Promise((r) => setTimeout(r, 30));
    expect(rig.app.ahp.host.chatState(c.conv.ahpChat)?.turns).toHaveLength(1);

    const answered = await rig.call("POST", `/api/tickets/${id}/answer`, { answer: "approve" });
    expect(answered.status).toBe(200);
    await rig.settle();
    expect((await rig.app.daemon.state(id)).outcome).toBe("merged");
    expect(rig.originGit("show", "main:.github/ci.yml")).toBe("b");
  });

  it("tells the owner in the preview which files are protected", async () => {
    const rig = await make({ mode: "direct", protectedPaths: ["release.json"] });
    const c = await rig.conversation();
    c.write("release.json", "{}\n");
    const v = await rig.call("GET", `/api/conversations/${c.conv.id}/ship?preview=1`);
    expect(v.body.ship.copy.protectedPaths).toEqual(["release.json"]);
  });
});

describe("the handover", () => {
  it("stops the conversation's agent while the ticket has the copy, and gives it back with a note when the ticket ends", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    expect(rig.sandbox.live).toHaveLength(1);
    c.write("a.txt", "a\n");

    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    const id = r.body.ticket.id;
    // The agent's process is gone, and the row says whose the copy is.
    expect(rig.sandbox.live).toHaveLength(0);
    const row = (await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation;
    expect(row.ship).toEqual({
      ticket: { id, held: true },
      pr: { number: 1, url: "https://github.com/acme/duet/pull/1" },
    });
    // A message is refused with the reason, and no agent starts.
    c.say("plain are you there", "t2");
    await new Promise((res) => setTimeout(res, 30));
    const rejected = c.client.envelopes.filter((e) => (e as { rejectionReason?: string }).rejectionReason);
    expect(rejected.at(-1)).toMatchObject({
      rejectionReason: expect.stringContaining(`This work is now ticket #${id}`),
    });
    expect(rig.sandbox.live).toHaveLength(0);
    expect(rig.app.ahp.host.chatState(c.conv.ahpChat)?.turns).toHaveLength(1);
    // And so is a queued one.
    const view = await rig.call("GET", `/api/conversations/${c.conv.id}/ship`);
    expect(view.body.ship.ticket).toMatchObject({ id, held: true, title: "plain add a greeting file" });

    await rig.settle();
    // Ready for the owner: still the ticket's (the owner may ask for changes).
    expect((await rig.app.daemon.state(id)).status).toBe("ready");
    expect(
      (await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship.ticket.held,
    ).toBe(true);

    // The owner merges the PR on GitHub, then approves: the ticket closes and the conversation has its copy back.
    const pr = rig.prs.prs[0];
    if (pr) pr.state = "merged";
    expect((await rig.call("POST", `/api/tickets/${id}/decide`, { decision: "approve" })).status).toBe(200);
    await rig.settle();
    await until(
      async () =>
        (await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship === undefined,
    );
    expect((await rig.call("GET", `/api/conversations/${c.conv.id}/ship`)).body.ship.ticket).toMatchObject({
      id,
      held: false,
      status: "done",
      outcome: "merged",
    });
    // A message gets through again, and the agent that wakes is told what happened to the branch.
    c.say("plain carry on", "t3");
    await until(() => rig.app.ahp.host.chatState(c.conv.ahpChat)?.turns.length === 2);
    const prompt = JSON.stringify(rig.sandbox.last.prompts.at(-1));
    expect(prompt).toContain(`ticket #${id} took over this branch (conv/${c.conv.id})`);
    expect(prompt).toContain("Check git status and git log");
    expect(prompt).toContain("carry on");
    // The note is said once.
    c.say("plain and again", "t4");
    await until(() => rig.app.ahp.host.chatState(c.conv.ahpChat)?.turns.length === 3);
    expect(JSON.stringify(rig.sandbox.last.prompts.at(-1))).not.toContain("took over this branch");
  });

  it("waits for a queued message and sends it when the ticket is done", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    c.client.dispatch(c.conv.ahpChat, {
      type: "chat/pendingMessageSet",
      kind: 2,
      id: "q1",
      message: { text: "plain from the queue" },
    });
    await new Promise((res) => setTimeout(res, 30));
    expect(rig.app.ahp.host.chatState(c.conv.ahpChat)?.turns).toHaveLength(1);
    await rig.settle();
    expect((await rig.app.daemon.state(r.body.ticket.id)).outcome).toBe("merged");
  });

  it("does not take the copy from a conversation that is mid-turn, and holds nothing", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    c.say("slow tick tick", "t2");
    await until(() => rig.app.ahp.host.hasActiveTurn(c.conv.ahpChat));
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("busy");
    expect(r.body.error).toMatch(/Stop the turn/);
    expect(rig.app.deps.tickets.all()).toHaveLength(0);
    expect((await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship).toBeUndefined();
    expect(c.git("status", "--porcelain")).toContain("a.txt");
    // After the turn ends it works.
    c.client.dispatch(c.conv.ahpChat, { type: "chat/turnCancelled", turnId: "t2" });
    await until(() => !rig.app.ahp.host.hasActiveTurn(c.conv.ahpChat));
    // The agent winds down for a moment after Stop; until it has, the copy isn't free.
    let second = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    for (let i = 0; i < 100 && second.status === 409; i++) {
      await new Promise((res) => setTimeout(res, 20));
      second = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    }
    expect(second.status).toBe(201);
  });
});

describe("idempotency", () => {
  it("makes one ticket from a double click, and the second click gets the first's", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const [one, two] = await Promise.all([
      rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, { title: "One" }),
      rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, { title: "Two" }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 201]);
    expect(one.body.ticket.id).toBe(two.body.ticket.id);
    expect(rig.app.deps.tickets.all()).toHaveLength(1);
    expect(rig.prs.prs).toHaveLength(1);
    const later = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, { title: "Three" });
    expect(later.status).toBe(200);
    expect(later.body).toMatchObject({
      created: false,
      ticket: { id: one.body.ticket.id, title: one.body.ticket.title },
    });
    expect(rig.app.deps.tickets.all()).toHaveLength(1);
    expect(rig.prs.prs).toHaveLength(1);
  });

  it("does not open a PR for work that is a ticket's, nor a ticket while a PR is being made", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const t = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    const pr = await rig.call("POST", `/api/conversations/${c.conv.id}/pr`, {});
    expect(pr.status).toBe(409);
    expect(pr.body.code).toBe("ticket");
    expect(pr.body.error).toContain(`ticket #${t.body.ticket.id}`);
    const rig2 = await make({ mode: "owner-merges" });
    const c2 = await rig2.conversation();
    c2.write("a.txt", "a\n");
    const [p, tk] = await Promise.all([
      rig2.call("POST", `/api/conversations/${c2.conv.id}/pr`, {}),
      rig2.call("POST", `/api/conversations/${c2.conv.id}/ticket`, {}),
    ]);
    expect(p.status).toBe(201);
    expect(tk.status).toBe(409);
    expect(tk.body.code).toBe("busy");
  });
});

describe("what is refused, in sentences", () => {
  it("a conversation without a project", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation(null);
    for (const [method, path] of [
      ["POST", "ticket"],
      ["POST", "pr"],
    ] as const) {
      const r = await rig.call(method, `/api/conversations/${c.conv.id}/${path}`, {});
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("no-project");
      expect(r.body.error).toBe(
        "This conversation has no project, so it has no code to ship. Start a conversation on a project to ship its changes.",
      );
    }
    const view = await rig.call("GET", `/api/conversations/${c.conv.id}/ship`);
    expect(view.status).toBe(200);
    expect(view.body.ship).toMatchObject({ project: null, canTicket: false, canPr: false });
    expect(view.body.ship.reason).toMatch(/no project/);
    expect(rig.app.deps.tickets.all()).toHaveLength(0);
  });

  it("an unknown or archived conversation, and a daemon without GitHub", async () => {
    const rig = await make({ mode: "direct" });
    expect((await rig.call("POST", "/api/conversations/nope/ticket", {})).status).toBe(404);
    expect((await rig.call("GET", "/api/conversations/nope/ship")).status).toBe(404);
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    await rig.call("PATCH", `/api/conversations/${c.conv.id}`, { archived: true });
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/archived/);
    const bare = await make({ mode: "direct", github: false });
    const b = await bare.call("POST", "/api/conversations/x/ticket", {});
    expect(b.status).toBe(409);
    expect(b.body.error).toMatch(/GitHub isn't set up/);
  });

  it("a body with a field it doesn't take, a bad done-when, or no JSON object", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const url = `/api/conversations/${c.conv.id}/ticket`;
    expect((await rig.call("POST", url, { project: "Other" })).status).toBe(400);
    expect((await rig.call("POST", url, { title: 5 })).body.error).toMatch(/title must be text/);
    expect((await rig.call("POST", url, { title: "  " })).status).toBe(400);
    expect((await rig.call("POST", url, { title: "x".repeat(201) })).status).toBe(400);
    expect((await rig.call("POST", url, { doneWhen: [] })).status).toBe(400);
    expect((await rig.call("POST", url, { doneWhen: ["ok", 3] })).status).toBe(400);
    expect((await rig.call("POST", url, { doneWhen: Array(11).fill("x") })).status).toBe(400);
    expect((await rig.call("POST", url, "[1]")).status).toBe(400);
    expect((await rig.call("POST", url, "not json")).status).toBe(400);
    expect((await rig.call("POST", `/api/conversations/${c.conv.id}/pr`, { draft: false })).status).toBe(400);
    expect((await rig.call("GET", `/api/conversations/${c.conv.id}/ship?preview=2`)).status).toBe(400);
    // Nothing was made by any of that.
    expect(rig.app.deps.tickets.all()).toHaveLength(0);
    expect(rig.prs.prs).toHaveLength(0);
    expect(c.git("status", "--porcelain")).toContain("a.txt");
  });

  it("GitHub being down, in the bot's words, not GitHub's, and nothing half-made", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const { UpstreamGitHubError } = await import("../src/github.ts");
    rig.prs.failWith = new UpstreamGitHubError(500, "POST", "/repos/x/pulls", "Server Error: secret detail");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(r.status).toBe(424);
    expect(r.body.error).not.toMatch(/secret detail|Server Error/);
    expect(r.body.error).toMatch(/GitHub/);
    expect(rig.app.deps.tickets.all()).toHaveLength(0);
    expect((await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship).toBeUndefined();
    // The work was committed and pushed, so trying again carries on.
    rig.prs.failWith = null;
    const again = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(again.status).toBe(201);
    expect(rig.prs.prs).toHaveLength(1);
  });
});

describe("a ticket from a conversation, seen from the ticket", () => {
  it("names the conversation it came from, and the branch is the conversation's", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, { title: "Greeting" });
    const t = await rig.call("GET", `/api/tickets/${r.body.ticket.id}`);
    expect(t.body.ticket.fromConversation).toEqual({ id: c.conv.id, title: "plain add a greeting file" });
    const board = await rig.call("GET", "/api/board");
    expect(
      board.body.tickets.find((x: { id: string }) => x.id === r.body.ticket.id).fromConversation.id,
    ).toBe(c.conv.id);
    await rig.settle();
    // Its sessions ran in the conversation's folder.
    expect(rig.agent.calls.length).toBeGreaterThan(0);
  });

  it("gives the copy back when the ticket fails, and takes it again when the owner retries it", async () => {
    const rig = await make({ mode: "direct" });
    // The first review gives up; the second (after the owner's retry) works.
    rig.agent.on({ stage: "review" }, { kind: "stuck", reason: "the reviewer lost its place" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    const id = r.body.ticket.id;
    await rig.settle();
    const s = await rig.app.daemon.state(id);
    expect(s.status).toBe("failed");
    // The conversation has its copy back, with a note about the failure.
    await until(
      async () =>
        (await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship === undefined,
    );
    c.say("plain what happened", "t2");
    await until(() => rig.app.ahp.host.chatState(c.conv.ahpChat)?.turns.length === 2);
    expect(JSON.stringify(rig.sandbox.last.prompts.at(-1))).toContain(`ticket #${id} took over this branch`);
    expect(JSON.stringify(rig.sandbox.last.prompts.at(-1))).toContain("failed");

    // Retrying takes the copy back: the agent is stopped first, and the ticket runs.
    const retry = await rig.call("POST", `/api/tickets/${id}/retry`, {});
    expect(retry.status).toBe(200);
    await until(() => rig.sandbox.live.length === 0);
    c.say("plain still there", "t3");
    await new Promise((res) => setTimeout(res, 30));
    expect(rig.app.ahp.host.chatState(c.conv.ahpChat)?.turns).toHaveLength(2);
    await rig.settle();
    expect((await rig.app.daemon.state(id)).outcome).toBe("merged");
  });

  it("refuses a retry while the conversation is mid-turn in that folder", async () => {
    const rig = await make({ mode: "direct" });
    rig.agent.on({ stage: "review" }, { kind: "stuck", reason: "the reviewer lost its place" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    await rig.settle();
    await until(
      async () =>
        (await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship === undefined,
    );
    c.say("slow going", "t2");
    await until(() => rig.app.ahp.host.hasActiveTurn(c.conv.ahpChat));
    const retry = await rig.call("POST", `/api/tickets/${r.body.ticket.id}/retry`, {});
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatch(/working in that folder/);
  });
});

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("what is already committed is scanned too", () => {
  for (const mode of ["direct", "owner-merges"] as const) {
    it(`refuses a token that was committed and then removed, in ${mode} mode, and ships nothing`, async () => {
      const rig = await make({ mode });
      const c = await rig.conversation();
      c.write("config.ts", `export const token = "${TOKEN}";\n`);
      c.git("add", "-A");
      c.git("commit", "-q", "-m", "add config");
      c.write("config.ts", "export const token = process.env.TOKEN;\n");
      c.git("add", "-A");
      c.git("commit", "-q", "-m", "remove the token");
      // The tree is clean and the net change has no credential; the history has one.
      expect(c.git("status", "--porcelain")).toBe("");
      const preview = await rig.call("GET", `/api/conversations/${c.conv.id}/ship?preview=1`);
      expect(preview.body.ship.copy.blockers[0]).toMatch(/in the branch's history/);

      const t = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
      expect(t.status).toBe(409);
      expect(t.body.code).toBe("secrets");
      expect(t.body.error).toContain("in the branch's history");
      expect(JSON.stringify(t.body)).not.toContain(TOKEN);
      expect(rig.app.deps.tickets.all()).toHaveLength(0);
      expect(rig.prs.prs).toHaveLength(0);
      expect(rig.originGit("branch", "--list", `conv/${c.conv.id}`)).toBe("");
      if (mode === "owner-merges") {
        const pr = await rig.call("POST", `/api/conversations/${c.conv.id}/pr`, {});
        expect(pr.status).toBe(409);
        expect(pr.body.code).toBe("secrets");
        expect(rig.originGit("branch", "--list", `conv/${c.conv.id}`)).toBe("");
      }
      // Not held, and the copy is untouched.
      expect(
        (await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship,
      ).toBeUndefined();
    });
  }

  it("scans a copy again when the owner retries a failed ticket, and refuses what the conversation added meanwhile", async () => {
    const rig = await make({ mode: "direct" });
    rig.agent.on({ stage: "review" }, { kind: "stuck", reason: "the reviewer lost its place" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    const id = r.body.ticket.id;
    await rig.settle();
    expect((await rig.app.daemon.state(id)).status).toBe("failed");
    await until(
      async () =>
        (await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship === undefined,
    );
    // The conversation carries on and commits a token.
    c.write("leak.ts", `export const t = "${TOKEN}";\n`);
    c.git("add", "-A");
    c.git("commit", "-q", "-m", "oops");
    const retry = await rig.call("POST", `/api/tickets/${id}/retry`, {});
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatch(/Nothing was retried/);
    expect(retry.body.error).not.toContain(TOKEN);
    expect((await rig.app.daemon.state(id)).status).toBe("failed");
    // The claim was let go: the conversation still takes messages.
    expect((await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship).toBeUndefined();
    // Clean again, the retry goes through.
    c.git("reset", "-q", "--hard", "HEAD~1");
    expect((await rig.call("POST", `/api/tickets/${id}/retry`, {})).status).toBe(200);
    await rig.settle();
    expect((await rig.app.daemon.state(id)).outcome).toBe("merged");
  });

  it("asks the owner to confirm binary files it can't scan, and names them", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${c.dir}/logo.bin`, Buffer.alloc(20_000, 0));
    const preview = await rig.call("GET", `/api/conversations/${c.conv.id}/ship?preview=1`);
    expect(preview.body.ship.copy.binaries).toEqual([{ path: "logo.bin", size: 20000 }]);
    const refused = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("binary");
    expect(refused.body.error).toContain("logo.bin");
    expect(refused.body.error).toMatch(/can't be checked for credentials/);
    expect(rig.app.deps.tickets.all()).toHaveLength(0);
    expect((await rig.call("POST", `/api/conversations/${c.conv.id}/pr`, {})).body.code).toBe("binary");
    expect(
      (await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, { confirmBinary: "yes" })).status,
    ).toBe(400);
    const ok = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, { confirmBinary: true });
    expect(ok.status).toBe(201);
  });
});

describe("a claim that nothing is working on", () => {
  it("lets go of a stale claim without a restart, so the conversation isn't locked", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    // A claim with no ticket, as a crash would leave it.
    rig.app.db.run(
      "INSERT INTO conversation_tickets (conversation_id, ticket_id, created_at) VALUES (?, NULL, ?)",
      c.conv.id,
      rig.clock.now(),
    );
    expect(
      (await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship.ticket.held,
    ).toBe(true);
    c.say("plain are you there", "t2");
    await new Promise((res) => setTimeout(res, 30));
    expect(rig.app.ahp.host.chatState(c.conv.ahpChat)?.turns).toHaveLength(1);
    // Under ten minutes it still holds; after, it is gone the next time anything looks.
    rig.clock.advance(5);
    expect((await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship).toBeDefined();
    rig.clock.advance(6);
    expect((await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship).toBeUndefined();
    expect((await rig.call("GET", `/api/conversations/${c.conv.id}/ship`)).body.ship.ticket).toBeNull();
    expect((await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {})).status).toBe(201);
  });

  it("leaves no ticket and no claim when writing the ticket fails half way", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const store = rig.app.deps.store;
    const write = store.write.bind(store);
    store.write = () => {
      throw new Error("disk full");
    };
    // A route that throws answers 500 (T63).
    expect((await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {})).status).toBe(500);
    store.write = write;
    // The ticket row went with it (one transaction), the claim too, and nothing is held.
    expect(rig.app.deps.tickets.all()).toHaveLength(0);
    expect(rig.app.db.all("SELECT * FROM conversation_tickets")).toEqual([]);
    expect((await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship).toBeUndefined();
    // And trying again makes the one ticket.
    const again = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    expect(again.status).toBe(201);
    expect(rig.app.deps.tickets.all()).toHaveLength(1);
    expect(again.body.ticket.id).toBe("1");
  });
});

describe("taking the work back, and what a ticket leaves for the conversation", () => {
  it("keeps what a ticket did to the branch for the agent's next turn, across a restart of the host's memory", async () => {
    const rig = await make({ mode: "direct" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    await rig.settle();
    expect((await rig.app.daemon.state(r.body.ticket.id)).outcome).toBe("merged");
    await until(
      async () =>
        (await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship === undefined,
    );
    // In the database, not in a live agent's memory.
    const rows = rig.app.db.all<{ note: string }>(
      "SELECT note FROM conversation_notes WHERE conversation_id = ?",
      c.conv.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.note).toContain(`ticket #${r.body.ticket.id} took over this branch`);
    // Whatever the host remembers is gone: the note still reaches the next prompt, once.
    (rig.app.ahp.backend as unknown as { lives: Map<string, unknown> }).lives.clear();
    c.say("plain carry on", "t2");
    await until(() => rig.app.ahp.host.chatState(c.conv.ahpChat)?.turns.length === 2);
    expect(JSON.stringify(rig.sandbox.last.prompts.at(-1))).toContain("took over this branch");
    expect(rig.app.db.all("SELECT * FROM conversation_notes")).toEqual([]);
  });

  it("lets the owner take the work back from a ticket that waits for them, ending it as rejected", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    const id = r.body.ticket.id;
    await rig.settle();
    expect((await rig.app.daemon.state(id)).status).toBe("ready");
    const view = await rig.call("GET", `/api/conversations/${c.conv.id}/ship`);
    expect(view.body.ship.ticket).toMatchObject({ held: true, canTakeBack: true });
    expect((await rig.call("POST", `/api/conversations/${c.conv.id}/take-back`, { x: 1 })).status).toBe(400);
    const back = await rig.call("POST", `/api/conversations/${c.conv.id}/take-back`, {});
    expect(back.status).toBe(200);
    expect(back.body).toEqual({ ok: true, released: true, pr: "closed" });
    // The ticket's pull request is closed with it.
    expect(rig.prs.prs[0]?.state).toBe("closed");
    expect(rig.prs.calls).toContain("close 1");
    const s = await rig.app.daemon.state(id);
    expect(s.status).toBe("done");
    expect(s.outcome).toBe("rejected");
    expect(
      (await rig.call("GET", `/api/conversations/${c.conv.id}`)).body.conversation.ship.ticket,
    ).toBeNull();
    // Twice is harmless, and the conversation takes a message again, told what happened.
    expect((await rig.call("POST", `/api/conversations/${c.conv.id}/take-back`, {})).body).toEqual({
      ok: true,
      released: false,
      pr: "none",
    });
    c.say("plain back again", "t2");
    await until(() => rig.app.ahp.host.chatState(c.conv.ahpChat)?.turns.length === 2);
    expect(JSON.stringify(rig.sandbox.last.prompts.at(-1))).toContain("ended: rejected");
  });

  it("says the pull request is still open when GitHub can't be asked, and still gives the copy back", async () => {
    const rig = await make({ mode: "owner-merges" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    await rig.settle();
    const { UpstreamGitHubError } = await import("../src/github.ts");
    rig.prs.failWith = new UpstreamGitHubError(500, "GET", "/repos/x/pulls/1", "internal detail");
    const back = await rig.call("POST", `/api/conversations/${c.conv.id}/take-back`, {});
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ released: true, pr: "open" });
    expect(back.body.prProblem).not.toMatch(/internal detail/);
    expect((await rig.app.daemon.state(r.body.ticket.id)).outcome).toBe("rejected");
    expect(rig.prs.prs[0]?.state).toBe("open");
  });

  it("won't take the work back from a ticket that is running", async () => {
    const rig = await make({ mode: "direct" });
    rig.agent.on({ stage: "review" }, { kind: "hang" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    const r = await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    await until(() => rig.agent.calls.some((x) => x.stage === "review"));
    const back = await rig.call("POST", `/api/conversations/${c.conv.id}/take-back`, {});
    expect(back.status).toBe(409);
    expect(back.body.code).toBe("running");
    expect(
      (await rig.call("GET", `/api/conversations/${c.conv.id}/ship`)).body.ship.ticket.canTakeBack,
    ).toBeUndefined();
    expect((await rig.call("POST", "/api/conversations/nope/take-back", {})).status).toBe(404);
    expect(r.body.ticket.id).toBeTruthy();
  });

  it("keeps an archived conversation's copy out of the cleanup while a ticket has it", async () => {
    const rig = await make({ mode: "direct" });
    rig.agent.on({ stage: "review" }, { kind: "hang" });
    const c = await rig.conversation();
    c.write("a.txt", "a\n");
    await rig.call("POST", `/api/conversations/${c.conv.id}/ticket`, {});
    await until(() => rig.agent.calls.some((x) => x.stage === "review"));
    expect((await rig.call("PATCH", `/api/conversations/${c.conv.id}`, { archived: true })).status).toBe(200);
    const cleanup = (rig.app.storage as unknown as { d: { archivedConversations: () => { id: string }[] } })
      .d;
    expect(cleanup.archivedConversations().map((x) => x.id)).not.toContain(c.conv.id);
    expect(rig.app.deps.shipping?.holds(c.conv.id)).toBe(true);
    // Another archived conversation, with no ticket, is still the cleanup's.
    const other = await rig.conversation();
    await rig.call("PATCH", `/api/conversations/${other.conv.id}`, { archived: true });
    expect(cleanup.archivedConversations().map((x) => x.id)).toContain(other.conv.id);
  });
});
