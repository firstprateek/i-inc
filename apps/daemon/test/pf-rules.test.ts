// tools/m1/pf/i-inc-machines.pf, checked two ways: `pfctl -n` parses it when pfctl is there (macOS),
// and a small evaluator for the rules' syntax runs packets through it with pf's semantics (the last
// matching rule wins, unless it is `quick`, which ends the search), so what a home machine can and
// can't reach is a test rather than a reading of the file.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const file = resolve(import.meta.dirname, "../../../tools/m1/pf/i-inc-machines.pf");
const source = readFileSync(file, "utf8");

interface Rule {
  action: "pass" | "block";
  dir: "in" | "out";
  quick: boolean;
  iface?: string;
  af?: "inet" | "inet6";
  proto?: string[];
  from: string[];
  fromPort?: string[];
  to: string[];
  toPort?: string[];
  text: string;
}
interface Packet {
  dir: "in" | "out";
  iface: string;
  proto: "tcp" | "udp" | "icmp";
  src: string;
  sport?: number;
  dst: string;
  dport?: number;
}

function parse(text: string): { rules: Rule[]; tables: Map<string, string[]> } {
  const macros = new Map<string, string>();
  const tables = new Map<string, string[]>();
  const rules: Rule[] = [];
  const lines = text
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
  const expand = (s: string) => s.replace(/\$(\w+)/g, (_, n) => macros.get(n) ?? `$${n}`);
  const list = (s: string): string[] => {
    const m = /^\{(.*)\}$/.exec(s.trim());
    return (m ? (m[1] ?? "").split(",") : [s]).map((x) => x.trim()).filter(Boolean);
  };
  for (const raw of lines) {
    const macro = /^(\w+)\s*=\s*"(.*)"$/.exec(raw);
    if (macro) {
      macros.set(macro[1] as string, macro[2] as string);
      continue;
    }
    const line = expand(raw);
    const table = /^table\s+<(\w+)>\s*(?:const|persist)?\s*(?:\{(.*)\}|file\s+"(.*)")?$/.exec(line);
    if (table) {
      tables.set(table[1] as string, table[2] ? list(`{${table[2]}}`) : []);
      continue;
    }
    // pass|block [return] in|out [log] [quick] [on IF] [inet|inet6] [proto P] [from A [port N]] [to B [port N]]
    const t = line.replace(/\{[^}]*\}/g, (m) => m.replace(/\s+/g, "")).split(/\s+/);
    const at = (w: string) => t.indexOf(w);
    const action = t[0] as "pass" | "block";
    if (action !== "pass" && action !== "block") throw new Error(`can't read: ${raw}`);
    const rule: Rule = {
      action,
      dir: t.includes("in") ? "in" : "out",
      quick: t.includes("quick"),
      from: ["any"],
      to: ["any"],
      text: raw,
    };
    if (at("on") >= 0) rule.iface = t[at("on") + 1] as string;
    if (t.includes("inet")) rule.af = "inet";
    if (t.includes("inet6")) rule.af = "inet6";
    if (at("proto") >= 0) rule.proto = list(t[at("proto") + 1] as string);
    const fromAt = at("from");
    const toAt = at("to");
    if (t.includes("all")) {
      // everything: the defaults stand
    } else {
      if (fromAt >= 0) {
        rule.from = list(t[fromAt + 1] as string);
        if (t[fromAt + 2] === "port") rule.fromPort = list(t[fromAt + 3] as string);
      }
      if (toAt >= 0) {
        rule.to = list(t[toAt + 1] as string);
        if (t[toAt + 2] === "port") rule.toPort = list(t[toAt + 3] as string);
      }
    }
    rules.push(rule);
  }
  return { rules, tables };
}

const ip = (a: string) => a.split(".").reduce((n, o) => n * 256 + Number(o), 0);
function inCidr(addr: string, cidr: string): boolean {
  const [net, bits] = cidr.split("/");
  const mask = bits === undefined ? 32 : Number(bits);
  const size = 2 ** (32 - mask);
  return Math.floor(ip(addr) / size) === Math.floor(ip(net as string) / size);
}

function evaluate(
  p: { rules: Rule[]; tables: Map<string, string[]> },
  pkt: Packet,
  tables: Record<string, string[]> = {},
): { action: "pass" | "block"; rule?: string } {
  const members = (name: string) => tables[name] ?? p.tables.get(name) ?? [];
  const addr = (specs: string[], a: string): boolean =>
    specs.some((s) => {
      if (s === "any") return true;
      if (s === "self") return false; // the host's own addresses: none of the test packets name one
      const tbl = /^<(\w+)>$/.exec(s);
      if (tbl) return members(tbl[1] as string).some((c) => inCidr(a, c));
      return inCidr(a, s);
    });
  const port = (specs: string[] | undefined, n: number | undefined) =>
    !specs || (n !== undefined && specs.includes(String(n)));
  let verdict: { action: "pass" | "block"; rule?: string } = { action: "pass" };
  for (const r of p.rules) {
    if (r.dir !== pkt.dir) continue;
    if (r.iface && r.iface !== pkt.iface) continue;
    if (r.af && r.af !== "inet") continue;
    if (r.proto && !r.proto.includes(pkt.proto)) continue;
    if (!addr(r.from, pkt.src) || !addr(r.to, pkt.dst)) continue;
    if (!port(r.fromPort, pkt.sport) || !port(r.toPort, pkt.dport)) continue;
    verdict = { action: r.action, rule: r.text };
    if (r.quick) break;
  }
  return verdict;
}

const rules = parse(source);
const gateway = "192.168.64.1";
// The engineers' machine is declared (in the table); the PA's sandbox is not. Another address is what a
// machine that took one for itself would have.
const engineer = "192.168.64.8";
const pa = "192.168.64.5";
const spoofed = "192.168.64.200";
const inbound = (
  src: string,
  proto: Packet["proto"],
  dst: string,
  dport?: number,
  sport = 40000,
): Packet => ({
  dir: "in",
  iface: "bridge100",
  proto,
  src,
  sport,
  dst,
  ...(dport !== undefined ? { dport } : {}),
});
const open = { open_machines: [engineer] };
const verdict = (pkt: Packet, tables: Record<string, string[]> = open) => evaluate(rules, pkt, tables).action;

describe("the machines' pf rules", () => {
  it("parse with pfctl -n, when pfctl is there", () => {
    const dir = mkdtempSync(join(tmpdir(), "i-inc-pf-"));
    try {
      writeFileSync(join(dir, "open.table"), "");
      const copy = join(dir, "rules.pf");
      writeFileSync(copy, source.replace("/var/run/i-inc-open-machines.table", join(dir, "open.table")));
      const r = spawnSync("pfctl", ["-a", "com.apple/010.i-inc-machines", "-n", "-f", copy], {
        encoding: "utf8",
      });
      if (r.error || /permission denied|operation not permitted/i.test(r.stderr)) return; // no pfctl here
      expect(r.stderr.replace(/pfctl: Use of -f[\s\S]*?further details\.\s*/, "")).toBe("");
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the open machines from the table walls.sh writes", () => {
    expect(source).toContain('table <open_machines> persist file "/var/run/i-inc-open-machines.table"');
    expect(readFileSync(resolve(import.meta.dirname, "../../../tools/host/walls.sh"), "utf8")).toContain(
      "i-inc-open-machines.table",
    );
  });

  describe("a machine in the open table (an engineer's)", () => {
    it("has the internet, DNS and Ollama on the gateway", () => {
      expect(verdict(inbound(engineer, "tcp", "93.184.216.34", 443))).toBe("pass");
      expect(verdict(inbound(engineer, "udp", gateway, 53))).toBe("pass");
      expect(verdict(inbound(engineer, "tcp", gateway, 11434))).toBe("pass");
      expect(verdict(inbound("0.0.0.0", "udp", "255.255.255.255", 67, 68))).toBe("pass");
    });
    it("still reaches nothing on the LAN, the tailnet, the host or other machines", () => {
      for (const [dst, dport] of [
        ["192.168.1.50", 443],
        ["100.100.100.100", 22],
        [gateway, 22],
        [gateway, 7420],
        [pa, 22],
        ["169.254.169.254", 80],
      ] as const) {
        expect(verdict(inbound(engineer, "tcp", dst, dport)), `${dst}:${dport}`).toBe("block");
      }
    });
  });

  describe("any other address (a PA's sandbox, an unknown machine, a made-up address)", () => {
    for (const [who, addr] of [
      ["a PA's sandbox", pa],
      ["a machine that gave itself an address", spoofed],
    ] as const) {
      it(`${who} reaches Ollama on the gateway, and takes DHCP`, () => {
        expect(verdict(inbound(addr, "tcp", gateway, 11434))).toBe("pass");
        expect(verdict(inbound("0.0.0.0", "udp", "255.255.255.255", 67, 68))).toBe("pass");
        expect(verdict(inbound(addr, "udp", gateway, 67, 68))).toBe("pass");
      });

      it(`${who} gets no internet, to any address or port`, () => {
        for (const dst of ["1.1.1.1", "93.184.216.34", "8.8.8.8", "140.82.112.3"]) {
          for (const dport of [443, 80, 22, 53, 11434]) {
            expect(verdict(inbound(addr, "tcp", dst, dport)), `${dst}:${dport}`).toBe("block");
          }
        }
        expect(verdict(inbound(addr, "udp", "8.8.8.8", 53))).toBe("block");
        expect(verdict(inbound(addr, "udp", "8.8.8.8", 443))).toBe("block");
        expect(verdict(inbound(addr, "icmp", "8.8.8.8"))).toBe("block");
      });

      it(`${who} gets no DNS, not even from the gateway (a lookup can carry data out)`, () => {
        expect(verdict(inbound(addr, "udp", gateway, 53))).toBe("block");
        expect(verdict(inbound(addr, "tcp", gateway, 53))).toBe("block");
      });

      it(`${who} reaches nothing else on the host, the LAN, the tailnet or other machines`, () => {
        for (const [dst, dport] of [
          [gateway, 22],
          [gateway, 5000],
          [gateway, 7420],
          [gateway, 11435],
          ["192.168.1.1", 53],
          ["100.100.100.100", 22],
          ["169.254.169.254", 80],
          [engineer, 22],
          ["10.0.0.1", 443],
          ["127.0.0.1", 11434],
        ] as const) {
          expect(verdict(inbound(addr, "tcp", dst, dport)), `${dst}:${dport}`).toBe("block");
        }
      });
    }

    it("accepts nothing from outside: only DHCP answers go out to it", () => {
      const out = (
        src: string,
        proto: Packet["proto"],
        dst: string,
        dport: number,
        sport: number,
      ): Packet => ({
        dir: "out",
        iface: "bridge100",
        proto,
        src,
        sport,
        dst,
        dport,
      });
      expect(verdict(out(gateway, "udp", pa, 68, 67))).toBe("pass");
      expect(verdict(out(gateway, "tcp", pa, 22, 50000))).toBe("block");
      expect(verdict(out("1.1.1.1", "tcp", pa, 40000, 443))).toBe("block");
      expect(verdict(out(engineer, "tcp", pa, 22, 50000))).toBe("block");
    });
  });

  it("is closed when the table is empty: no machine gets the internet until one is declared", () => {
    for (const addr of [engineer, pa]) {
      expect(verdict(inbound(addr, "tcp", "93.184.216.34", 443), { open_machines: [] })).toBe("block");
      expect(verdict(inbound(addr, "udp", gateway, 53), { open_machines: [] })).toBe("block");
      expect(verdict(inbound(addr, "tcp", gateway, 11434), { open_machines: [] })).toBe("pass");
    }
  });

  it("lets nothing out except through a rule that names the table", () => {
    for (const r of rules.rules) {
      if (r.dir !== "in" || r.action !== "pass") continue;
      const reachesBeyondGateway = !r.to.every((t) => t === gateway || t === "255.255.255.255");
      if (reachesBeyondGateway && r.af !== "inet6") expect(r.from, r.text).toEqual(["<open_machines>"]);
    }
    // And the Ollama rule is the only one for the whole subnet, to the gateway alone.
    const subnetWide = rules.rules.filter((r) => r.action === "pass" && r.from.includes("192.168.64.0/24"));
    expect(subnetWide.map((r) => [r.to, r.toPort])).toEqual([[[gateway], ["11434"]]]);
  });
});
