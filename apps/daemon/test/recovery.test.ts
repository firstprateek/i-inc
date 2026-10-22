// Restart and crash recovery (T63 audit, group 2): a graceful stop leaves tickets resumable, and the
// pieces a restart depends on stay consistent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fold } from "@i-inc/core";
import { FakeChat, FakeClock, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import { AcpAgent, type AgentProcess } from "../src/acp.ts";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";
import { refunds, testApp } from "./setup.ts";

type Json = Record<string, unknown>;

/** An ACP server that starts a session and then never answers the prompt; it exits when its stdin ends. */
function silentAgentProcess(): AgentProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exit: (c: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => {
    exit = r;
  });
  let buf = "";
  stdin.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i)) as Json;
      buf = buf.slice(i + 1);
      const reply = (r: Json) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...r })}\n`);
      if (m.method === "initialize") reply({ id: m.id, result: { protocolVersion: 1 } });
      if (m.method === "session/new") {
        reply({
          id: m.id,
          result: { sessionId: "s1", modes: { availableModes: [{ id: "bypassPermissions" }] } },
        });
      }
      if (m.method === "session/set_mode") reply({ id: m.id, result: {} });
    }
  });
  stdin.on("end", () => setTimeout(() => exit(0), 5));
  return { stdin, stdout, stderr, kill: () => exit(null), exited };
}

const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 500; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting");
};

describe("2.1 a graceful stop mid-session", () => {
  for (const onStuck of ["switch", "escalate"] as const) {
    it(`leaves the ticket running and resumable (onStuck: ${onStuck})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "i-inc-recovery-"));
      const path = join(dir, "t.db");
      const clock = new FakeClock();
      const agent = new AcpAgent({
        launch: () => silentAgentProcess(),
        credentials: () => ({}),
        cwdFor: (id) => `/home/employee/work/inc-${id}`,
        now: () => clock.now(),
      });
      const first = await createApp({
        dbPath: path,
        knowledgeDir: join(dir, "k"),
        configDir: join(dir, "c"),
        clock,
        agent,
        harness: new FakeHarness(),
        helper: new FakeHelper(),
        chat: new FakeChat(),
        machines: new FakeMachines(),
      });
      seedDemo(first.deps.registry);
      for (const e of first.deps.registry.employees()) {
        first.deps.registry.hire({ ...e, switchRules: { ...e.switchRules, onStuck } });
      }
      first.daemon.ensureKnowledge();
      first.deps.tickets.create(
        { title: "Refunds", project: "Duet", type: "fix", effort: "low", doneWhen: ["x"], assignee: "ada" },
        clock.now(),
      );
      void first.daemon.tick();
      await until(async () =>
        (await first.deps.store.read("1")).some((e) => e.type === "session-started" && e.stage === "build"),
      );
      // Let the prompt reach the server, then what main.ts does on SIGTERM.
      await new Promise((r) => setTimeout(r, 50));
      await agent.shutdown(30);
      await first.daemon.idle();

      const types = (await first.deps.store.read("1")).map((e) => e.type);
      expect(types).not.toContain("failed");
      expect(types).not.toContain("engine-switched");
      expect(types).not.toContain("needs-you");
      expect(types).not.toContain("session-interrupted");
      expect(fold(await first.deps.store.read("1")).status).toBe("running");
      first.db.close();

      // The next daemon start picks it up and finishes it.
      const second = await testApp(path);
      await second.daemon.tick();
      await second.daemon.idle();
      const t = (await second.call("GET", "/api/tickets/1")).body.ticket;
      expect(t.status).toBe("ready");
      expect(second.agent.callsFor("ada", "build")).toHaveLength(1);
    });
  }
});
