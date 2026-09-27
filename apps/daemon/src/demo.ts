// The spec's cast and a morning's worth of tickets, for demo mode. The scripted agent plays each
// ticket to a different state, so every view has something real to show.
import { defaultSwitchRules, type Employee, type Engine } from "@i-inc/core";
import { type FakeAgent, type FakeHarness, json } from "@i-inc/core/testing";
import type { Registry } from "./registry.ts";
import type { Tickets } from "./tickets.ts";

export function seedDemo(r: Registry): void {
  const engines: Engine[] = [
    { id: "opus", harness: "claude-code", model: "Claude Opus", accountId: "claude-pro", local: false },
    { id: "sonnet", harness: "claude-code", model: "Claude Sonnet", accountId: "claude-pro", local: false },
    { id: "gemini", harness: "gemini-cli", model: "Gemini 3 Pro", accountId: "google-ai-pro", local: false },
    { id: "flash", harness: "gemini-cli", model: "Gemini Flash", accountId: "google-ai-pro", local: false },
    { id: "qwen", harness: "opencode", model: "qwen3", accountId: "local", local: true },
  ];
  for (const e of engines) r.addEngine(e);
  r.addAccount({ id: "claude-pro", name: "Claude Pro", monthlyFee: 20 });
  r.addAccount({ id: "google-ai-pro", name: "Google AI Pro", monthlyFee: 20 });
  r.addAccount({ id: "local", name: "Local" });
  r.addHost({ id: "mini", name: "Mac mini", purchasePrice: 0, idleWatts: 7, busyWatts: 60 });
  r.addContact("dentist@example.com");

  const base = { switchRules: defaultSwitchRules };
  const team: Employee[] = [
    {
      ...base,
      id: "ada",
      name: "Ada",
      role: "Senior Engineer",
      duties: ["build", "review"],
      engines: { default: "opus", fallbacks: ["gemini"] },
    },
    {
      ...base,
      id: "kit",
      name: "Kit",
      role: "Senior Engineer",
      duties: ["build", "review"],
      engines: { default: "sonnet", fallbacks: ["gemini"] },
    },
    {
      ...base,
      id: "grace",
      name: "Grace",
      role: "Staff Engineer",
      duties: ["plan", "review"],
      engines: { default: "gemini", fallbacks: [] },
    },
    {
      ...base,
      id: "quinn",
      name: "Quinn",
      role: "QA",
      duties: ["verify"],
      engines: { default: "flash", fallbacks: [] },
    },
    {
      ...base,
      id: "qwen",
      name: "Qwen",
      role: "Senior Engineer",
      duties: ["build"],
      engines: { default: "qwen", fallbacks: [] },
      standingOrders: [{ types: ["chore"], labels: ["deps"], maxPerDay: 5 }],
    },
    {
      ...base,
      id: "juno",
      name: "Juno",
      role: "UX Designer",
      duties: ["build"],
      engines: { default: "flash", fallbacks: [] },
      workingHours: { from: 22, to: 7 },
    },
    {
      ...base,
      id: "pip",
      name: "Pip",
      role: "Personal Assistant",
      duties: ["build"],
      engines: { default: "qwen", fallbacks: [] },
      outbound: { "send-email": { mode: "rule", rule: { onlyToContacts: true } } },
    },
  ];
  for (const e of team) r.hire(e);
}

/** A morning's tickets, each scripted to land somewhere different. */
export function seedDemoTickets(tickets: Tickets, agent: FakeAgent, harness: FakeHarness, now: number): void {
  const add = (t: Parameters<Tickets["create"]>[0]) => tickets.create(t, now).id;

  add({
    title: "Refunds are counted as spending",
    project: "Duet",
    type: "fix",
    effort: "medium",
    doneWhen: ["August drops by the refund", "a test covers it"],
    assignee: "ada",
  });

  const csv = add({
    title: "CSV import",
    project: "fintrack",
    type: "feat",
    effort: "medium",
    doneWhen: ["a bank CSV imports"],
    assignee: "kit",
  });
  const red = { green: false, failures: ["csv.test.ts: parses 03/04/2026"] };
  harness.checksFor.set(csv, [red, red, red]);

  const alerts = add({
    title: "Budget alerts",
    project: "Duet",
    type: "feat",
    effort: "medium",
    doneWhen: ["an alert fires at 80% of a budget"],
    assignee: "grace",
  });
  agent.on(
    { ticket: alerts, duty: "plan" },
    { kind: "done", output: "Add an alerts table (a schema migration), checked after each sync." },
  );

  const video = add({
    title: "Export video",
    project: "listy",
    type: "feat",
    effort: "medium",
    doneWhen: ["a list exports as a video"],
    assignee: "qwen",
  });
  agent.on(
    { ticket: video, duty: "review" },
    {
      kind: "done",
      output: json({
        approved: false,
        findings: [
          { severity: "blocking", where: "sync/cache.ts:40", text: "the cache goes stale after a sync" },
        ],
      }),
    },
  );
  agent.on(
    { ticket: video, stage: "review", duty: "build" },
    { kind: "done", output: json({ disputed: "the sync already clears it in after.ts" }) },
  );

  add({
    title: "Pricing page copy",
    project: "website",
    type: "feat",
    effort: "low",
    doneWhen: ["the page reads well"],
    assignee: "juno",
  });

  const triage = add({
    title: "Morning triage",
    project: "Home",
    type: "errand",
    effort: "low",
    doneWhen: [],
    assignee: "pip",
  });
  agent.on(
    { ticket: triage, stage: "work" },
    {
      kind: "done",
      output: json({
        proposals: [
          {
            action: "send-email",
            summary: "Reply to the dentist: Thursday 4 pm works",
            to: ["dentist@example.com"],
          },
          { action: "calendar-hold", summary: "Hold Thursday 4 pm for the dentist" },
        ],
      }),
    },
  );
}

/** Tickets added after the first tick, so their builders are free by then. */
export function seedDemoLater(tickets: Tickets, agent: FakeAgent, now: number): void {
  const sync = tickets.create(
    {
      title: "Sync conflicts drop the newest edit",
      project: "Duet",
      type: "fix",
      effort: "medium",
      doneWhen: ["the newest edit wins"],
      assignee: "ada",
    },
    now,
  ).id;
  agent.on({ ticket: sync, stage: "build" }, { kind: "out-of-tokens", resetsAt: now + 72 * 60_000 });
  tickets.create(
    {
      title: "Bump deps",
      project: "fintrack",
      type: "chore",
      effort: "low",
      doneWhen: ["checks green"],
      labels: ["deps"],
    },
    now,
  );
}
