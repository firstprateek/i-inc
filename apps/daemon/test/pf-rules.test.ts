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
const home = "192.168.64.5";
const engineer = "192.168.64.8";
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
const homeTable = { home_machines: [home] };
const verdict = (pkt: Packet, tables: Record<string, string[]> = homeTable) =>
  evaluate(rules, pkt, tables).action;

describe("the machines' pf rules", () => {
  it("parse with pfctl -n, when pfctl is there", () => {
    const dir = mkdtempSync(join(tmpdir(), "i-inc-pf-"));
    try {
      writeFileSync(join(dir, "home.table"), "");
      const copy = join(dir, "rules.pf");
      writeFileSync(copy, source.replace("/var/run/i-inc-home-machines.table", join(dir, "home.table")));
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

  it("reads the home machines from the table walls.sh writes", () => {
    expect(source).toContain('table <home_machines> persist file "/var/run/i-inc-home-machines.table"');
    expect(readFileSync(resolve(import.meta.dirname, "../../../tools/host/walls.sh"), "utf8")).toContain(
      "i-inc-home-machines.table",
    );
  });

  describe("a home machine", () => {
    it("reaches Ollama on the gateway, and takes DHCP", () => {
      expect(verdict(inbound(home, "tcp", gateway, 11434))).toBe("pass");
      expect(verdict(inbound("0.0.0.0", "udp", "255.255.255.255", 67, 68))).toBe("pass");
      expect(verdict(inbound(home, "udp", gateway, 67, 68))).toBe("pass");
    });

    it("gets no internet, to any address or port", () => {
      for (const dst of ["1.1.1.1", "93.184.216.34", "8.8.8.8", "140.82.112.3"]) {
        for (const dport of [443, 80, 22, 53, 11434]) {
          expect(verdict(inbound(home, "tcp", dst, dport)), `${dst}:${dport}`).toBe("block");
        }
      }
      expect(verdict(inbound(home, "udp", "8.8.8.8", 53))).toBe("block");
      expect(verdict(inbound(home, "udp", "8.8.8.8", 443))).toBe("block");
      expect(verdict(inbound(home, "icmp", "8.8.8.8"))).toBe("block");
    });

    it("gets no DNS, not even from the gateway (a lookup can carry data out)", () => {
      expect(verdict(inbound(home, "udp", gateway, 53))).toBe("block");
      expect(verdict(inbound(home, "tcp", gateway, 53))).toBe("block");
    });

    it("reaches nothing else on the host, the LAN, the tailnet or other machines", () => {
      for (const [dst, dport] of [
        [gateway, 22],
        [gateway, 5000],
        [gateway, 7420],
        [gateway, 11435],
        ["192.168.1.1", 53],
        ["192.168.1.50", 443],
        ["100.100.100.100", 22],
        ["169.254.169.254", 80],
        [engineer, 22],
        ["10.0.0.1", 443],
        ["127.0.0.1", 11434],
      ] as const) {
        expect(verdict(inbound(home, "tcp", dst, dport)), `${dst}:${dport}`).toBe("block");
      }
    });

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
      expect(verdict(out(gateway, "udp", home, 68, 67))).toBe("pass");
      expect(verdict(out(gateway, "tcp", home, 22, 50000))).toBe("block");
      expect(verdict(out("1.1.1.1", "tcp", home, 40000, 443))).toBe("block");
      expect(verdict(out(engineer, "tcp", home, 22, 50000))).toBe("block");
    });
  });

  describe("an engineer's machine, as before", () => {
    it("has the internet, DNS and Ollama on the gateway", () => {
      expect(verdict(inbound(engineer, "tcp", "93.184.216.34", 443))).toBe("pass");
      expect(verdict(inbound(engineer, "udp", gateway, 53))).toBe("pass");
      expect(verdict(inbound(engineer, "tcp", gateway, 11434))).toBe("pass");
    });
    it("still reaches nothing on the LAN, the tailnet, the host or a home machine", () => {
      expect(verdict(inbound(engineer, "tcp", "192.168.1.50", 443))).toBe("block");
      expect(verdict(inbound(engineer, "tcp", "100.100.100.100", 22))).toBe("block");
      expect(verdict(inbound(engineer, "tcp", gateway, 22))).toBe("block");
      expect(verdict(inbound(engineer, "tcp", home, 22))).toBe("block");
    });
  });

  it("walls off only the addresses in the table: this is why the daemon checks the acknowledgement", () => {
    // The same address with an empty table is just a machine with the internet.
    expect(verdict(inbound(home, "tcp", "93.184.216.34", 443), { home_machines: [] })).toBe("pass");
    expect(verdict(inbound(home, "tcp", "93.184.216.34", 443), { home_machines: ["192.168.64.6"] })).toBe(
      "pass",
    );
  });

  it("puts the home rules ahead of every rule that could let a home machine out", () => {
    const first = rules.rules.findIndex((r) => r.from.includes("<home_machines>") && r.action === "block");
    expect(first).toBeGreaterThan(-1);
    const wide = rules.rules.findIndex(
      (r) => r.action === "pass" && r.to.includes("any") && r.proto === undefined,
    );
    expect(first).toBeLessThan(wide);
    const dns = rules.rules.findIndex((r) => r.toPort?.includes("53"));
    expect(first).toBeLessThan(dns);
    expect(rules.rules[first]?.quick).toBe(true);
    // And every pass for the home table is quick, so a later rule can't override it.
    for (const r of rules.rules) if (r.from.includes("<home_machines>")) expect(r.quick).toBe(true);
  });
});
