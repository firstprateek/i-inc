// The transport on a real Bun.serve (skipped where Bun is not installed): the upgrade locks, the frame
// limit and the keepalive, as the browser and the CLI will meet them. Driven by Node's WebSocket client.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Any } from "./support.ts";

const hasBun = spawnSync("bun", ["--version"]).status === 0;
const dir = dirname(fileURLToPath(import.meta.url));

describe.skipIf(!hasBun)("AHP on Bun.serve", () => {
  let proc: ChildProcess;
  let base: { port: number; session: string; chat: string };
  beforeAll(async () => {
    proc = spawn("bun", [join(dir, "bun-fixture.ts")], { env: { ...process.env, TOKEN: "tok" } });
    base = await new Promise((resolve, reject) => {
      let out = "";
      proc.stdout?.on("data", (d) => {
        out += d;
        const line = out.split("\n").find((l) => l.startsWith("{"));
        if (line) resolve(JSON.parse(line));
      });
      proc.on("exit", (c) => reject(new Error(`fixture exited ${c}`)));
      setTimeout(() => reject(new Error("fixture did not start")), 15_000);
    });
  }, 20_000);
  afterAll(() => {
    proc?.kill();
  });

  const open = (headers: Record<string, string> = { authorization: "Bearer tok" }) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${base.port}/ahp`, { headers } as never);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("upgrade refused"));
    });
  const frames = (ws: WebSocket) => {
    const got: Any[] = [];
    ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
    return got;
  };
  const until = async (f: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end && !f(); ) await new Promise((r) => setTimeout(r, 10));
    expect(f()).toBe(true);
  };

  it("refuses an upgrade without the login and takes one with it", async () => {
    await expect(open({})).rejects.toThrow(/refused/);
    await expect(open({ authorization: "Bearer wrong" })).rejects.toThrow(/refused/);
    const ws = await open();
    ws.close();
  });

  it("speaks AHP: initialize, subscribe, a turn, ordered actions", async () => {
    const ws = await open({ cookie: "i_inc=tok" });
    const got = frames(ws);
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          channel: "ahp-root://",
          protocolVersions: ["1.0.0"],
          clientId: "e2e",
          initialSubscriptions: ["ahp-root://", base.chat],
        },
      }),
    );
    await until(() => got.some((f) => f.id === 1));
    expect(got[0].result.protocolVersion).toBe("1.0.0");
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "dispatchAction",
        params: {
          channel: base.chat,
          clientSeq: 1,
          action: {
            type: "chat/turnStarted",
            turnId: "t1",
            startedAt: new Date().toISOString(),
            message: { text: "hi", origin: { kind: "user" } },
          },
        },
      }),
    );
    await until(() => got.some((f) => f.params?.action?.type === "chat/turnComplete"));
    const seqs = got.filter((f) => f.method === "action").map((f) => f.params.serverSeq);
    expect(seqs.length).toBeGreaterThan(2);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    ws.close();
  });

  describe("a socket opened with a browser session", () => {
    const control = (path: string) => fetch(`http://127.0.0.1:${base.port}${path}`);
    const session = async () => ((await (await control("/__session")).json()) as { token: string }).token;
    const init = (ws: WebSocket, id: number) =>
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            channel: "ahp-root://",
            protocolVersions: ["1.0.0"],
            clientId: `s${id}`,
            initialSubscriptions: ["ahp-root://", base.chat],
          },
        }),
      );
    const closing = (ws: WebSocket) => {
      const out = { code: 0, closed: false };
      ws.onclose = (e) => {
        out.code = e.code;
        out.closed = true;
      };
      return out;
    };

    it("is closed when the session is signed out, and answers nothing after", async () => {
      const token = await session();
      const ws = await open({ cookie: `i_inc=${token}` });
      const got = frames(ws);
      const state = closing(ws);
      init(ws, 1);
      await until(() => got.some((f) => f.id === 1));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "listSessions", params: {} }));
      await until(() => got.some((f) => f.id === 2));
      await control(`/__revoke?token=${token}`);
      await until(() => state.closed);
      expect(state.code).toBe(1008);
      // nothing reaches the host from a closed socket: no more frames come back
      const n = got.length;
      await new Promise((r) => setTimeout(r, 300));
      expect(got.length).toBe(n);
      // and the revoked cookie can't open another
      await expect(open({ cookie: `i_inc=${token}` })).rejects.toThrow(/refused/);
    });

    it("is closed when the session expires", async () => {
      const token = await session();
      const ws = await open({ cookie: `i_inc=${token}` });
      const state = closing(ws);
      init(ws, 1);
      await new Promise((r) => setTimeout(r, 100));
      await control(`/__advance?ms=${31 * 24 * 3600_000}`);
      await until(() => state.closed, 4000); // the keepalive tick (0.3 s) sweeps
      expect(state.code).toBe(1008);
    });

    it("leaves other sessions and bearer-token sockets alone", async () => {
      const a = await session();
      const b = await session();
      const wsA = await open({ cookie: `i_inc=${a}` });
      const wsB = await open({ cookie: `i_inc=${b}` });
      const wsTok = await open({ authorization: "Bearer tok" });
      const stateB = closing(wsB);
      const stateTok = closing(wsTok);
      await control(`/__revoke?token=${a}`);
      await new Promise((r) => setTimeout(r, 400));
      expect(stateB.closed).toBe(false);
      expect(stateTok.closed).toBe(false);
      wsB.close();
      wsTok.close();
    });
  });

  it("closes a connection that sends a frame over the limit", async () => {
    const ws = await open();
    const closed = new Promise<number>((r) => {
      ws.onclose = (e) => r(e.code);
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(200_000) } }));
    // Bun cuts the socket without reading the frame: the client sees 1009, or 1006 when no close frame got out.
    expect([1009, 1006]).toContain(await closed);
  });

  it("keeps a quiet connection open past the socket's idle timeout, with the server's pings", async () => {
    const ws = await open();
    const got = frames(ws);
    let closed = false;
    ws.onclose = () => {
      closed = true;
    };
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { channel: "ahp-root://", protocolVersions: ["1.0.0"], clientId: "idle" },
      }),
    );
    await until(() => got.some((f) => f.id === 1));
    await new Promise((r) => setTimeout(r, 2800)); // idle timeout is 1 s, pings every 0.3 s
    expect(closed).toBe(false);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: { channel: "ahp-root://" } }));
    await until(() => got.some((f) => f.id === 2));
    ws.close();
  });
});
