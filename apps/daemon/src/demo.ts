// The spec's cast, for demo mode.
import { defaultSwitchRules, type Employee, type Engine } from "@i-inc/core";
import type { Registry } from "./registry.ts";

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
  ];
  for (const e of team) r.hire(e);
}
