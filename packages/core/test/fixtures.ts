// The spec's cast, as test data.
import { defaultSwitchRules, type Employee, type Engine, type Ticket } from "../src/index.ts";
import { fakePorts } from "../src/testing/index.ts";

export const engines: Engine[] = [
  { id: "opus", harness: "claude-code", model: "Claude Opus", accountId: "claude-pro", local: false },
  { id: "sonnet", harness: "claude-code", model: "Claude Sonnet", accountId: "claude-pro", local: false },
  { id: "gemini", harness: "gemini-cli", model: "Gemini 3 Pro", accountId: "google-ai-pro", local: false },
  { id: "flash", harness: "gemini-cli", model: "Gemini Flash", accountId: "google-ai-pro", local: false },
  { id: "qwen", harness: "opencode", model: "qwen3", accountId: "local", local: true },
  { id: "qwen-moe", harness: "opencode", model: "qwen3 MoE", accountId: "local", local: true },
];

const engineer = (id: string, name: string, engine: string, fallbacks: string[] = []): Employee => ({
  id,
  name,
  role: "Senior Engineer",
  duties: ["build"],
  engines: { default: engine, fallbacks },
  switchRules: defaultSwitchRules,
});

export const ada = engineer("ada", "Ada", "opus", ["gemini"]);
export const kit = engineer("kit", "Kit", "sonnet", ["gemini"]);
export const grace: Employee = {
  ...engineer("grace", "Grace", "gemini"),
  role: "Staff Engineer",
  duties: ["plan", "review"],
};
export const quinn: Employee = { ...engineer("quinn", "Quinn", "flash"), role: "QA", duties: ["verify"] };
export const pip: Employee = {
  ...engineer("pip", "Pip", "qwen", ["gemini", "qwen-moe"]),
  role: "Personal Assistant",
  duties: ["build"],
};

export const team = [ada, kit, grace, quinn, pip];

export function refundsTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "42",
    title: "Refunds are counted as spending",
    project: "Duet",
    type: "fix",
    effort: "medium",
    doneWhen: ["August drops by the refund", "a test covers it"],
    assignee: "ada",
    ...overrides,
  };
}

/** Fake ports for the team, with any employees in `replace` swapped in by id. */
export const ports = (...replace: Employee[]) =>
  fakePorts(
    team.map((e) => replace.find((r) => r.id === e.id) ?? e),
    engines,
  );
