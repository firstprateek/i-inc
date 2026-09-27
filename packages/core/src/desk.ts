// My desk's numbers (spec §10), worked out from the event log and the costs the owner enters.
// The maths is deliberately simple: an estimate you can trust, not a meter.
import type { TicketEvent } from "./events.ts";
import type { Id } from "./model.ts";

export interface AccountCost {
  id: Id;
  name: string;
  /** A subscription's monthly fee. */
  monthlyFee?: number;
  /** An API account's price per million tokens. */
  pricePerMillionTokens?: number;
}

export interface HostCost {
  id: Id;
  name: string;
  purchasePrice: number;
  /** Months to spread the purchase over. Default 36. */
  lifeMonths?: number;
  idleWatts: number;
  busyWatts: number;
}

export interface SpendInputs {
  accounts: AccountCost[];
  hosts: HostCost[];
  /** The owner's electricity price per kWh. */
  pricePerKWh: number;
  /** Hours in the month so far (or the whole month, for a forecast). */
  hoursInPeriod: number;
  tokensByAccount: Record<Id, number>;
  busyHoursByHost: Record<Id, number>;
  mergedPRs: number;
}

export interface SpendLine {
  name: string;
  kind: "subscription" | "api" | "hardware" | "electricity";
  amount: number;
  basis: string;
}

export interface Spend {
  lines: SpendLine[];
  total: number;
  perMergedPR: number | null;
}

const hoursPerMonth = 730;

export function spend(i: SpendInputs): Spend {
  const share = Math.min(1, i.hoursInPeriod / hoursPerMonth);
  const lines: SpendLine[] = [];

  for (const a of i.accounts) {
    if (a.monthlyFee !== undefined) {
      lines.push({ name: a.name, kind: "subscription", amount: a.monthlyFee * share, basis: "monthly fee" });
    }
    const tokens = i.tokensByAccount[a.id] ?? 0;
    if (a.pricePerMillionTokens !== undefined && tokens > 0) {
      lines.push({
        name: a.name,
        kind: "api",
        amount: (tokens / 1_000_000) * a.pricePerMillionTokens,
        basis: `${tokens.toLocaleString("en")} tokens`,
      });
    }
  }

  for (const h of i.hosts) {
    const months = h.lifeMonths ?? 36;
    lines.push({
      name: h.name,
      kind: "hardware",
      amount: (h.purchasePrice / months) * share,
      basis: `price ÷ ${months} months`,
    });
    const busy = Math.min(i.busyHoursByHost[h.id] ?? 0, i.hoursInPeriod);
    const kWh = (h.idleWatts * (i.hoursInPeriod - busy) + h.busyWatts * busy) / 1000;
    lines.push({
      name: h.name,
      kind: "electricity",
      amount: kWh * i.pricePerKWh,
      basis: `${Math.round(kWh)} kWh, ${Math.round(busy)} h busy`,
    });
  }

  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  return { lines, total, perMergedPR: i.mergedPRs > 0 ? total / i.mergedPRs : null };
}

/** Hours each engine spent in sessions: from session-started to the next event on that ticket. */
export function sessionHours(tickets: TicketEvent[][]): Record<Id, number> {
  const hours: Record<Id, number> = {};
  for (const events of tickets) {
    events.forEach((e, n) => {
      const next = events[n + 1];
      if (e.type === "session-started" && next) {
        hours[e.engineId] = (hours[e.engineId] ?? 0) + (next.at - e.at) / 3_600_000;
      }
    });
  }
  return hours;
}

export type WaitReason = "tokens" | "owner-answer" | "owner-decision";

export interface Wait {
  reason: WaitReason;
  hours: number;
  tickets: number;
}

/**
 * Where work waited, across tickets, longest first. The first entry is the bottleneck card:
 * tokens (an empty account), the owner's answers (gates, disagreements, proposals), or the owner's
 * decision on ready work.
 */
export function waits(tickets: TicketEvent[][], now: number): Wait[] {
  const totals = new Map<WaitReason, { hours: number; tickets: Set<number> }>();
  const add = (reason: WaitReason, from: number, to: number, ticket: number) => {
    const t = totals.get(reason) ?? { hours: 0, tickets: new Set<number>() };
    t.hours += (to - from) / 3_600_000;
    t.tickets.add(ticket);
    totals.set(reason, t);
  };

  tickets.forEach((events, ticket) => {
    let tokensSince: number | null = null;
    let askedAt: number | null = null;
    let readyAt: number | null = null;
    for (const e of events) {
      if (e.type === "out-of-tokens") tokensSince = e.at;
      if ((e.type === "session-started" || e.type === "engine-switched") && tokensSince !== null) {
        add("tokens", tokensSince, e.at, ticket);
        tokensSince = null;
      }
      if (e.type === "needs-you") askedAt = e.at;
      if (e.type === "owner-answered" && askedAt !== null) {
        add("owner-answer", askedAt, e.at, ticket);
        askedAt = null;
      }
      if (e.type === "report-ready") readyAt = e.at;
      if (e.type === "owner-decided" && readyAt !== null) {
        add("owner-decision", readyAt, e.at, ticket);
        readyAt = null;
      }
    }
    // Still waiting now.
    if (tokensSince !== null) add("tokens", tokensSince, now, ticket);
    if (askedAt !== null) add("owner-answer", askedAt, now, ticket);
    if (readyAt !== null) add("owner-decision", readyAt, now, ticket);
  });

  return [...totals.entries()]
    .map(([reason, t]) => ({ reason, hours: t.hours, tickets: t.tickets.size }))
    .sort((a, b) => b.hours - a.hours);
}
