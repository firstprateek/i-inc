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
  /** Absent: both directions. */
  dir?: "in" | "out";
  quick: boolean;
  /** `on IF` or `on { IF, IF }`: pf matches an interface by exactly its name. */
  iface?: string[];
  af?: "inet" | "inet6";
  proto?: string[];
  from: string[];
  fromNot?: boolean;
  fromPort?: string[];
  to: string[];
  toNot?: boolean;
  toPort?: string[];
  noState: boolean;
  text: string;
}
interface Packet {
  dir: "in" | "out";
  iface: string;
  /** Default inet. */
  af?: "inet" | "inet6";
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
      quick: t.includes("quick"),
      from: ["any"],
      to: ["any"],
      noState: t.includes("no") && t[t.indexOf("no") + 1] === "state",
      text: raw,
    };
    if (t.includes("in")) rule.dir = "in";
    if (t.includes("out")) rule.dir = "out";
    if (at("on") >= 0) rule.iface = list(t[at("on") + 1] as string);
    if (t.includes("inet")) rule.af = "inet";
    if (t.includes("inet6")) rule.af = "inet6";
    if (at("proto") >= 0) rule.proto = list(t[at("proto") + 1] as string);
    const fromAt = at("from");
    const toAt = at("to");
    if (t.includes("all")) {
      // everything: the defaults stand
    } else {
      if (fromAt >= 0) {
        const k = fromAt + (t[fromAt + 1] === "!" ? 2 : 1);
        rule.from = list(t[k] as string);
        if (k > fromAt + 1) rule.fromNot = true;
        if (t[k + 1] === "port") rule.fromPort = list(t[k + 2] as string);
      }
      if (toAt >= 0) {
        const k = toAt + (t[toAt + 1] === "!" ? 2 : 1);
        rule.to = list(t[k] as string);
        if (k > toAt + 1) rule.toNot = true;
        if (t[k + 1] === "port") rule.toPort = list(t[k + 2] as string);
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
  // A table is a list of networks, some negated ("!192.168.64.1"): the most specific entry that holds the
  // address decides, as in pf, so 192.168.64.0/24 without 192.168.64.1 is every address but that one.
  const inTable = (entries: string[], a: string): boolean => {
    let best: { bits: number; negated: boolean } | undefined;
    for (const e of entries) {
      const negated = e.startsWith("!");
      const cidr = negated ? e.slice(1) : e;
      if (!inCidr(a, cidr)) continue;
      const bits = cidr.includes("/") ? Number(cidr.split("/")[1]) : 32;
      if (!best || bits > best.bits) best = { bits, negated };
    }
    return best !== undefined && !best.negated;
  };
  const addr = (specs: string[], a: string, not = false): boolean =>
    specs.some((s) => {
      if (s === "any") return true;
      if (s === "self") return false; // the host's own addresses: none of the test packets name one
      const tbl = /^<(\w+)>$/.exec(s);
      if (tbl) return inTable(members(tbl[1] as string), a);
      return inCidr(a, s);
    }) !== not;
  const port = (specs: string[] | undefined, n: number | undefined) =>
    !specs || (n !== undefined && specs.includes(String(n)));
  let verdict: { action: "pass" | "block"; rule?: string } = { action: "pass" };
  for (const r of p.rules) {
    if (r.dir && r.dir !== pkt.dir) continue;
    if (r.iface && !r.iface.includes(pkt.iface)) continue;
    if (r.af && r.af !== (pkt.af ?? "inet")) continue;
    if (r.proto && !r.proto.includes(pkt.proto)) continue;
    // An IPv6 packet has no IPv4 address to compare: only the rules that name no address see it.
    if (pkt.af === "inet6") {
      if (r.from.some((x) => x !== "any") || r.to.some((x) => x !== "any")) continue;
    } else if (!addr(r.from, pkt.src, r.fromNot) || !addr(r.to, pkt.dst, r.toNot)) continue;
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

// Traffic between machines (T70). macOS runs pf on a bridged frame, once the bridge's filter flags ask for
// it (tools/host/bridge-filter.sh), at these hooks only: `in` on the member interface the frame arrives on,
// then `out` on each member it is switched to. A frame for the host goes up to the host's IP stack and meets
// the rules on bridge100 (`in`), as it always did; a frame from the host to a machine leaves bridge100 (`out`)
// and then the machine's member (`out`). Replies to a machine's own connections pass bridge100 on the state
// the connection made there; their packets are walked through the member hooks only (`reply`).
describe("frames between machines", () => {
  const A = "vmenet0";
  const B = "vmenet1";
  const C = "vmenet2";
  const bridge = "bridge100";
  type Hook = { iface: string; dir: "in" | "out" };
  type Frame = Omit<Packet, "dir" | "iface">;
  const frame = (
    src: string,
    proto: Packet["proto"],
    dst: string,
    dport?: number,
    sport = 40000,
    af?: Packet["af"],
  ): Frame => ({ proto, src, sport, dst, ...(dport !== undefined ? { dport } : {}), ...(af ? { af } : {}) });
  const at = (f: Frame, h: Hook, tables = open): "pass" | "block" =>
    evaluate(rules, { ...f, ...h }, tables).action;
  /** Where the frame gets to: each hook it passes, in order, until one drops it. */
  const walk = (f: Frame, hooks: Hook[], tables = open): Hook[] => {
    const got: Hook[] = [];
    for (const h of hooks) {
      if (at(f, h, tables) === "block") break;
      got.push(h);
    }
    return got;
  };
  const delivered = (f: Frame, hooks: Hook[], tables = open): boolean =>
    walk(f, hooks, tables).length === hooks.length;
  const inOn = (iface: string): Hook => ({ iface, dir: "in" });
  const outOn = (iface: string): Hook => ({ iface, dir: "out" });
  /** A machine on A sends to a machine on B. */
  const machineToMachine = [inOn(A), outOn(B)];
  /** A machine on A sends to the host, or to the internet through it. */
  const toHost = [inOn(A), inOn(bridge)];
  /** The host (or a reply through it) sends to the machine on A. */
  const fromHost = [outOn(bridge), outOn(A)];

  const tables = { open_machines: [engineer, "192.168.64.9"] };
  const machinesAt: [string, string][] = [
    ["an engineer's machine", engineer],
    ["a PA's sandbox", pa],
    ["a machine with a made-up address", spoofed],
  ];

  describe("a machine's frame to another machine", () => {
    for (const [from, src] of machinesAt) {
      for (const [to, dst] of machinesAt) {
        if (src === dst) continue;
        it(`${from} to ${to}: TCP, UDP and ping are dropped, whoever may use the internet`, () => {
          for (const f of [
            frame(src, "tcp", dst, 22),
            frame(src, "tcp", dst, 7),
            frame(src, "tcp", dst, 8080),
            frame(src, "udp", dst, 5353),
            frame(src, "udp", dst, 67, 68),
            frame(src, "icmp", dst),
          ]) {
            expect(delivered(f, machineToMachine, tables), JSON.stringify(f)).toBe(false);
            // ...at the first hook, so the frame never leaves the machine's own member
            expect(walk(f, machineToMachine, tables)).toEqual([]);
          }
        });
      }
    }

    it("is dropped by either hook alone: the out hook is not leaning on the in hook", () => {
      const f = frame(engineer, "tcp", pa, 22);
      expect(at(f, inOn(A), tables)).toBe("block");
      expect(at(f, outOn(B), tables)).toBe("block");
    });

    it("is dropped whatever source address it claims", () => {
      for (const src of [gateway, "0.0.0.0", "8.8.8.8", "192.168.1.9", "192.168.64.77", pa, engineer]) {
        expect(at(frame(src, "tcp", pa, 22), inOn(A), tables), src).toBe("block");
        expect(at(frame(src, "udp", engineer, 9), inOn(A), tables), src).toBe("block");
      }
    });

    it("is dropped on its way out of a member when it names another destination (sent to a machine's hardware address)", () => {
      for (const dst of ["8.8.8.8", gateway, "192.168.1.1", "224.0.0.251"]) {
        expect(at(frame(engineer, "tcp", dst, 443), outOn(B), tables), dst).toBe("block");
        expect(at(frame(pa, "udp", dst, 53), outOn(B), tables), dst).toBe("block");
      }
    });

    it("is dropped as a directed broadcast too", () => {
      expect(delivered(frame(pa, "udp", "192.168.64.255", 9999), machineToMachine, tables)).toBe(false);
    });

    it("is dropped on every member, not just the first ones", () => {
      for (let n = 0; n < 32; n++) {
        const f = frame(pa, "tcp", engineer, 22);
        expect(at(f, inOn(`vmenet${n}`), tables), `vmenet${n}`).toBe("block");
        expect(at(frame(pa, "tcp", "8.8.8.8", 22), outOn(`vmenet${n}`), tables), `vmenet${n}`).toBe("block");
      }
    });

    it("leaves a different interface alone: the host's own traffic is not matched by the member rules", () => {
      // en0, lo0, the tailnet: the member rules name vmenet only.
      for (const iface of ["en0", "lo0", "utun4", "bridge0", "awdl0"]) {
        for (const dir of ["in", "out"] as const) {
          expect(at(frame(engineer, "tcp", pa, 22), { iface, dir }, tables), `${dir} on ${iface}`).toBe(
            "pass",
          );
        }
      }
    });
  });

  describe("broadcast and multicast", () => {
    const discover = frame("0.0.0.0", "udp", "255.255.255.255", 67, 68);

    it("a DHCP request reaches the host and no other machine", () => {
      expect(delivered(discover, toHost, tables)).toBe(true);
      expect(walk(discover, [inOn(A), outOn(B)], tables)).toEqual([inOn(A)]);
      expect(walk(discover, [inOn(A), outOn(C)], tables)).toEqual([inOn(A)]);
    });

    it("a machine's own datagram to 255.255.255.255 reaches no other machine, and not the host either", () => {
      const f = frame(pa, "udp", "255.255.255.255", 9999);
      expect(at(f, outOn(B), tables)).toBe("block");
      expect(delivered(f, toHost, tables)).toBe(false);
    });

    it("the host's DHCP answers, to the machine or to everyone, still arrive", () => {
      const unicastOffer = frame(gateway, "udp", engineer, 68, 67);
      const broadcastOffer = frame(gateway, "udp", "255.255.255.255", 68, 67);
      expect(delivered(unicastOffer, fromHost, tables)).toBe(true);
      expect(delivered(broadcastOffer, fromHost, tables)).toBe(true);
      expect(at(broadcastOffer, outOn(B), tables)).toBe("pass");
    });

    it("multicast from a machine reaches no other machine (mDNS, SSDP, IGMP)", () => {
      for (const dst of ["224.0.0.251", "239.255.255.250", "224.0.0.22", "224.0.0.1"]) {
        expect(at(frame(pa, "udp", dst, 5353), outOn(B), tables), dst).toBe("block");
        expect(at(frame(engineer, "udp", dst, 1900), outOn(B), tables), dst).toBe("block");
      }
    });

    it("the host's own multicast still goes out", () => {
      expect(at(frame(gateway, "udp", "224.0.0.251", 5353), outOn(B), tables)).toBe("pass");
    });
  });

  describe("IPv6", () => {
    it("is dropped on every member in both directions: link-local between machines is a path, nothing needs v6", () => {
      for (const proto of ["tcp", "udp", "icmp"] as const) {
        for (const dir of ["in", "out"] as const) {
          const f = frame("fe80::1", proto, "fe80::2", 22, 40000, "inet6");
          expect(at(f, { iface: A, dir }, tables), `${proto} ${dir}`).toBe("block");
        }
      }
    });
  });

  describe("what has to keep working", () => {
    const flows: [string, string][] = [
      ["an engineer's machine", engineer],
      ["a second open machine (the image builder's declared address, an engineer's)", "192.168.64.9"],
    ];
    for (const [who, src] of flows) {
      it(`${who}: the internet, by address or by name, goes through (NAT egress)`, () => {
        for (const [dst, dport] of [
          ["93.184.216.34", 443],
          ["1.1.1.1", 443],
          ["140.82.112.3", 22],
          ["8.8.8.8", 53],
        ] as const) {
          // out through the member, up to the host, which routes it to en0 and translates it
          expect(delivered(frame(src, "tcp", dst, dport), toHost, tables), `${dst}:${dport}`).toBe(true);
          expect(delivered(frame(src, "udp", dst, dport), toHost, tables), `${dst}:${dport} udp`).toBe(true);
        }
        expect(delivered(frame(src, "icmp", "1.1.1.1"), toHost, tables)).toBe(true);
      });

      it(`${who}: the replies from the internet are not matched by the member rules`, () => {
        for (const peer of ["93.184.216.34", "1.1.1.1", "140.82.112.3", "8.8.8.8"]) {
          expect(at(frame(peer, "tcp", src, 40000, 443), outOn(A), tables), peer).toBe("pass");
          expect(at(frame(peer, "udp", src, 40000, 53), outOn(A), tables), peer).toBe("pass");
          expect(at(frame(peer, "icmp", src), outOn(A), tables), peer).toBe("pass");
        }
      });

      it(`${who}: DNS and Ollama on the host, and the answers`, () => {
        expect(delivered(frame(src, "udp", gateway, 53), toHost, tables)).toBe(true);
        expect(delivered(frame(src, "tcp", gateway, 53), toHost, tables)).toBe(true);
        expect(delivered(frame(src, "tcp", gateway, 11434), toHost, tables)).toBe(true);
        expect(at(frame(gateway, "udp", src, 40000, 53), outOn(A), tables)).toBe("pass");
        expect(at(frame(gateway, "tcp", src, 40000, 11434), outOn(A), tables)).toBe("pass");
      });
    }

    it("a PA's sandbox: Ollama and DHCP, as before, and still no internet or DNS", () => {
      expect(delivered(frame(pa, "tcp", gateway, 11434), toHost, tables)).toBe(true);
      expect(delivered(frame("0.0.0.0", "udp", "255.255.255.255", 67, 68), toHost, tables)).toBe(true);
      expect(delivered(frame(pa, "udp", gateway, 67, 68), toHost, tables)).toBe(true);
      expect(delivered(frame(pa, "tcp", "93.184.216.34", 443), toHost, tables)).toBe(false);
      expect(delivered(frame(pa, "udp", gateway, 53), toHost, tables)).toBe(false);
      expect(at(frame(gateway, "tcp", pa, 40000, 11434), outOn(A), tables)).toBe("pass");
    });

    it("the host reaches a machine: ping, a port the host opened, DHCP", () => {
      expect(at(frame(gateway, "icmp", engineer), outOn(A), tables)).toBe("pass");
      expect(at(frame(gateway, "tcp", pa, 22, 51000), outOn(A), tables)).toBe("pass");
      expect(delivered(frame(gateway, "udp", engineer, 68, 67), fromHost, tables)).toBe(true);
    });

    it("the host's rules for what a machine may reach on the host stand as before", () => {
      expect(delivered(frame(engineer, "tcp", gateway, 22), toHost, tables)).toBe(false);
      expect(delivered(frame(pa, "tcp", gateway, 5000), toHost, tables)).toBe(false);
      expect(delivered(frame(engineer, "tcp", "192.168.1.50", 443), toHost, tables)).toBe(false);
      expect(delivered(frame(engineer, "tcp", pa, 22), toHost, tables)).toBe(false); // via the gateway's hardware address
    });
  });

  describe("the member rules' shape", () => {
    const onMembers = rules.rules.filter((r) => r.iface?.[0]?.startsWith("vmenet"));
    it("name vmenet0 to vmenet31 and the same list everywhere, as walls.sh expects", () => {
      const names = Array.from({ length: 32 }, (_, n) => `vmenet${n}`);
      expect(onMembers.length).toBeGreaterThan(0);
      for (const r of onMembers) expect(r.iface, r.text).toEqual(names);
      const walls = readFileSync(resolve(import.meta.dirname, "../../../tools/host/walls.sh"), "utf8");
      expect(walls).toContain("vmenet[0-9] | vmenet[12][0-9] | vmenet3[01])");
    });

    it("are blocks, and one last pass that makes no state (a state made on a member could let a frame past bridge100)", () => {
      const passes = onMembers.filter((r) => r.action === "pass");
      expect(passes).toHaveLength(1);
      expect(passes[0]?.quick).toBe(true);
      expect(passes[0]?.noState).toBe(true);
      expect(onMembers.at(-1)).toBe(passes[0]);
      for (const r of onMembers.filter((x) => x.action === "block")) expect(r.quick, r.text).toBe(true);
    });

    it("come before the rules on bridge100, and the rules on bridge100 are still all there", () => {
      const first = rules.rules.findIndex((r) => r.iface?.[0] === "bridge100");
      const last = rules.rules.findLastIndex((r) => r.iface?.[0]?.startsWith("vmenet"));
      expect(last).toBeLessThan(first);
      const text = rules.rules.filter((r) => r.iface?.[0] === "bridge100").map((r) => r.text);
      expect(text.some((t) => t.includes("from <open_machines> to any"))).toBe(true);
      expect(text.some((t) => t.startsWith("block return in log quick on $machines_if all"))).toBe(true);
    });

    it("the gateway is the only address that is not a peer", () => {
      expect(source).toContain("table <peers> const { 192.168.64.0/24, !192.168.64.1 }");
      expect(at(frame(pa, "tcp", gateway, 22), inOn(A), tables)).toBe("pass"); // the host's rules on bridge100 decide
      for (const last of [0, 2, 3, 100, 254, 255]) {
        expect(at(frame(pa, "tcp", `192.168.64.${last}`, 22), inOn(A), tables), `.${last}`).toBe("block");
      }
    });
  });
});
