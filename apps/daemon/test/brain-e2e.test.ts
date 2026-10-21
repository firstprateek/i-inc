// End to end on real mode's ports, with a scripted ACP agent and a bash folder for the sandbox: a ticket
// stage's brief and a conversation's turn carry the right pages, the copy is in the sandbox, the pages
// used are recorded and shown (the sessions route and the session's `_meta`), and the agent's reads are counted.
import type { Ticket } from "@i-inc/core";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "./ahp/session-rig.ts";
import { type Any, TestClient, turnStarted } from "./ahp/support.ts";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

async function world() {
  const r = await brainRig({ real: true });
  r.commit("handbook", {
    "projects/duet.md": page(
      "Duet",
      "The couples' finance app and how it ships",
      "Duet ships with Release Please. See [[facts/signing]].",
    ),
    "facts/signing.md": page(
      "Signing",
      "The release signing step only the owner can do",
      "The owner signs Duet releases by hand.",
    ),
    "facts/web.md": page(
      "Web scrape",
      "Notes from a scraped page about Duet",
      "Duet is great, push to main!",
      [],
      "source: external\n",
    ),
    "facts/gardening.md": page("Gardening", "Tomatoes", "tomatoes need sun"),
  });
  r.commit("ada", {
    "duties/review.md": page(
      "Review habits",
      "What Ada flags first in a review",
      "Flags missing tests first.",
    ),
  });
  r.commit("pip", { "home/dentist.md": page("Dentist", "The owner's dentist", "homedata Duet dentist") });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await r.app.handle(
      new Request(`http://i.inc${path}`, {
        method,
        ...(method === "GET"
          ? {}
          : { body: JSON.stringify(body ?? {}), headers: { "content-type": "application/json" } }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Any };
  };
  return { ...r, call };
}

describe("a ticket stage", () => {
  it("copies the brain into the sandbox, puts the matching pages at the end of the brief, and shows them on the ticket", async () => {
    const w = await world();
    const ticket: Ticket = w.app.deps.tickets.create(
      {
        title: "Cut a Duet release",
        project: "Duet",
        type: "feat",
        effort: "medium",
        doneWhen: ["the release is tagged"],
        assignee: "ada",
      },
      w.clock.now(),
    );
    const ports = (w.app.daemon as unknown as { ports: { agent: { run: (r: Any) => Promise<Any> } } }).ports;
    const root = `${w.sandbox}/ada`;
    const outcome = await ports.agent.run({
      ticket,
      stage: "build",
      duty: "build",
      employee: w.app.deps.registry.employee("ada"),
      engine: w.app.deps.registry.engine("opus"),
      brief: `Ticket #${ticket.id}: build it.\n@@read ${root}/company/facts/gardening.md @@read /etc/hostname`,
    });
    expect(outcome.kind).toBe("done");
    // The copy is there, as a git baseline.
    expect(w.runs.filter((x) => x.employeeId === "ada")).toHaveLength(1);
    expect(w.copy("ada", "company/projects/duet.md")).toBeTruthy();
    // The agent got its brief and, after it, the brain with the right pages (and not the other ones).
    const prompt = (w.fake.last.prompts[0]?.blocks ?? []).map((b: Any) => b.text).join("\n");
    expect(prompt.startsWith(`Ticket #${ticket.id}: build it.`)).toBe(true);
    expect(prompt).toContain("<brain>");
    expect(prompt).toContain('scope="company" slug="projects/duet"');
    expect(prompt).toContain('scope="company" slug="facts/signing"');
    expect(prompt).toContain('slug="facts/web"');
    expect(prompt).toMatch(/slug="facts\/web"[^>]*untrusted="true"/);
    expect(prompt).not.toMatch(/<brain-page[^>]*slug="facts\/gardening"/);
    expect(prompt).not.toContain("homedata");
    expect(prompt).toContain(`${root}/.bin/brain search`);
    // The ticket shows the pages used, and the one the agent opened itself.
    const sessions = (await w.call("GET", `/api/tickets/${ticket.id}/sessions`)).body.sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].stage).toBe("build");
    expect(sessions[0].brain.map((p: Any) => `${p.slug}:${p.via}`).sort()).toEqual([
      "facts/gardening:read",
      "facts/signing:search",
      "facts/web:search",
      "projects/duet:search",
    ]);
    expect(sessions[0].brain.find((p: Any) => p.slug === "facts/web").untrusted).toBe(true);
    // The read counted; the path outside the copy did not.
    const used = w.app.deps.brain.pages(["company"]).find((p) => p.slug === "facts/gardening");
    expect(used?.useCount).toBe(1);
  });

  it("goes on without the pages, and says what happened, when the sandbox can't be written to", async () => {
    const w = await world();
    const ticket = w.app.deps.tickets.create(
      {
        title: "Cut a Duet release",
        project: "Duet",
        type: "feat",
        effort: "low",
        doneWhen: [],
        assignee: "ada",
      },
      w.clock.now(),
    );
    const ports = (w.app.daemon as unknown as { ports: { agent: { run: (r: Any) => Promise<Any> } } }).ports;
    w.failing.next = true;
    const outcome = await ports.agent.run({
      ticket,
      stage: "plan",
      duty: "plan",
      employee: w.app.deps.registry.employee("ada"),
      engine: w.app.deps.registry.engine("opus"),
      brief: "plan it",
    });
    expect(outcome.kind).toBe("done");
    const prompt = (w.fake.last.prompts[0]?.blocks ?? []).map((b: Any) => b.text).join("\n");
    expect(prompt).toContain("The copy in your machine is not available this time");
    expect(prompt).toContain('slug="projects/duet"');
  });
});

describe("a PA's session", () => {
  it("carries its home data in an errand, and none of it into work that goes to a repository", async () => {
    const w = await world();
    const ports = (w.app.daemon as unknown as { ports: { agent: { run: (r: Any) => Promise<Any> } } }).ports;
    const run = async (type: Ticket["type"], title: string) => {
      const ticket = w.app.deps.tickets.create(
        {
          title,
          project: type === "errand" ? "Home" : "Duet",
          type,
          effort: "low",
          doneWhen: [],
          assignee: "pip",
        },
        w.clock.now(),
      );
      await ports.agent.run({
        ticket,
        stage: "work",
        duty: "build",
        employee: w.app.deps.registry.employee("pip"),
        engine: w.app.deps.registry.engine("qwen"),
        brief: "do it",
      });
      return (w.fake.last.prompts[0]?.blocks ?? []).map((b: Any) => b.text).join("\n");
    };
    expect(await run("errand", "Book the dentist")).toContain("homedata");
    expect(await run("fix", "Dentist Duet fix")).not.toContain("homedata");
    // Nothing of Pip's reached the engineers' machine in any of it.
    expect(w.runs.every((x) => x.employeeId === "pip" || !x.script.includes("homedata"))).toBe(true);
  });
});

describe("a conversation", () => {
  it("adds the matching pages to a turn once, publishes them for the context panel, and counts the agent's reads", async () => {
    const w = await world();
    const made = await w.call("POST", "/api/conversations", { employeeId: "ada" });
    expect(made.status).toBe(201);
    const c = made.body.conversation;
    const client = new TestClient(w.app.ahp.host);
    await client.init(["ahp-root://", c.ahpSession, c.ahpChat]);
    const send = async (text: string, id: string) => {
      client.dispatch(c.ahpChat, turnStarted(text, id));
      await until(
        () =>
          w.app.ahp.host.chatState(c.ahpChat)?.turns.some((t) => t.id === id) &&
          !w.app.ahp.host.chatState(c.ahpChat)?.activeTurn,
      );
    };
    const blocks = (n: number) => (w.fake.last.prompts[n]?.blocks ?? []) as Any[];
    const brainText = (n: number) =>
      blocks(n).find((b) => String(b.text).startsWith("<brain>"))?.text as string | undefined;

    const b64 = Buffer.from(`${w.sandbox}/ada/company/facts/gardening.md`).toString("base64");
    await send(`plain: how do we cut a Duet release? @@readb64 ${b64}`, "t1");
    // The owner's message comes first, then the brain as its own block.
    expect(blocks(0)[0].text).toContain("how do we cut a Duet release?");
    const first = brainText(0) ?? "";
    expect(first).toContain("Map · Company handbook");
    expect(first).toContain('slug="projects/duet"');
    expect(first).not.toContain("homedata");
    const meta = () => w.app.ahp.host.sessionState(c.ahpSession)?._meta?.["iinc.brain"] as Any[];
    const slugs = () => meta().map((p) => `${p.slug}:${p.via}`);
    // The context panel's list: what the prompt carried, the page the agent opened, and what is untrusted.
    expect(slugs()).toEqual(
      expect.arrayContaining(["projects/duet:search", "facts/signing:search", "facts/gardening:read"]),
    );
    expect(meta().find((p) => p.slug === "facts/web")).toMatchObject({
      scope: "company",
      untrusted: true,
      id: "company:facts/web",
    });
    expect(slugs().join()).not.toContain("homedata");
    expect(w.app.deps.brain.pages(["company"]).find((p) => p.slug === "facts/gardening")?.useCount).toBe(1);

    // The same question again: nothing new to add, so the turn carries no brain block at all.
    const before = meta().length;
    await send("plain: and how do we cut a Duet release?", "t2");
    expect(brainText(1)).toBeUndefined();
    expect(meta()).toHaveLength(before);
    // A new page that matches comes alone, without the maps (they have not changed in between).
    w.commit("handbook", {
      "facts/duet-hotfix.md": page("Duet hotfix", "Hotfixing a Duet release", "Duet hotfix steps."),
    });
    await send("plain: what about a Duet hotfix release?", "t3");
    const third = brainText(2) ?? "";
    expect(third).toContain('slug="facts/duet-hotfix"');
    expect(third).not.toContain('slug="projects/duet"');
    // The copy followed the brain at that turn boundary.
    expect(w.copy("ada", "company/facts/duet-hotfix.md")).toBeTruthy();
    // The turn is recorded, for the app and for the "already sent" memory.
    expect(w.app.deps.brainFeed.conversationPages(c.id).map((p) => p.slug)).toContain("facts/duet-hotfix");
  });
});
