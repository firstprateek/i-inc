// The host's ACP client: one agent process per AHP session, JSON-RPC over newline-delimited stdio.
// Same wire handling as apps/daemon/src/acp.ts (Rpc), but long-lived: notifications and agent->client
// requests (session/request_permission) are routed to callbacks instead of being auto-answered.
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type Json = Record<string, any>;

export class AcpConnection {
  private next = 1;
  private readonly pending = new Map<number, (m: Json) => void>();
  private proc: ChildProcess;
  exited = false;
  onNotification: (method: string, params: Json) => void = () => {};
  /** Agent->client requests. Resolve with the JSON-RPC result. */
  onRequest: (method: string, params: Json) => Promise<unknown> = async (m) => {
    throw new Error(`not offered: ${m}`);
  };

  constructor(cmd: string[], env: Record<string, string> = {}, cwd?: string) {
    // node:child_process works the same on Bun and Node, and gives the Node streams the daemon's AgentProcess uses.
    this.proc = spawn(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env }, cwd });
    createInterface({ input: this.proc.stdout! }).on("line", (l) => this.receive(l));
    createInterface({ input: this.proc.stderr! }).on("line", (l) => console.error(`[acp stderr] ${l}`));
    this.proc.on("exit", (code) => {
      this.exited = true;
      for (const r of this.pending.values()) r({ error: { code: -32099, message: `agent exited (${code})` } });
      this.pending.clear();
    });
  }

  get pid(): number {
    return this.proc.pid ?? -1;
  }

  private write(m: Json): void {
    if (this.exited) return;
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  }

  request(method: string, params: Json): Promise<Json> {
    if (this.exited) return Promise.resolve({ error: { code: -32099, message: "agent has exited" } });
    const id = this.next++;
    const reply = new Promise<Json>((resolve) => this.pending.set(id, resolve));
    this.write({ id, method, params });
    return reply;
  }

  notify(method: string, params: Json): void {
    this.write({ method, params });
  }

  private receive(line: string): void {
    let m: Json;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const r = this.pending.get(m.id);
      this.pending.delete(m.id);
      r?.(m);
      return;
    }
    if (m.id === undefined) return this.onNotification(String(m.method), m.params ?? {});
    void this.onRequest(String(m.method), m.params ?? {}).then(
      (result) => this.write({ id: m.id, result }),
      (e) => this.write({ id: m.id, error: { code: -32601, message: String(e?.message ?? e) } }),
    );
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {}
  }
}
