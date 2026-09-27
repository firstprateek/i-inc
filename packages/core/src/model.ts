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

/** Tickets an employee may pick up by itself (spec §5), e.g. chore tickets labeled deps, 5 a day. */
export interface StandingOrder {
  types?: TicketType[];
  labels?: string[];
  projects?: string[];
  maxPerDay: number;
}

/** Local hours, 0-23. `from` > `to` wraps past midnight: { from: 22, to: 7 } is nights only. */
export interface WorkingHours {
  from: number;
  to: number;
}

export interface Employee {
  id: Id;
  name: string;
  role: string;
  duties: Duty[];
  engines: EmployeeEngines;
  switchRules: SwitchRules;
  /** Projects it may work on; absent means all. */
  projects?: string[];
  standingOrders?: StandingOrder[];
  /** Absent means any time. */
  workingHours?: WorkingHours;
  /** For a PA: how each kind of outgoing action is handled. Absent actions are Ask. */
  outbound?: Partial<Record<OutboundAction, OutboundSetting>>;
}

/** Things a PA can propose that would leave the house in the owner's name (spec §7). */
export type OutboundAction =
  | "send-email"
  | "accept-invite"
  | "calendar-hold"
  | "calendar-invite"
  | "book"
  | "pay"
  | "delete-mail"
  | "forward"
  | "share-file"
  | "account-settings";

export interface OutboundRule {
  /** Only when every recipient is in the owner's contacts. */
  onlyToContacts?: boolean;
  /** Only when nobody else is invited. */
  noInvitees?: boolean;
}

export type OutboundSetting = { mode: "ask" } | { mode: "off" } | { mode: "rule"; rule: OutboundRule };

/** One outgoing action a PA prepared: a draft reply, a calendar change, a booking to make. */
export interface Proposal {
  action: OutboundAction;
  summary: string;
  to?: string[];
  invitesOthers?: boolean;
}

/**
 * One thing an employee learned, proposed at the retro (spec §5, "The brain"). Brain edits and
 * handbook facts apply at once; policy changes wait for the owner.
 */
export interface KnowledgeEdit {
  layer: "brain" | "fact" | "policy";
  page: string;
  text: string;
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
  labels?: string[];
}
