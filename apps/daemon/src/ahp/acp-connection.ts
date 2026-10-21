// A long-lived ACP connection to one agent process (newline-delimited JSON-RPC over its stdio).
//
// The ticket path (acp.ts) opens a connection per stage and auto-answers everything. A conversation
// keeps this one open between messages: agent notifications and agent-to-client requests (permission
// prompts) go to callbacks, requests can be timed, and an unexpected exit settles everything waiting.
import { createInterface } from "node:readline";
import type { AgentProcess } from "../acp.ts";
import type { Json } from "./wire.ts";

export interface RpcReply {
  result?: Json;
  error?: { code?: number; message?: string; data?: unknown };
}

export const EXITED = -32099;
export const TIMED_OUT = -32098;

export class AcpConnection {
  private next = 1;
  private readonly pending = new Map<number, (r: RpcReply) => void>();
  exited = false;
  exitCode: number | null | undefined;
  onNotification: (method: string, params: Json) => void = () => {};
  /** Agent-to-client requests. Resolve with the JSON-RPC result, reject to answer with an error. */
  onRequest: (method: string, params: Json) => Promise<unknown> = async (m) => {
    throw new Error(`not offered: ${m}`);
  };
  /** Called once when the process ends, however it ended. */
  onExit: (code: number | null) => void = () => {};

  constructor(
    private readonly proc: AgentProcess,
    private readonly log?: (msg: string) => void,
  ) {
    createInterface({ input: proc.stdout }).on("line", (line) => this.receive(line));
    createInterface({ input: proc.stderr }).on("line", (line) => {
      // Sign-in links and crashes show here; tokens don't (credentials go in by environment).
      if (/error|https:\/\//i.test(line)) this.log?.(`acp stderr: ${line.slice(0, 300)}`);
    });
    // A write to a process that has gone is an EPIPE event, not something to crash the daemon over.
    proc.stdin.on("error", () => {});
    void proc.exited.then((code) => {
      this.exited = true;
      this.exitCode = code;
      for (const resolve of this.pending.values()) {
        resolve({ error: { code: EXITED, message: `the agent exited (${code ?? "killed"})` } });
      }
      this.pending.clear();
      this.onExit(code);
    });
  }

  private write(m: Json): void {
    if (this.exited) return;
    try {
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    } catch {
      // the process is going; its exit settles the pending requests
    }
  }

  /** Sends a request; resolves with the reply (never rejects). `timeoutMs` ends the wait, not the request. */
  request(method: string, params: Json, timeoutMs?: number): Promise<RpcReply> {
    if (this.exited) return Promise.resolve({ error: { code: EXITED, message: "the agent has exited" } });
    const id = this.next++;
    // Listen before writing: a reply can arrive before write() returns.
    const reply = new Promise<RpcReply>((resolve) => this.pending.set(id, resolve));
    this.write({ id, method, params });
    if (timeoutMs === undefined) return reply;
    return new Promise<RpcReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          error: { code: TIMED_OUT, message: `${method} timed out after ${Math.round(timeoutMs / 1000)}s` },
        });
      }, timeoutMs);
      timer.unref?.();
      void reply.then((r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  notify(method: string, params: Json): void {
    this.write({ method, params });
  }

  private receive(line: string): void {
    let m: Json;
    try {
      m = JSON.parse(line) as Json;
    } catch {
      return;
    }
    const id = m.id as number | string | undefined;
    if (id !== undefined && !("method" in m)) {
      const resolve = this.pending.get(id as number);
      this.pending.delete(id as number);
      resolve?.({
        ...(m.result !== undefined ? { result: m.result as Json } : {}),
        ...(m.error !== undefined ? { error: m.error as RpcReply["error"] & object } : {}),
      });
      return;
    }
    const method = String(m.method ?? "");
    const params = (m.params ?? {}) as Json;
    if (id === undefined) {
      try {
        this.onNotification(method, params);
      } catch (e) {
        this.log?.(`acp: handling ${method} failed: ${e instanceof Error ? e.message : e}`);
      }
      return;
    }
    // Walled outside the machine: only what the host registered a handler for is answered.
    void this.onRequest(method, params).then(
      (result) => this.write({ id, result: result ?? null }),
      (e) => this.write({ id, error: { code: -32601, message: e instanceof Error ? e.message : String(e) } }),
    );
  }

  /** Resolves when the process has ended. */
  waitExit(): Promise<void> {
    return this.exited ? Promise.resolve() : this.proc.exited.then(() => {});
  }

  /** Ends the process now. */
  kill(): void {
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }

  /** Closes its stdin and, if it doesn't leave, kills it. */
  close(graceMs = 3000): void {
    try {
      this.proc.stdin.end();
    } catch {
      // already gone
    }
    setTimeout(() => this.kill(), graceMs).unref?.();
  }
}
