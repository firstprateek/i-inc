// The real Agent port: one ACP session per stage, spoken over the stdio of the harness's ACP server
// inside the employee's machine (spec §5; confirmed in M1, docs/m1-findings.md step 5).
//
// For each session it sends initialize, session/new in the ticket's worktree, switches to the
// harness's bypass mode, and sends the brief as the prompt. Inside the machine everything is allowed,
// so every permission request is approved; nothing on the host is offered (no fs, no terminal). It
// reads Claude's rate-limit info from usage updates, and stops the session when the owner sends an
// urgent message.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Agent, Duty, Engine, Id, SessionOutcome, SessionRequest, Ticket } from "@i-inc/core";

type Json = Record<string, unknown>;

/** The ACP server's stdio, however it was started. */
export interface AgentProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number | null>;
}

export interface LaunchRequest {
  employeeId: Id;
  engine: Engine;
  /** The session's working directory in the machine. */
  cwd: string;
  /** The account's credential, e.g. CLAUDE_CODE_OAUTH_TOKEN. Never written anywhere. */
  env: Record<string, string>;
}

export type Launch = (r: LaunchRequest) => AgentProcess;

/** What Claude's adapter reports about an account's windows (`_meta["_claude/rateLimit"]`). */
export interface UsageReport {
  accountId: Id;
  status: string;
  resetsAt: number | null;
  windows: { name: string; utilization: number; resetsAt: number | null }[];
}

export interface AcpOptions {
  launch: Launch;
  /** The environment carrying an engine's credential, and the ticket's GitHub token, into its session. */
  credentials: (
    engine: Engine,
    ticket: Ticket,
    duty: Duty,
  ) => Record<string, string> | Promise<Record<string, string>>;
  /** Where a ticket's worktree lives in the machine. */
  cwdFor: (ticketId: Id) => string;
  onUsage?: (u: UsageReport) => void;
  now?: () => number;
  log?: (msg: string) => void;
  /** How long a cancelled session gets to wind down before it's killed. */
  cancelGraceMs?: number;
  /** When an engine's limits show only as errors (Antigravity), how long to wait before trying again. */
  unknownResetMs?: number;
}

const bypassMode = /bypass|yolo|allow.?all|full.?access|dangerous/i;
// Claude Code says "You've hit your session limit · resets 3:30am (UTC)" (seen on the mini).
const limitError =
  /rate.?limit|usage limit|session limit|weekly limit|hit your .{0,20}limit|(?<!disk )quota|resource.?exhausted|\b429\b|too many requests|limit reached/i;

/** Transient errors in a row for one ticket before it counts as stuck. */
const maxTransient = 3;

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When a limit message says it resets ("resets 3:30am (UTC)", "resets Oct 3, 9pm (UTC)"), the time
 * it names, as the next such moment after `now`. Machines run on UTC, so a time without a zone is
 * UTC too. Null when the message names no time.
 */
export function resetFromText(text: string, now: number): number | null {
  // Machines run on UTC; a time in any other zone isn't read, and the caller falls back.
  const zone = /\(([^)]+)\)/.exec(text.slice(text.search(/resets/i)))?.[1];
  if (zone && !/^(utc|gmt|etc\/utc)$/i.test(zone.trim())) return null;
  const m =
    /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(
      text,
    );
  if (!m) return null;
  const [, mon, day, hour = "0", minute = "0", half = "am"] = m;
  const h = (Number(hour) % 12) + (half.toLowerCase() === "pm" ? 12 : 0);
  const d = new Date(now);
  const month = mon ? months.indexOf(mon.toLowerCase()) : -1;
  if (mon && month < 0) return null;
  let at = Date.UTC(
    d.getUTCFullYear(),
    month >= 0 ? month : d.getUTCMonth(),
    day ? Number(day) : d.getUTCDate(),
    h,
    Number(minute),
  );
  // Just past means the reset is due now (a retry right at it): try again in a few minutes. Further
  // past, a time without a date is the next one, and a date is next year's.
  if (at <= now && now - at < 3_600_000) return now + 5 * 60_000;
  while (at <= now)
    at = month >= 0 ? new Date(at).setUTCFullYear(new Date(at).getUTCFullYear() + 1) : at + 86_400_000;
  return at;
}

export class AcpAgent implements Agent {
  /** Transient errors in a row, per employee and ticket. */
  private readonly transient = new Map<string, number>();

  constructor(private readonly o: AcpOptions) {}

  async run(r: SessionRequest): Promise<SessionOutcome> {
    const now = this.o.now ?? Date.now;
    const proc = this.o.launch({
      employeeId: r.employee.id,
      engine: r.engine,
      cwd: this.o.cwdFor(r.ticket.id),
      env: await this.o.credentials(r.engine, r.ticket, r.duty),
    });
    const rpc = new Rpc(proc, this.o.log);
    let limit: { rejected: boolean; resetsAt: number | null } = { rejected: false, resetsAt: null };
    // The outcome is the final answer: the last stretch of text between tool calls that has any.
    // Earlier stretches are the agent narrating its work ("Now I'm writing the report…"), which
    // leaked into a PR body; a trailing tool call after the answer mustn't erase it.
    let reply = "";
    let answer = "";

    rpc.onNotice = (method, params) => {
      if (method !== "session/update") return;
      const u = (params.update ?? {}) as Json;
      if (u.sessionUpdate === "tool_call") {
        if (reply.trim()) answer = reply;
        reply = "";
      }
      if (u.sessionUpdate === "agent_message_chunk") {
        const c = u.content as Json | undefined;
        if (c?.type === "text") reply += String(c.text);
      }
      const rl = ((u._meta ?? {}) as Json)["_claude/rateLimit"] as Json | undefined;
      if (rl) {
        const report = usageReport(r.engine.accountId, rl);
        limit = { rejected: report.status === "rejected", resetsAt: report.resetsAt };
        this.o.onUsage?.(report);
      }
    };

    try {
      const init = await rpc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "i.inc", version: "0.1.0" },
      });
      if (init.error) return stuck(`the ${r.engine.harness} ACP server didn't start: ${message(init.error)}`);

      const created = await rpc.request("session/new", { cwd: this.o.cwdFor(r.ticket.id), mcpServers: [] });
      if (created.error) {
        const e = created.error as Json;
        // "Authentication required": sign-ins need the owner (spec §5), so the switch rules take over.
        if (e.code === -32000)
          return stuck(`${r.engine.harness} needs a sign-in in ${r.employee.name}'s machine`);
        return stuck(`${r.engine.harness} couldn't open a session: ${message(e)}`);
      }
      const session = (created.result ?? {}) as Json;
      const sessionId = String(session.sessionId);
      const modes = (((session.modes as Json | undefined)?.availableModes ?? []) as Json[]).map((m) =>
        String(m.id),
      );
      const bypass = modes.find((m) => bypassMode.test(m));
      if (bypass) await rpc.request("session/set_mode", { sessionId, modeId: bypass });

      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        rpc.notify("session/cancel", { sessionId });
        setTimeout(() => proc.kill(), this.o.cancelGraceMs ?? 10_000).unref?.();
      };
      if (r.signal?.aborted) onAbort();
      else r.signal?.addEventListener("abort", onAbort, { once: true });

      const done = await rpc.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: r.brief }],
      });
      r.signal?.removeEventListener("abort", onAbort);

      const reason = String(r.signal?.reason ?? "the owner sent an urgent message");
      if (cancelled) return { kind: "interrupted", reason };
      if (done.error) {
        const text = message(done.error);
        if (limit.rejected || limitError.test(text)) {
          return {
            kind: "out-of-tokens",
            resetsAt:
              limit.resetsAt ?? resetFromText(text, now()) ?? now() + (this.o.unknownResetMs ?? 3_600_000),
          };
        }
        // Claude Code says so when a hiccup should pass, such as a sign-in refresh clashing with
        // another: try again shortly, rather than failing the ticket.
        const key = `${r.employee.id}/${r.ticket.id}`;
        if (/usually transient|retry in a minute/i.test(text)) {
          const count = (this.transient.get(key) ?? 0) + 1;
          this.transient.set(key, count);
          if (count <= maxTransient) return { kind: "out-of-tokens", resetsAt: now() + 120_000 };
        }
        this.transient.delete(key);
        return stuck(text);
      }
      const stop = String(((done.result ?? {}) as Json).stopReason ?? "end_turn");
      if (stop === "cancelled") return { kind: "interrupted", reason };
      if (limit.rejected) return { kind: "out-of-tokens", resetsAt: limit.resetsAt ?? now() + 3_600_000 };
      if (stop !== "end_turn") return stuck(`the session stopped early (${stop})`);
      this.transient.delete(`${r.employee.id}/${r.ticket.id}`);
      const output = (reply.trim() ? reply : answer).trim();
      if (!output) return stuck("the session ended without an answer");
      return { kind: "done", output };
    } catch (e) {
      return stuck(e instanceof Error ? e.message : String(e));
    } finally {
      rpc.close();
    }
  }
}

function stuck(reason: string): SessionOutcome {
  return { kind: "stuck", reason };
}

function message(e: unknown): string {
  const m = (e as Json | undefined)?.message;
  return typeof m === "string" ? m : JSON.stringify(e);
}

/** Epoch seconds or milliseconds, or an ISO string, as milliseconds. */
function toMs(v: unknown): number | null {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function usageReport(accountId: Id, rl: Json): UsageReport {
  const windows = Object.entries((rl.unifiedWindows ?? {}) as Record<string, Json>).map(([name, w]) => ({
    name,
    utilization: Number(w.utilization ?? 0),
    resetsAt: toMs(w.resetsAt),
  }));
  return { accountId, status: String(rl.status ?? "allowed"), resetsAt: toMs(rl.resetsAt), windows };
}

/** JSON-RPC 2.0 over newline-delimited stdio, the way ACP servers speak it. */
class Rpc {
  private next = 1;
  private readonly pending = new Map<number, (m: Json) => void>();
  onNotice: (method: string, params: Json) => void = () => {};
  private exited = false;

  constructor(
    private readonly p: AgentProcess,
    private readonly log?: (msg: string) => void,
  ) {
    createInterface({ input: p.stdout }).on("line", (line) => this.receive(line));
    createInterface({ input: p.stderr }).on("line", (line) => {
      // Sign-in links and crashes show here; tokens don't (credentials go in by environment).
      if (/error|https:\/\//i.test(line)) this.log?.(`acp stderr: ${line.slice(0, 300)}`);
    });
    void p.exited.then((code) => {
      this.exited = true;
      for (const resolve of this.pending.values()) {
        resolve({ error: { code: -32099, message: `the agent exited (${code ?? "killed"}) mid-session` } });
      }
      this.pending.clear();
    });
  }

  private write(m: Json): void {
    if (!this.exited) this.p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  }

  request(method: string, params: Json): Promise<Json> {
    if (this.exited) return Promise.resolve({ error: { code: -32099, message: "the agent has exited" } });
    const id = this.next++;
    // Listen before writing: a reply can arrive before write() returns.
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
      m = JSON.parse(line) as Json;
    } catch {
      return;
    }
    const id = m.id as number | string | undefined;
    if (id !== undefined && ("result" in m || "error" in m) && !("method" in m)) {
      const resolve = this.pending.get(id as number);
      this.pending.delete(id as number);
      resolve?.(m);
      return;
    }
    const method = String(m.method ?? "");
    const params = (m.params ?? {}) as Json;
    if (id === undefined) {
      this.onNotice(method, params);
    } else if (method === "session/request_permission") {
      // Lenient inside the machine (spec §5): approve, preferring "always".
      const options = (params.options ?? []) as Json[];
      const pick =
        options.find((o) => o.kind === "allow_always") ??
        options.find((o) => o.kind === "allow_once") ??
        options[0];
      this.write({ id, result: { outcome: { outcome: "selected", optionId: pick?.optionId } } });
    } else {
      // Walled outside it: nothing on the host is offered.
      this.write({ id, error: { code: -32601, message: `not offered: ${method}` } });
    }
  }

  close(): void {
    try {
      this.p.stdin.end();
    } catch {}
    setTimeout(() => this.p.kill(), 3000).unref?.();
  }
}
