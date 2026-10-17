// Tests for sandbox DNS filter.
import { describe, expect, it, vi } from "vitest";
import {
  handleDnsQuery,
  isBlockedSandboxDomain,
  makeDnsRefusedResponse,
  parseDnsQuestionName,
} from "../src/dns.ts";

function buildDnsQuery(domain: string, txId = 0x1234): Uint8Array {
  const labels = domain.split(".").filter(Boolean);
  const qnameBytes: number[] = [];
  for (const label of labels) {
    qnameBytes.push(label.length);
    for (let i = 0; i < label.length; i++) {
      qnameBytes.push(label.charCodeAt(i));
    }
  }
  qnameBytes.push(0); // terminating zero
  // QTYPE: A (1), QCLASS: IN (1)
  qnameBytes.push(0, 1, 0, 1);

  const packet = new Uint8Array(12 + qnameBytes.length);
  // Transaction ID
  packet[0] = (txId >> 8) & 0xff;
  packet[1] = txId & 0xff;
  // Flags: standard query, RD=1
  packet[2] = 0x01;
  packet[3] = 0x00;
  // QDCOUNT = 1
  packet[4] = 0x00;
  packet[5] = 0x01;

  packet.set(qnameBytes, 12);
  return packet;
}

describe("parseDnsQuestionName", () => {
  it("parses valid domain names from query packets", () => {
    const q1 = buildDnsQuery("github.com");
    expect(parseDnsQuestionName(q1)).toBe("github.com");

    const q2 = buildDnsQuery("prateeks-mini.local");
    expect(parseDnsQuestionName(q2)).toBe("prateeks-mini.local");

    const q3 = buildDnsQuery("node.tailnet123.ts.net");
    expect(parseDnsQuestionName(q3)).toBe("node.tailnet123.ts.net");
  });

  it("returns null for malformed or non-question packets", () => {
    // Too short
    expect(parseDnsQuestionName(new Uint8Array(8))).toBeNull();

    // QDCOUNT = 0
    const emptyQuery = new Uint8Array(12);
    expect(parseDnsQuestionName(emptyQuery)).toBeNull();

    // Incomplete label length extending past packet
    const broken = new Uint8Array([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 10, 65, 66]);
    expect(parseDnsQuestionName(broken)).toBeNull();
  });
});

describe("isBlockedSandboxDomain", () => {
  it("blocks .ts.net domains and subdomains case-insensitively", () => {
    expect(isBlockedSandboxDomain("ts.net")).toBe(true);
    expect(isBlockedSandboxDomain("my-host.ts.net")).toBe(true);
    expect(isBlockedSandboxDomain("SUB.HOST.TS.NET")).toBe(true);
    expect(isBlockedSandboxDomain("host.ts.net.")).toBe(true);

    expect(isBlockedSandboxDomain("ts.network")).toBe(false);
    expect(isBlockedSandboxDomain("ts.net.example.com")).toBe(false);
  });

  it("blocks .local domains case-insensitively", () => {
    expect(isBlockedSandboxDomain("local")).toBe(true);
    expect(isBlockedSandboxDomain("prateeks-mac-mini.local")).toBe(true);
    expect(isBlockedSandboxDomain("PRINTER.LOCAL")).toBe(true);
    expect(isBlockedSandboxDomain("device.local.")).toBe(true);

    expect(isBlockedSandboxDomain("localhost")).toBe(false);
    expect(isBlockedSandboxDomain("localdomain.org")).toBe(false);
  });

  it("allows standard public domains", () => {
    expect(isBlockedSandboxDomain("github.com")).toBe(false);
    expect(isBlockedSandboxDomain("api.anthropic.com")).toBe(false);
    expect(isBlockedSandboxDomain("registry.npmjs.org")).toBe(false);
  });
});

describe("makeDnsRefusedResponse", () => {
  it("creates a REFUSED DNS response matching the query's ID and question", () => {
    const query = buildDnsQuery("mini.local", 0xabcd);
    const response = makeDnsRefusedResponse(query);

    // Matches transaction ID
    expect(response[0]).toBe(0xab);
    expect(response[1]).toBe(0xcd);

    // QR=1 (response)
    expect((response[2] ?? 0) & 0x80).toBe(0x80);

    // RCODE=5 (REFUSED)
    expect((response[3] ?? 0) & 0x0f).toBe(5);

    // Question section preserved
    expect(parseDnsQuestionName(response)).toBe("mini.local");
  });
});

describe("handleDnsQuery", () => {
  it("immediately returns refused response for blocked domains without forwarding", async () => {
    const query = buildDnsQuery("secret.ts.net", 0x4321);
    const forward = vi.fn();
    const log = vi.fn();

    const response = await handleDnsQuery(query, forward, log);

    expect(forward).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith({ name: "secret.ts.net", blocked: true });
    expect((response[3] ?? 0) & 0x0f).toBe(5); // RCODE 5 REFUSED
  });

  it("forwards queries for allowed domains", async () => {
    const query = buildDnsQuery("github.com", 0x5678);
    const mockAnswer = new Uint8Array([0x56, 0x78, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
    const forward = vi.fn().mockResolvedValue(mockAnswer);
    const log = vi.fn();

    const response = await handleDnsQuery(query, forward, log);

    expect(forward).toHaveBeenCalledWith(query);
    expect(log).toHaveBeenCalledWith({ name: "github.com", blocked: false });
    expect(response).toBe(mockAnswer);
  });
});
