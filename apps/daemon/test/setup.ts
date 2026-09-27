// A daemon over an in-memory (or temp-file) database, with the core's fakes and the spec's cast.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgent, FakeChat, FakeClock, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";

export async function testApp(
  dbPath = ":memory:",
  knowledgeDir = mkdtempSync(join(tmpdir(), "i-inc-knowledge-")),
) {
  const clock = new FakeClock();
  const agent = new FakeAgent();
  const harness = new FakeHarness();
  const helper = new FakeHelper();
  const chat = new FakeChat();
  const app = await createApp({
    dbPath,
    knowledgeDir,
    clock,
    agent,
    harness,
    helper,
    chat,
    machines: new FakeMachines(),
  });
  if (app.deps.registry.employees().length === 0) {
    seedDemo(app.deps.registry);
    app.daemon.ensureKnowledge();
  }
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.handle(
      new Request(`http://i.inc${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: tests read the API's JSON loosely, the way a client would.
    const data = (await res.json()) as Record<string, any>;
    return { status: res.status, body: data };
  };
  return { ...app, clock, agent, harness, helper, chat, call };
}

export const refunds = {
  title: "Refunds are counted as spending",
  project: "Duet",
  type: "fix",
  effort: "medium",
  doneWhen: ["August drops by the refund"],
  assignee: "ada",
};
