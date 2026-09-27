// Chat (spec §10): one thread per employee. Questions get a short answer; asks for new work become
// a draft ticket (or, for a PA, an errand straight away), so work still flows through tickets and the
// board stays true. Messages to someone mid-ticket reach it at the next stage boundary.
import type { Employee, Engine, Ticket } from "./model.ts";
import type { ChatSession, HelperModel } from "./ports.ts";

export type ChatOutcome =
  | { kind: "answer"; text: string }
  | { kind: "draft"; ticket: DraftTicket }
  | { kind: "errand"; ticket: DraftTicket }
  | { kind: "note"; ticketId: string }
  | { kind: "unavailable"; reason: string };

/** A ticket the owner confirms with one tap (an errand needs no tap). */
export interface DraftTicket {
  title: string;
  project: string;
  type: Ticket["type"];
  effort: Ticket["effort"];
  doneWhen: string[];
  assignee: string;
}

export interface ChatContext {
  employee: Employee;
  engine: Engine;
  /** The ticket the employee is working on now, if any. */
  current: Ticket | null;
  /** The employee's recent tickets and notes, for answering questions. */
  notes: string;
  /** A project to file new work under when the message doesn't say. */
  defaultProject: string;
}

const isAsk = "Is this message asking for new work to be done, rather than asking a question?";
const isAboutCurrent = "Is this message a note or instruction about the work already in progress?";

export async function handleMessage(
  text: string,
  ctx: ChatContext,
  helper: HelperModel,
  chat: ChatSession,
): Promise<ChatOutcome> {
  const pa = ctx.employee.role === "Personal Assistant";

  if (await helper.yesNo(isAsk, text)) {
    const ticket: DraftTicket = {
      title: firstLine(text),
      project: pa ? "Home" : (ctx.current?.project ?? ctx.defaultProject),
      type: pa ? "errand" : "feat",
      effort: pa ? "low" : "medium",
      doneWhen: [],
      assignee: ctx.employee.id,
    };
    return pa ? { kind: "errand", ticket } : { kind: "draft", ticket };
  }

  if (ctx.current && (await helper.yesNo(isAboutCurrent, text))) {
    return { kind: "note", ticketId: ctx.current.id };
  }

  const brief = [
    `You are ${ctx.employee.name}, ${ctx.employee.role}. The owner asks you a question in chat.`,
    "Answer briefly from what you know about your work. Don't start any work.",
    ctx.current ? `You are working on #${ctx.current.id} ${ctx.current.title} (${ctx.current.project}).` : "",
    ctx.notes ? `Your recent notes:\n${ctx.notes}` : "",
    `Question: ${text}`,
  ]
    .filter(Boolean)
    .join("\n");
  const out = await chat.answer({ employee: ctx.employee, engine: ctx.engine, brief });
  if (out.kind === "done") return { kind: "answer", text: out.output };
  if (out.kind === "out-of-tokens") {
    return {
      kind: "unavailable",
      reason: `${ctx.engine.model} is out of tokens until ${new Date(out.resetsAt).toISOString()}`,
    };
  }
  return { kind: "unavailable", reason: out.reason };
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  const t = line.length > 80 ? `${line.slice(0, 77)}…` : line;
  return t.charAt(0).toUpperCase() + t.slice(1).replace(/[.!]$/, "");
}
