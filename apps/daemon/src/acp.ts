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
import {
  type Agent,
  type Duty,
  type Engine,
  type Id,
  type SessionOutcome,
  type SessionRequest,
  type SessionTranscriptItem,
  ShuttingDown,
  type Ticket,
} from "@i-inc/core";
import { StartupError } from "@i-inc/core";
import { describeMs, guardStdin } from "./proc.ts";
import type { Reap } from "./reaper.ts";
import type { AccountRateLimit } from "./registry.ts";
import { capText, safeReason } from "./sessions.ts";
import { defaultTimeoutsMs, type TimeoutsMs } from "./timeouts.ts";

type Json = Record<string, unknown>;

/** The ACP server's stdio, however it was started. */
export interface AgentProcess {
  /** The launch's token in the sandbox (reaper.ts); the fakes in tests have none. */
  agentId?: string;
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

/**
 * Starts an agent in a machine. It answers at once for an ordinary machine, and as a promise when the walls
 * have to be looked at first (machines.ts, machineLaunch).
 */
export type Launch = (r: LaunchRequest) => AgentProcess | Promise<AgentProcess>;

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
    employeeId: Id,
  ) => Record<string, string> | Promise<Record<string, string>>;
  /** Where a ticket's worktree lives in the machine. */
  cwdFor: (ticketId: Id) => string;
  onUsage?: (u: UsageReport) => void;
  onRateLimit?: (accountId: Id, limit: AccountRateLimit) => void;
  now?: () => number;
  log?: (msg: string) => void;
  /** Stops an agent an earlier daemon left running in the sandbox, before each launch (reaper.ts). */
  reap?: Reap;
  /** How long a cancelled session gets to wind down before it's killed. */
  cancelGraceMs?: number;
  /** When an engine's limits show only as errors (Antigravity), how long to wait before trying again. */
  unknownResetMs?: number;
  /** The limits in timeouts.ts as the owner has them now, read at each session (milliseconds). */
  timeouts?: () => Partial<TimeoutsMs>;
  /** How long a ticket waits before a launch that failed is tried again. */
  launchRetryMs?: number;
}

/** The error code of a request the client gave up on (the JSON-RPC server-error range). */
export const ACP_TIMED_OUT = -32098;

export function extractRateLimit(rl: Record<string, unknown>, now = Date.now()): AccountRateLimit {
  const windows = (rl.unifiedWindows ?? {}) as Record<string, Record<string, unknown>>;
  const fiveHour = windows.five_hour ?? windows.fiveHour;
  const sevenDay = windows.seven_day ?? windows.sevenDay;
  const fiveHourUtilization = fiveHour?.utilization !== undefined ? Number(fiveHour.utilization) : undefined;
  const sevenDayUtilization = sevenDay?.utilization !== undefined ? Number(sevenDay.utilization) : undefined;
  const resetsAt = toMs(rl.resetsAt) ?? (fiveHour ? toMs(fiveHour.resetsAt) : null) ?? undefined;
  return {
    ...(rl.status ? { status: String(rl.status) } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(fiveHourUtilization !== undefined ? { fiveHourUtilization } : {}),
    ...(sevenDayUtilization !== undefined ? { sevenDayUtilization } : {}),
    updatedAt: now,
  };
}

export const bypassMode = /bypass|yolo|allow.?all|full.?access|dangerous/i;
// Claude Code says "You've hit your session limit · resets 3:30am (UTC)" (seen on the mini).
export const limitError =
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
  /** The runner records a session as started when `onLaunched` is called, not before the launch. */
  readonly reportsLaunch = true;
  /** Transient errors in a row, per employee and ticket. */
  private readonly transient = new Map<string, number>();

  /** Sessions in progress, for `shutdown`. */
  private readonly open = new Map<Rpc, Id>();
  private shuttingDown = false;

  constructor(private readonly o: AcpOptions) {}

  /**
   * The daemon is going down: close every session's stdin, kill what is still there after `graceMs`,
   * (the caller then sweeps the sandboxes for any agent that ignored both: reaper.ts). A ticket whose session
   * ends this way is picked up again by the scheduler when the daemon returns.
   */
  async shutdown(graceMs = 2500): Promise<void> {
    this.shuttingDown = true;
    const rpcs = [...this.open.entries()];
    for (const [rpc] of rpcs) rpc.close(graceMs);
    await Promise.race([
      Promise.all(rpcs.map(([rpc]) => rpc.waitExit())),
      new Promise<void>((r) => setTimeout(r, graceMs + 200).unref?.()),
    ]);
    for (const [rpc] of rpcs) rpc.kill();
  }

  /** Entries in the transient-retry counter: it should be empty once nothing is retrying. */
  footprint(): { transient: number } {
    return { transient: this.transient.size };
  }

  /**
   * Runs a session to the end of its step. While the daemon is stopping it throws `ShuttingDown`
   * instead of any outcome: the agent's end (its stdin closed, then killed) is the daemon's doing, not the
   * ticket's, so nothing about it may reach the log as a stuck, switched or failed ticket. The ticket
   * stays running and the scheduler resumes it when the daemon returns.
   */
  async run(r: SessionRequest): Promise<SessionOutcome> {
    if (this.shuttingDown) throw new ShuttingDown();
    const outcome = await this.session(r);
    if (this.shuttingDown) throw new ShuttingDown();
    return outcome;
  }

  private async session(r: SessionRequest): Promise<SessionOutcome> {
    const now = this.o.now ?? Date.now;
    const cwd = this.o.cwdFor(r.ticket.id);
    const limits = { ...defaultTimeoutsMs, ...this.o.timeouts?.() };
    let proc: AgentProcess;
    try {
      const env = await this.o.credentials(r.engine, r.ticket, r.duty, r.employee.id);
      // An agent a dead daemon left on this ticket would work in the same folder as the new one.
      await this.o.reap?.(r.employee.id, { cwd });
      proc = await this.o.launch({ employeeId: r.employee.id, engine: r.engine, cwd, env });
    } catch (err) {
      // Whatever stops a launch (the walls are down, GitHub won't give a token, no such launcher) is
      // the daemon's to wait out, not a reason to throw from the tick again every 30 seconds with
      // another session-started each time: the ticket waits, and the daemon backs off.
      if (err instanceof StartupError) throw err;
      throw new StartupError(
        `couldn't start ${r.engine.harness} for ${r.employee.name}: ${upstreamReason(err)}`,
        now() + (this.o.launchRetryMs ?? 60_000),
      );
    }
    const rpc = new Rpc(proc, this.o.log);
    this.open.set(rpc, r.employee.id);
    let limit: { rejected: boolean; resetsAt: number | null; fromMeta?: boolean } = {
      rejected: false,
      resetsAt: null,
    };
    // The outcome is the final answer: the last stretch of text between tool calls that has any.
    // Earlier stretches are the agent narrating its work ("Now I'm writing the report…"), which
    // leaked into a PR body; a trailing tool call after the answer mustn't erase it.
    let reply = "";
    let answer = "";
    let textBuf = "";
    let textId = 0;
    let currentTextId = "";
    let textAt = now();
    let liveConfigOptions: Json[] = [];
    let retrying = false;

    const emit = (item: SessionTranscriptItem) => {
      r.onTranscriptItem?.(item);
    };

    let lastEmitAt = 0;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    const flushText = () => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (!currentTextId || !textBuf) {
        textBuf = "";
        currentTextId = "";
        return;
      }
      emit({ id: currentTextId, kind: "text", text: capText(textBuf, 4096), at: textAt });
      lastEmitAt = now();
      textBuf = "";
      currentTextId = "";
    };

    const emitCurrent = () => {
      if (!currentTextId || !textBuf) return;
      emit({ id: currentTextId, kind: "text", text: textBuf, at: textAt });
      lastEmitAt = now();
    };

    const appendText = (chunk: string) => {
      if (!chunk) return;
      if (!currentTextId) {
        currentTextId = `text-${++textId}`;
        textAt = now();
        textBuf = "";
      }
      let full = textBuf + chunk;
      while (Buffer.byteLength(full, "utf8") >= 4096) {
        const itemText = capText(full, 4096);
        emit({ id: currentTextId, kind: "text", text: itemText, at: textAt });
        lastEmitAt = now();
        full = full.slice(itemText.length);
        currentTextId = `text-${++textId}`;
        textAt = now();
      }
      textBuf = full;
      if (textBuf.length > 0) {
        const currentTime = now();
        if (currentTime - lastEmitAt >= 250) {
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
          }
          emitCurrent();
        } else if (!pendingTimer) {
          pendingTimer = setTimeout(
            () => {
              pendingTimer = null;
              emitCurrent();
            },
            250 - (currentTime - lastEmitAt),
          );
          pendingTimer.unref?.();
        }
      }
    };

    rpc.onNotice = (method, params) => {
      if (method !== "session/update") return;
      const u = (params.update ?? {}) as Json;
      if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) {
        liveConfigOptions = u.configOptions as Json[];
      }
      if (u.sessionUpdate === "tool_call") {
        if (reply.trim()) answer = reply;
        reply = "";
        flushText();
        const toolCallId = u.toolCallId ? String(u.toolCallId) : `tool-${Date.now()}-${Math.random()}`;
        const title = typeof u.title === "string" ? capText(u.title, 4096) : undefined;
        const status = typeof u.status === "string" ? capText(u.status, 4096) : undefined;
        const locations = locationPaths(u.locations);
        emit({
          id: toolCallId,
          kind: "tool",
          ...(title !== undefined ? { title } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(locations.length ? { locations } : {}),
          at: now(),
        });
      }
      if (u.sessionUpdate === "tool_call_update") {
        const toolCallId = u.toolCallId ? String(u.toolCallId) : undefined;
        const title = typeof u.title === "string" ? capText(u.title, 4096) : undefined;
        const status = typeof u.status === "string" ? capText(u.status, 4096) : undefined;
        if (toolCallId) {
          const locations = locationPaths(u.locations);
          emit({
            id: toolCallId,
            kind: "tool",
            ...(title !== undefined ? { title } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(locations.length ? { locations } : {}),
            at: now(),
          });
        }
      }
      if (u.sessionUpdate === "agent_message_chunk") {
        const c = u.content as Json | undefined;
        if (c?.type === "text" && typeof c.text === "string") {
          reply += c.text;
          appendText(c.text);
        }
      }
      const rl = ((u._meta ?? {}) as Json)["_claude/rateLimit"] as Json | undefined;
      if (rl) {
        const report = usageReport(r.engine.accountId, rl);
        limit = { rejected: report.status === "rejected", resetsAt: report.resetsAt, fromMeta: true };
        this.o.onUsage?.(report);
        this.o.onRateLimit?.(r.engine.accountId, extractRateLimit(rl, now()));
      }
    };

    try {
      await r.onLaunched?.();
      const init = await rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "i.inc", version: "0.1.0" },
        },
        { timeoutMs: limits.agentStartMs },
      );
      if (init.error) {
        if (timedOut(init)) rpc.kill();
        return stuck(`the ${r.engine.harness} ACP server didn't start: ${upstreamReason(init.error)}`, true);
      }

      const created = await rpc.request(
        "session/new",
        { cwd: this.o.cwdFor(r.ticket.id), mcpServers: [] },
        { timeoutMs: limits.agentStartMs },
      );
      if (created.error && timedOut(created)) {
        rpc.kill();
        return stuck(`${r.engine.harness} couldn't open a session: ${upstreamReason(created.error)}`, true);
      }
      if (created.error) {
        const e = created.error as Json;
        // "Authentication required": sign-ins need the owner (spec §5), so the switch rules take over.
        if (e.code === -32000)
          return stuck(`${r.engine.harness} needs a sign-in in ${r.employee.name}'s machine`, true);
        return stuck(`${r.engine.harness} couldn't open a session: ${upstreamReason(e)}`, true);
      }
      const session = (created.result ?? {}) as Json;
      const sessionId = String(session.sessionId);
      liveConfigOptions = Array.isArray(session.configOptions) ? (session.configOptions as Json[]) : [];
      if (r.engine.harness === "codex") {
        const select = async (
          category: string,
          ids: string[],
          label: string,
          desired: (choices: { value: string; name: string }[]) => string | undefined,
        ) => {
          const config = liveConfigOptions.find(
            (option) =>
              ids.includes(String(option.id ?? option.configId ?? "")) || option.category === category,
          );
          if (!config) throw new Error(`Codex ACP didn't offer a ${label} option`);
          const value = desired(configChoices(config));
          if (!value) throw new Error(`Codex ACP doesn't offer the configured ${label}`);
          if (config.currentValue === value) return;
          const changed = await rpc.request(
            "session/set_config_option",
            { sessionId, configId: String(config.id ?? config.configId), value },
            { timeoutMs: limits.agentStartMs },
          );
          if (changed.error)
            throw new Error(`Codex ACP couldn't select ${label}: ${upstreamReason(changed.error)}`);
          const result = (changed.result ?? {}) as Json;
          if (Array.isArray(result.configOptions)) liveConfigOptions = result.configOptions as Json[];
        };

        try {
          // Model selection can change which reasoning levels the server advertises, so choose it first.
          await select(
            "model",
            ["model"],
            `model ${r.engine.model}`,
            (choices) =>
              choices.find(
                (choice) =>
                  choice.value === r.engine.model ||
                  choice.name.toLowerCase() === r.engine.model.toLowerCase(),
              )?.value,
          );
          await select(
            "thought_level",
            ["reasoning_effort"],
            `${r.ticket.effort} reasoning effort`,
            (choices) => choices.find((choice) => choice.value === r.ticket.effort)?.value,
          );
          await select(
            "mode",
            ["mode"],
            "full-access machine mode",
            (choices) => choices.find((choice) => bypassMode.test(choice.value))?.value,
          );
        } catch (e) {
          return stuck(e instanceof Error ? e.message : String(e), true);
        }
      } else {
        const modes = (((session.modes as Json | undefined)?.availableModes ?? []) as Json[]).map((m) =>
          String(m.id),
        );
        const bypass = modes.find((m) => bypassMode.test(m));
        if (bypass) {
          await rpc.request(
            "session/set_mode",
            { sessionId, modeId: bypass },
            { timeoutMs: limits.agentStartMs },
          );
        }
      }

      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        rpc.notify("session/cancel", { sessionId });
        setTimeout(() => proc.kill(), this.o.cancelGraceMs ?? 10_000).unref?.();
      };
      if (r.signal?.aborted) onAbort();
      else r.signal?.addEventListener("abort", onAbort, { once: true });

      // No limit on how long the work takes, only on how long the agent can say nothing at all.
      const done = await rpc.request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: r.brief }] },
        { timeoutMs: limits.agentIdleMs, idle: true },
      );
      r.signal?.removeEventListener("abort", onAbort);
      if (timedOut(done) && !cancelled) {
        // A frozen agent: stop it, and let the switch rules treat the session as stuck.
        rpc.notify("session/cancel", { sessionId });
        rpc.kill();
        return stuck(`the agent said nothing for ${describeMs(limits.agentIdleMs)} and was stopped`);
      }

      const reason = String(r.signal?.reason ?? "the owner sent an urgent message");
      if (cancelled) return { kind: "interrupted", reason };
      if (done.error) {
        const text = message(done.error);
        if (limit.rejected || limitError.test(text)) {
          const resetsAt =
            limit.resetsAt ?? resetFromText(text, now()) ?? now() + (this.o.unknownResetMs ?? 3_600_000);
          if (!limit.fromMeta && r.engine.accountId) {
            this.o.onRateLimit?.(r.engine.accountId, {
              status: "rejected",
              resetsAt,
              updatedAt: now(),
            });
          }
          return {
            kind: "out-of-tokens",
            resetsAt,
          };
        }
        // Claude Code says so when a hiccup should pass, such as a sign-in refresh clashing with
        // another: try again shortly, rather than failing the ticket.
        const key = `${r.employee.id}/${r.ticket.id}`;
        if (/usually transient|retry in a minute/i.test(text)) {
          const count = (this.transient.get(key) ?? 0) + 1;
          this.transient.set(key, count);
          if (count <= maxTransient) {
            retrying = true;
            return { kind: "out-of-tokens", resetsAt: now() + 120_000 };
          }
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
      const msg = e instanceof Error ? e.message : String(e);
      const isStartup =
        /didn't start|needs a sign-in|exited \(\d+\)|couldn't open a session|Authentication required/i.test(
          msg,
        );
      return stuck(msg, isStartup);
    } finally {
      // The count only matters between one retry and the next; a ticket that stops (it was
      // interrupted, ran out of tokens, or never comes back) must not leave an entry behind.
      if (!retrying) this.transient.delete(`${r.employee.id}/${r.ticket.id}`);
      flushText();
      this.open.delete(rpc);
      rpc.close();
    }
  }
}

/** The file paths in a tool call's ACP `locations` (at most 20, each cut to 500 characters). */
export function locationPaths(locations: unknown): string[] {
  if (!Array.isArray(locations)) return [];
  return locations
    .map((l) => (l && typeof l === "object" ? (l as Json).path : undefined))
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .slice(0, 20)
    .map((p) => p.slice(0, 500));
}

const timedOut = (m: Json): boolean => (m.error as Json | undefined)?.code === ACP_TIMED_OUT;

function stuck(reason: string, startup?: boolean): SessionOutcome {
  // What the server or the agent said goes into the ticket's log and the API: redacted and cut.
  return { kind: "stuck", reason: safeReason(reason), ...(startup ? { startup: true } : {}) };
}

function message(e: unknown): string {
  const m = (e as Json | undefined)?.message;
  return typeof m === "string" ? m : JSON.stringify(e);
}

/**
 * An upstream ACP server's error text, made fit for a stuck reason the owner reads: control characters
 * become spaces, anything that looks like a token or credential is redacted, and it stops at 200
 * characters. Redacting comes before cutting, so a token can't survive by being split at the limit.
 */
export function upstreamReason(e: unknown): string {
  const text = message(e)
    .replace(/\p{Cc}/gu, " ")
    .replace(/(ghp_|ghs_|sk-|Bearer )\S+/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** Select options can be nested by an ACP peer to group related choices. */
export function configChoices(config: Json): { value: string; name: string }[] {
  const choices: { value: string; name: string }[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const item = value as Json;
    if (typeof item.value === "string") {
      choices.push({
        value: item.value,
        name: typeof item.name === "string" ? item.name : item.value,
      });
    }
    for (const key of ["options", "children"]) {
      if (Array.isArray(item[key])) for (const child of item[key] as unknown[]) visit(child);
    }
  };
  visit(config);
  return choices;
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

export function usageReport(accountId: Id, rl: Json): UsageReport {
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
  /** Writing to the agent's stdin failed (it has gone): nothing more is written. */
  private broken = false;
  /** When the agent last sent anything, for the idle limit. */
  private activity = Date.now();

  constructor(
    private readonly p: AgentProcess,
    private readonly log?: (msg: string) => void,
  ) {
    createInterface({ input: p.stdout }).on("line", (line) => this.receive(line));
    createInterface({ input: p.stderr }).on("line", (line) => {
      // Sign-in links and crashes show here; tokens don't (credentials go in by environment).
      if (/error|https:\/\//i.test(line)) this.log?.(`acp stderr: ${safeReason(line, 300)}`);
    });
    // A write after the agent has exited is EPIPE, which with no listener ends the daemon.
    guardStdin(p.stdin, (err) => {
      this.broken = true;
      this.failPending(`the agent stopped listening (${err.message})`);
    });
    void p.exited.then((code) => {
      this.exited = true;
      this.failPending(`the agent exited (${code ?? "killed"}) mid-session`, true);
    });
  }

  private failPending(message: string, exited = false): void {
    for (const resolve of [...this.pending.values()]) {
      resolve({ error: { code: exited ? -32099 : -32097, message } });
    }
    this.pending.clear();
  }

  private write(m: Json): void {
    if (this.exited || this.broken) return;
    try {
      this.p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    } catch {
      // The stream was already destroyed: same as a broken pipe.
      this.broken = true;
    }
  }

  /**
   * Sends a request. With `timeoutMs` the answer is given up on after that long (an error with code
   * ACP_TIMED_OUT); with `idle` the time counts from the agent's last word, not from the request.
   */
  request(method: string, params: Json, o: { timeoutMs?: number; idle?: boolean } = {}): Promise<Json> {
    if (this.exited) return Promise.resolve({ error: { code: -32099, message: "the agent has exited" } });
    if (this.broken)
      return Promise.resolve({ error: { code: -32097, message: "the agent stopped listening" } });
    const id = this.next++;
    // Listen before writing: a reply can arrive before write() returns.
    const reply = new Promise<Json>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      const limit = o.timeoutMs;
      if (limit === undefined) return;
      const arm = (ms: number) => {
        timer = setTimeout(() => {
          const quiet = Date.now() - this.activity;
          if (o.idle && quiet < limit) return arm(limit - quiet);
          this.pending.delete(id);
          resolve({
            error: {
              code: ACP_TIMED_OUT,
              message: `no word from the agent for ${describeMs(limit)} (${method})`,
            },
          });
        }, ms);
        timer.unref?.();
      };
      arm(limit);
    });
    this.write({ id, method, params });
    return reply;
  }

  notify(method: string, params: Json): void {
    this.write({ method, params });
  }

  private receive(line: string): void {
    this.activity = Date.now();
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

  close(graceMs = 3000): void {
    try {
      this.p.stdin.end();
    } catch {}
    setTimeout(() => this.p.kill(), graceMs).unref?.();
  }

  kill(): void {
    try {
      this.p.kill();
    } catch {}
  }

  waitExit(): Promise<void> {
    return this.exited ? Promise.resolve() : this.p.exited.then(() => {});
  }
}
