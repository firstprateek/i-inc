// The company's nouns, as plain data. Words follow docs/spec.md.

export type Id = string;

/** What a stage asks an employee to do (spec §5, "Roles and duties"). */
export type Duty = "plan" | "build" | "verify" | "review";

export type AgentHarness = "claude-code" | "antigravity" | "opencode" | "codex";

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

export type { AccountCost } from "./desk.ts";

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
  checksFailedBeforeSwitch: 5,
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
  /** Which identity tint the avatar wears, chosen at hiring so no two look alike (see `pickTint`). */
  tint?: number;
  /** Custom role system prompt or instructions defining how the agent acts, reasons, and executes tasks. */
  prompt?: string;
  /** Default effort level for tickets assigned to this employee. */
  effort?: Effort;
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

/** An orientation is a new hire's first ticket: read the handbook and projects, write brain pages. */
export type TicketType = "fix" | "feat" | "chore" | "errand" | "orientation";

/**
 * A code ticket's branch, as pick-up made it (spec §6, stage 1). In owner-merges mode it also has a
 * draft pull request; in direct mode the branch stays local and its work is pushed to main.
 */
export interface PullRequestRef {
  branch: string;
  number?: number;
  url?: string;
  /** GitHub's id for the PR, which marking it ready needs. */
  nodeId?: string;
  /** Something the owner should know about how the branch was opened (a local branch with unpushed commits was backed up). */
  note?: string;
}

/** How a project's work reaches main (decided 2026-10-17). */
export type MergeMode = "direct" | "owner-merges";

export interface ProjectRelease {
  project: Id;
  tag: string;
  at: number;
  ticketIds: Id[];
  commits: string[];
}

export interface ProjectPolicy {
  /**
   * direct: after a fresh-context review (at most 2 rounds) the builder's work is pushed straight
   * to main. owner-merges: a pull request the owner reviews and merges.
   */
  mode: MergeMode;
  /** Paths whose changes wait for the owner's OK before reaching main (prefixes, or exact files). */
  protectedPaths: string[];
  /** Follow-up tickets agents may file for themselves per day. */
  followUpsPerDay: number;
  autoRelease?: boolean;
}

export const defaultProjectPolicy: ProjectPolicy = {
  mode: "direct",
  protectedPaths: [".github/", "release-please-config.json", ".release-please-manifest.json"],
  followUpsPerDay: 3,
  autoRelease: false,
};

/** A ticket an agent proposes for itself, from what it noticed while working. */
export interface FollowUp {
  title: string;
  doneWhen: string[];
  type: "fix" | "feat" | "chore";
  effort: Effort;
  /** Why it's worth doing. */
  reason: string;
}
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
  /** The agent that filed it, for a follow-up; absent when the owner did. */
  createdBy?: Id;
  /** Why it's worth doing, for a follow-up an agent proposed; the brief carries it. */
  reason?: string;
  /** Images the owner attached when filing it; the bytes live in the daemon. */
  attachments?: TicketAttachment[];
}

/** An image on a ticket. `name` is already safe as a file name. */
export interface TicketAttachment {
  n: number;
  name: string;
  mime: string;
  size: number;
}

/** Where an attachment lands in the ticket's worktree, which is the session's working folder. */
export const attachmentPath = (a: Pick<TicketAttachment, "n" | "name">) =>
  `.inc/attachments/${a.n}-${a.name}`;
