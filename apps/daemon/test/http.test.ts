// How the server answers a request (http.ts, main.ts's Bun.serve): the long owner actions get the longest
// wait Bun allows before the API runs, and nothing else does; the idle timeout outlasts the proxy's.
import { describe, expect, it } from "vitest";
import { httpFetch, IDLE_TIMEOUT_SEC } from "../src/http.ts";
import { LONG_REQUEST_SEC } from "../src/long-requests.ts";

function rig(o: { web?: boolean; ahp?: "refuse" | "upgrade" | "fail" } = {}) {
  const log: string[] = [];
  const fetch = httpFetch<{ who: string }>({
    ahp: {
      matches: (req) => new URL(req.url).pathname === "/ahp",
      guard: () =>
        o.ahp === "refuse" ? { refusal: new Response("no", { status: 403 }) } : { data: { who: "owner" } },
    },
    api: (req, { peer }) => {
      log.push(`api ${req.method} ${new URL(req.url).pathname} from ${peer}`);
      return new Response("{}");
    },
    web: () =>
      o.web
        ? (req) => {
            log.push(`web ${new URL(req.url).pathname}`);
            return new Response("<html>");
          }
        : null,
  });
  const server = {
    upgrade: (_req: Request, opts: { data: { who: string } }) => {
      log.push(`upgrade ${opts.data.who}`);
      return o.ahp !== "fail";
    },
    timeout: (req: Request, sec: number) => log.push(`timeout ${new URL(req.url).pathname} ${sec}`),
    requestIP: () => ({ address: "127.0.0.1" }),
  };
  const send = (method: string, path: string) =>
    fetch(new Request(`http://127.0.0.1:7420${path}`, { method }), server);
  return { log, send };
}

describe("the server's request handler", () => {
  it("gives a long owner action the longest wait before the API runs it", async () => {
    const { log, send } = rig({ web: true });
    await send("POST", "/api/conversations/c1/ticket");
    await send("POST", "/api/sandboxes/t1/retry");
    expect(log).toEqual([
      `timeout /api/conversations/c1/ticket ${LONG_REQUEST_SEC}`,
      "api POST /api/conversations/c1/ticket from 127.0.0.1",
      `timeout /api/sandboxes/t1/retry ${LONG_REQUEST_SEC}`,
      "api POST /api/sandboxes/t1/retry from 127.0.0.1",
    ]);
  });

  it("leaves every other request on the server's idle timeout", async () => {
    const { log, send } = rig({ web: true });
    await send("GET", "/api/conversations/c1/ship");
    await send("GET", "/api/board/summary");
    await send("GET", "/work/board");
    expect(log).toEqual([
      "api GET /api/conversations/c1/ship from 127.0.0.1",
      "api GET /api/board/summary from 127.0.0.1",
      "web /work/board",
    ]);
  });

  it("sends every path to the API while there is no web build", async () => {
    const { log, send } = rig();
    await send("GET", "/work/board");
    expect(log).toEqual(["api GET /work/board from 127.0.0.1"]);
  });

  it("upgrades /ahp past its locks, and never sends it to the API", async () => {
    expect(await rig({ ahp: "upgrade" }).send("GET", "/ahp")).toBeUndefined();
    expect((await rig({ ahp: "refuse" }).send("GET", "/ahp"))?.status).toBe(403);
    const failed = rig({ ahp: "fail" });
    expect((await failed.send("GET", "/ahp"))?.status).toBe(400);
    expect(failed.log).toEqual(["upgrade owner"]);
  });

  it("keeps a quiet connection longer than a proxy in front does (Go's 90 s), within Bun's 255", () => {
    expect(IDLE_TIMEOUT_SEC).toBeGreaterThan(90);
    expect(IDLE_TIMEOUT_SEC).toBeLessThanOrEqual(255);
  });
});
