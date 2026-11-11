// The shared AHP socket is the daemon answering too (hub.ts): its opening, and any frame on it, call off a
// doubt about the REST API (connection.ts), so a dropped REST request doesn't end in "Can't reach i.inc"
// while a conversation is plainly talking. They don't end an outage the probes confirmed.
import { InMemoryTransport } from "@microsoft/agent-host-protocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAhp, useAhp } from "../../src/ahp/hub.ts";
import { isDoubted, isOffline, report, suspect } from "../../src/connection.ts";
import { hosts, SESSION, tick, until } from "./fake-host.ts";

const connect = vi.hoisted(() => ({
  fn: (() => Promise.reject(new Error("unset"))) as () => Promise<unknown>,
}));
vi.mock("@microsoft/agent-host-protocol/ws", () => ({
  WebSocketTransport: { connect: () => connect.fn() },
}));

/** The REST API is in doubt: every health probe hangs, so only something else can call it off. */
function doubt(): void {
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  suspect();
  expect(isDoubted()).toBe(true);
}

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
  resetAhp();
  report(true);
  vi.unstubAllGlobals();
});

describe("the shared AHP socket and the daemon's reachability", () => {
  it("calls off a doubt when the socket opens, even before the host says anything", async () => {
    let opened = false;
    connect.fn = async () => {
      opened = true;
      return InMemoryTransport.pair()[0]; // the other end never answers
    };
    doubt();
    release = useAhp();
    await until(() => opened);
    await tick();
    expect(isDoubted()).toBe(false);
  });

  it("calls off a doubt when a frame arrives on an open socket", async () => {
    const h = hosts();
    connect.fn = h.connect;
    release = useAhp();
    await until(() => h.made.length > 0);
    await tick(20);
    doubt();
    h.made[0]?.send(SESSION, { type: "session/titleChanged", title: "Still here" });
    await until(() => !isDoubted());
    expect(isDoubted()).toBe(false);
  });

  it("doesn't end an outage the probes confirmed: only an answer over HTTP does", async () => {
    const h = hosts();
    connect.fn = h.connect;
    release = useAhp();
    await until(() => h.made.length > 0);
    await tick(20);
    report(false); // the REST API is away, though the socket still talks
    expect(isOffline()).toBe(true);
    h.made[0]?.send(SESSION, { type: "session/titleChanged", title: "Still here" });
    await tick(20);
    expect(isOffline()).toBe(true);
  });
});
