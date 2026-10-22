// End to end on real mode's ports, with a scripted ACP agent and a bash folder for the sandbox (T58): the
// tidy-up ticket runs; the agent edits its brain copy during it; when the ticket ends the daemon collects the
// diff, checks it and commits it; the feed shows it; the owner reverts it; and the next brief carries the page.
import type { Ticket } from "@i-inc/core";
import { afterEach, describe, expect, it } from "vitest";
import { TIDY_LABEL } from "../src/daemon.ts";
import type { Any } from "./ahp/support.ts";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("the tidy-up, end to end", () => {
  it("lets an agent edit its copy during a ticket, commits it afterwards, shows it in the feed, reverts it, and feeds it to the next brief", async () => {
    const w = await brainRig({ real: true });
    w.commit("handbook", {
      "facts/gh.md": page(
        "GitHub CLI",
        "gh pr checks waits for CI",
        "Use gh pr checks --watch to wait. See [[facts/missing]] for the long form.",
      ),
      "facts/github-cli.md": page(
        "GitHub CLI",
        "gh pr checks waits for CI",
        "gh pr checks prints the table of checks.",
      ),
    });
    const merged = page(
      "GitHub CLI",
      "gh pr checks --watch waits for CI and prints the table of checks",
      "Use gh pr checks --watch to wait for CI; it prints the table of checks as they finish.\nThe long form is in the docs.",
    );
    const root = `${w.sandbox}/ada`;
    // The scripted agent merges the duplicate into facts/gh and deletes the other page, as a librarian would.
    const script = [
      `@@write ${b64(`${root}/company/facts/gh.md`)} ${b64(merged)}`,
      `@@write ${b64(`${root}/company/facts/github-cli.md`)} ${b64("@@delete")}`,
    ];
    const ticket: Ticket = w.app.deps.tickets.create(
      {
        title: "Tend the brain",
        project: "General",
        type: "tidy",
        effort: "low",
        doneWhen: script,
        assignee: "ada",
        createdBy: "ada",
        labels: [TIDY_LABEL],
      },
      w.clock.now(),
    );

    await w.app.daemon.tick();
    await w.app.daemon.idle();
    await w.app.deps.brainHarvest.settled();

    // The ticket ran as an ordinary ticket and closed; the librarian was told where to look.
    const state = (await w.call("GET", `/api/tickets/${ticket.id}`)).body;
    expect(state.ticket).toMatchObject({ type: "tidy", status: "done" });
    const prompt = (w.fake.last.prompts[0]?.blocks ?? []).map((b: Any) => b.text).join("\n");
    expect(prompt).toContain("<tidy>");
    expect(prompt).toContain("facts/github-cli.md");
    expect(prompt).toContain("[[facts/missing]]");
    expect(prompt).toContain("You may edit the copy");

    // What the agent wrote is in the shared brain, with who and where from.
    const gh = w.git("handbook", "show", "HEAD~1:facts/gh.md");
    expect(gh).toContain("it prints the table of checks as they finish");
    expect(gh).toContain(`sources: [ticket-${ticket.id}]`);
    expect(() => w.git("handbook", "show", "HEAD:facts/github-cli.md")).toThrow();
    const log = w.git("handbook", "log", "-2", "--format=%s%n%b");
    expect(log).toContain("Author: ada");
    expect(log).toContain(`Ticket: ${ticket.id}`);

    // The feed shows both, newest first, linked to the ticket.
    const feed = (await w.call("GET", "/api/brain/changes")).body.changes as Any[];
    expect(feed.map((c) => `${c.op} ${c.path}`).sort()).toEqual([
      "delete company/facts/github-cli.md",
      "update company/facts/gh.md",
    ]);
    expect(feed[0]).toMatchObject({
      status: "committed",
      employee: { id: "ada" },
      source: { kind: "ticket", id: ticket.id, url: `#/ticket/${ticket.id}` },
    });
    expect(w.logs.join("\n")).toMatch(/ada's copy \(ticket-\d+\): 2 committed, 0 refused/);

    // The copy's baseline moved: a later harvest finds nothing, and the next copy is the shared brain's.
    expect(
      await w.app.deps.brainHarvest.run({
        employeeId: "ada",
        source: { kind: "ticket", id: "x" },
        trigger: "catch-up",
      }),
    ).toMatchObject({ status: "nothing" });

    // The next ticket's brief carries the merged page (the shared brain is what retrieval reads).
    const ports = (w.app.daemon as unknown as { ports: { agent: { run: (r: Any) => Promise<Any> } } }).ports;
    const next = w.app.deps.tickets.create(
      {
        title: "Wait for CI with gh",
        project: "Duet",
        type: "feat",
        effort: "low",
        doneWhen: [],
        assignee: "ada",
      },
      w.clock.now(),
    );
    const ask = async () => {
      await ports.agent.run({
        ticket: next,
        stage: "build",
        duty: "build",
        employee: w.app.deps.registry.employee("ada"),
        engine: w.app.deps.registry.engine("opus"),
        brief: "build it",
      });
      return (w.fake.last.prompts.at(-1)?.blocks ?? []).map((b: Any) => b.text).join("\n");
    };
    expect(await ask()).toContain("it prints the table of checks as they finish");

    // The owner undoes the update with one click; the next brief has the old page again.
    const update = feed.find((c) => c.op === "update");
    const reverted = await w.call("POST", `/api/brain/changes/${update.id}/revert`);
    expect(reverted.status).toBe(200);
    expect(w.git("handbook", "show", "HEAD:facts/gh.md")).not.toContain(
      "it prints the table of checks as they finish",
    );
    const again = await ask();
    expect(again).not.toContain("it prints the table of checks as they finish");
    expect(again).toContain("Use gh pr checks --watch to wait");
  });
});
