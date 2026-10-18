// Chat (spec §10): one thread per employee. Questions get a short answer; asks for new work become
// a draft ticket (or, for a PA, an errand straight away), so work still flows through tickets and the
// board stays true. Messages to someone mid-ticket reach it at the next stage boundary.
import type { Employee, Engine, Ticket } from "./model.ts";
import type { ChatSession, HelperModel } from "./ports.ts";

export type ChatOutcome =
  | { kind: "answer"; text: string }
  | { kind: "draft"; ticket: DraftTicket; inferred: boolean; ambiguous?: string[] }
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
    const named = pa ? [] : matchProjects(text, ctx.employee.projects);
    const mentioned = named.length === 1 ? (named[0] ?? null) : null;
    // Never a project the employee doesn't work on: the scheduler wouldn't run it.
    const mine = (p: string | undefined): p is string =>
      !!p && (!ctx.employee.projects || ctx.employee.projects.includes(p));
    const project = pa
      ? "Home"
      : (mentioned ??
        [ctx.current?.project, ctx.defaultProject].find(mine) ??
        ctx.employee.projects?.[0] ??
        ctx.defaultProject);
    const ticket: DraftTicket = {
      title: firstLine(text),
      project,
      type: pa ? "errand" : "feat",
      effort: pa ? "low" : "medium",
      doneWhen: [],
      assignee: ctx.employee.id,
    };
    if (pa) return { kind: "errand", ticket };
    return {
      kind: "draft",
      ticket,
      inferred: mentioned !== null,
      ...(named.length > 1 ? { ambiguous: named } : {}),
    };
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

/** What the message leaves behind once URLs, code blocks, code spans and "project: x" text are removed. */
function prose(text: string): string {
  return text
    .normalize("NFC")
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ")
    .replace(/\bwww\.\S*/gi, " ")
    .replace(/\bproject\s*[:=]\s*\S*/gi, " ");
}

/**
 * The employee's projects the message names, as written in `projects`. A name only counts as a whole
 * word (letters, digits, "_" and "-" don't end it, in any script); a name inside a longer matched name
 * ("inc" in "i-inc" or "Duet" in "Duet Web") doesn't count separately. Text in URLs, code and a
 * "project: x" label is never read, so none of it can pick a project.
 */
export function matchProjects(text: string, projects?: string[]): string[] {
  if (!projects?.length) return [];
  const body = prose(text);
  const seen = new Set<string>();
  const hits: { name: string; spans: [number, number][] }[] = [];
  for (const raw of projects) {
    const name = raw?.normalize("NFC");
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_-])${escaped}(?![\\p{L}\\p{N}\\p{M}_-])`, "giu");
    const spans = [...body.matchAll(re)].map((m): [number, number] => [m.index, m.index + m[0].length]);
    if (spans.length) hits.push({ name: raw, spans });
  }
  return hits
    .filter((h) =>
      h.spans.some(([a, b]) =>
        hits.every((o) => o === h || !o.spans.some(([c, d]) => c <= a && b <= d && d - c > b - a)),
      ),
    )
    .map((h) => h.name);
}

/** The one project the message names, or null when it names none or more than one. */
export function inferProject(text: string, projects?: string[]): string | null {
  const hits = matchProjects(text, projects);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}
