// The seam between the AHP host and whatever runs the agents.
//
// The host (host.ts) owns the protocol: channels, sequencing, persistence, validation of what clients
// send. An AgentBackend owns the agent side. Everything agent-specific (ACP, the sandbox, the mapper
// from ACP updates to chat actions) lives behind this interface, in the session host (T59b). The host
// core is tested with a scripted backend, and runs in the daemon with `NoAgentBackend` until then.
import type {
  AgentInfo,
  ConfirmationOption,
  Message,
  SessionConfigState,
} from "@microsoft/agent-host-protocol";
import type { AhpHost } from "./host.ts";
import type { ChatAction, Json } from "./wire.ts";

/** What the app lends a backend: the sandbox's storage cleanup lock, and a way to say a machine was woken. */
export interface AppGate {
  storage: {
    machineOf(employeeId: string): string | undefined;
    holding(machine: string): boolean;
    untilFree(machine: string, maxMs: number): Promise<boolean>;
  };
  /** The employee's machine was started for a conversation. */
  awake(employeeId: string): void;
}

/** What the host asks of a backend when a session is created. */
export interface OpenSessionRequest {
  session: string;
  /** The session's first (default) chat. */
  chat: string;
  provider: string;
  workingDirectories: string[];
  /** Config values the client asked for (validated against the schema the backend returns). */
  config?: Json;
  /** The createSession `_meta` (i.inc: the conversation, employee, project). */
  meta: Json;
}

export interface OpenedSession {
  title?: string;
  /** The agent's own config schema and current values: its modes, models and options. */
  config?: SessionConfigState;
  /** Kept in the session's `_meta` (merged over the request's). */
  meta?: Json;
}

/** How a running turn ended. The host turns it into chat/turnComplete, turnCancelled or error. */
export type TurnOutcome =
  | { kind: "complete" }
  | { kind: "cancelled" }
  | { kind: "error"; errorType: string; message: string; resumable?: boolean };

/** One running turn. The backend streams chat actions into it and returns the outcome. */
export interface TurnRun {
  readonly session: string;
  readonly chat: string;
  readonly turnId: string;
  /** The user's message as sent, attachments' data intact (the log only keeps references). */
  readonly message: Message;
  /** Aborted when the turn is cancelled (by the user, a restart or the chat being disposed). */
  readonly signal: AbortSignal;
  /**
   * Streams one host-originated action into the chat (turn parts, tool calls, usage...). Returns
   * false, and drops the action, once the turn is over, so a cancelled agent's late updates vanish.
   */
  emit(action: ChatAction): boolean;
}

export interface ToolAnswer {
  approved: boolean;
  selectedOptionId?: string;
  /** The option the client chose, resolved against the pending call's options. */
  selectedOption?: ConfirmationOption;
}

export interface AgentBackend {
  /** Called once by the host's constructor, so the backend can emit session-level actions and keep metadata. */
  attach?(host: AhpHost): void;
  /** The providers (engines) this host offers, for the root channel. */
  agents(): AgentInfo[];
  /** Prepares the agent side of a new session. Throwing fails the session's creation. */
  openSession(req: OpenSessionRequest): Promise<OpenedSession>;
  /** Called once storage and the daemon exist: what a conversation needs to know about the machine it runs on. */
  attachApp?(app: AppGate): void;
  /** Employees whose conversations have an agent running (or starting) now. */
  liveEmployees?(): string[];
  /** The session and its chat exist now (and are ready): the backend may touch them. */
  afterCreate?(session: string, chat: string): void;
  /** An extra chat in a session (only for providers that advertise `multipleChats`). */
  openChat?(session: string, chat: string): Promise<void>;
  closeChat?(session: string, chat: string): Promise<void>;
  /** Releases the agent processes of a session being disposed. */
  closeSession(session: string): Promise<void>;
  /** Runs one turn. The host has already recorded `chat/turnStarted`. */
  runTurn(run: TurnRun): Promise<TurnOutcome>;
  /**
   * The conversation's working copy now belongs to a ticket (T62b): stops its agent so nothing else
   * writes there. Returns false, and does nothing, while a turn is running.
   */
  hold?(session: string): boolean;
  /** The ticket is over: the next prompt starts with `note`, which says what happened to the branch. */
  resumed?(session: string, note: string): void;
  /** Called when a turn is cancelled, after its signal is aborted. */
  cancelTurn?(run: TurnRun): void;
  /** The first client answer to a pending confirmation (later ones never reach the backend). */
  answerToolCall(run: TurnRun, toolCallId: string, answer: ToolAnswer): void;
  /** A steering message arrived mid-turn. Return true if it was injected; false queues it as the next turn. */
  steer?(run: TurnRun, message: Message): Promise<boolean> | boolean;
  /** Applies new session config (a mode, a model...). Throwing makes the host put the old values back. */
  setConfig(session: string, values: Json): Promise<void>;
  /** The answer to a chat input request (a question the agent asked). */
  answerInput?(run: TurnRun, requestId: string, response: string, answers?: Json): void;
}

/** What the daemon runs until the session host lands: sessions can be made and read, but no agent answers. */
export class NoAgentBackend implements AgentBackend {
  constructor(private readonly providers: () => AgentInfo[] = () => []) {}
  agents(): AgentInfo[] {
    return this.providers();
  }
  async openSession(): Promise<OpenedSession> {
    return {};
  }
  async closeSession(): Promise<void> {}
  async runTurn(): Promise<TurnOutcome> {
    return {
      kind: "error",
      errorType: "no_agent",
      message: "No agent is connected to conversations yet.",
    };
  }
  answerToolCall(): void {}
  async setConfig(): Promise<void> {}
}
