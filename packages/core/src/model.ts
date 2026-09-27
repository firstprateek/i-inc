// The company's nouns, as plain data. Words follow docs/spec.md.

export type Id = string;

/** What a stage asks an employee to do (spec §5, "Roles and duties"). */
export type Duty = "plan" | "build" | "verify" | "review";

export type AgentHarness = "claude-code" | "gemini-cli" | "opencode";

/** harness + model + account. Swappable; the employee is its memory, not its engine. */
export interface Engine {
  id: Id;
  harness: AgentHarness;
  model: string;
  accountId: Id;
  /** A local engine may process home data; a cloud one never does. */
  local: boolean;
}

export type AccountKind = "subscription" | "api" | "local";

export interface Account {
  id: Id;
  name: string;
  kind: AccountKind;
}

export type SwitchOnOutOfTokens = { action: "wait" } | { action: "fallback"; afterMinutes: number };

export interface SwitchRules {
  outOfTokens: SwitchOnOutOfTokens;
  /** Failed check runs within a stage before the stuck rule fires. */
  checksFailedBeforeSwitch: number;
  /** When stuck: move to the next fallback engine for the rest of the stage, or escalate. */
  onStuck: "switch" | "escalate";
}

export const defaultSwitchRules: SwitchRules = {
  outOfTokens: { action: "wait" },
  checksFailedBeforeSwitch: 3,
  onStuck: "switch",
};

export interface EmployeeEngines {
  default: Id;
  /** Engine per duty (spec §5). Duties not listed use the default. */
  perDuty?: Partial<Record<Duty, Id>>;
  /** Tried in order by switch rules. */
  fallbacks: Id[];
}

export interface Employee {
  id: Id;
  name: string;
  role: string;
  duties: Duty[];
  engines: EmployeeEngines;
  switchRules: SwitchRules;
}

export type TicketType = "fix" | "feat" | "chore" | "errand";
export type Effort = "low" | "medium" | "high";

export interface Ticket {
  id: Id;
  title: string;
  project: string;
  type: TicketType;
  effort: Effort;
  doneWhen: string[];
  assignee: Id;
}
