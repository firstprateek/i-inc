// The brief a session starts from. Any engine can pick up a stage from it, so an engine switch or a
// crash costs only the old session's in-context memory (spec §4, principle 5).
import { attachmentPath, type Employee, type Ticket } from "./model.ts";
import type { StageId } from "./stages.ts";
import type { TicketState } from "./state.ts";

export function brief(
  ticket: Ticket,
  stage: StageId,
  state: TicketState,
  task: string,
  machine: string[] = [],
  /** The builder commits and pushes; a reviewer or verifier only checks the branch out. */
  builds = true,
  employee?: Employee,
): string {
  const lines = [
    `Ticket #${ticket.id} [${ticket.type}] ${ticket.title} · ${ticket.project} · effort ${ticket.effort}`,
    ...(ticket.reason ? [`Why: ${ticket.reason}`] : []),
    ...(employee ? [`Assignee: ${employee.name}, ${employee.role}`] : []),
    ...(employee?.prompt ? ["Role instructions:", employee.prompt] : []),
    "Done when:",
    ...ticket.doneWhen.map((d) => `- ${d}`),
    ...images(ticket),
    `Stage: ${stage}. Task: ${task}`,
  ];
  if (state.pr?.url) {
    lines.push(
      builds
        ? `Branch: ${state.pr.branch}, with draft PR ${state.pr.url}. Commit to it and push.`
        : `Branch: ${state.pr.branch}, with draft PR ${state.pr.url}. Check it out in your machine; don't push to it.`,
    );
  } else if (state.pr) {
    // Direct mode: the branch stays local, and i.inc pushes the reviewed work to main.
    lines.push(
      `Branch: ${state.pr.branch}, local, in this folder. Commit to it, but don't push: after a review, i.inc pushes it to main.`,
    );
  }
  if (state.interruptedByOwner) {
    lines.push("The owner stopped your last session with an urgent message. Read it first, then carry on.");
  } else if (state.interrupted || state.paused) {
    lines.push(
      "You are resuming this stage: a previous session stopped before finishing. Check the branch first.",
    );
  }
  if (state.handedFrom) {
    lines.push(
      `You are taking this ticket over from ${state.handedFrom}: the branch, plan and notes are theirs.`,
    );
  }
  if (machine.length) lines.push("Your machine and the checks:", ...machine.map((m) => `- ${m}`));
  if (state.outputs.plan) lines.push("Plan:", state.outputs.plan);
  if (state.finished.length) lines.push(`Stages done: ${state.finished.join(", ")}`);
  if (state.lastChecks?.green) lines.push("The last check run passed.");
  if (state.lastChecks && !state.lastChecks.green) {
    lines.push("Last check run failed:", ...state.lastChecks.failures.map((f) => `- ${f}`));
  }
  if (!state.review.approved && state.review.findings.length) {
    lines.push(
      `Review round ${state.review.round} findings:`,
      ...state.review.findings.map((f) => `- [${f.severity}] ${f.where}: ${f.text}`),
    );
  }
  if (state.review.disputed) lines.push(`Builder's reply to the findings: ${state.review.disputed}`);
  if (state.lastProof?.some((i) => !i.pass)) {
    lines.push(
      "Proof failed for:",
      ...state.lastProof.filter((i) => !i.pass).map((i) => `- ${i.doneWhen}: ${i.evidence}`),
    );
  }
  const switched = state.switches.at(-1);
  if (switched?.stage === stage) lines.push(`Engine switched from ${switched.from}: ${switched.reason}.`);
  if (state.lastAnswer?.note) lines.push(`Owner's note: ${state.lastAnswer.note}`);
  if (state.ownerNote) lines.push(`The owner asked for changes: ${state.ownerNote}`);
  // Images added while a session ran, or while the ticket waited, are news to its next session.
  const last = employee ? state.lastSessionAt[employee.id] : undefined;
  const added = last === undefined ? [] : state.attachments.filter((a) => a.at >= last);
  if (added.length) {
    lines.push(
      "The owner added images since your last session (open them):",
      ...added.map((a) => `- ${attachmentPath(a)}`),
    );
  }
  // Messages reach the employee at the next stage boundary; urgent ones at the next session (spec §10, "Chat").
  const delivered = state.messages.filter(
    (m) => m.urgent || (state.stageStartedAt !== null && m.at <= state.stageStartedAt),
  );
  if (delivered.length)
    lines.push("Messages from the owner:", ...delivered.slice(-5).map((m) => `- ${m.text}`));
  return lines.join("\n");
}

/**
 * A reviewer's brief in direct mode: the ticket and the task only, with none of the builder's plan,
 * notes or history, so the review comes with fresh eyes (decided 2026-10-17).
 */
export function freshBrief(ticket: Ticket, stage: StageId, task: string, machine: string[] = []): string {
  return [
    `Ticket #${ticket.id} [${ticket.type}] ${ticket.title} · ${ticket.project}`,
    ...(ticket.reason ? [`Why: ${ticket.reason}`] : []),
    "Done when:",
    ...ticket.doneWhen.map((d) => `- ${d}`),
    ...images(ticket),
    `Stage: ${stage}. Task: ${task}`,
    ...(machine.length ? ["Your machine and the checks:", ...machine.map((m) => `- ${m}`)] : []),
  ].join("\n");
}

/** The owner's images, as files in the worktree, so any engine that can read a file can see them. */
function images(ticket: Ticket): string[] {
  if (!ticket.attachments?.length) return [];
  return ["Images from the owner (open them):", ...ticket.attachments.map((a) => `- ${attachmentPath(a)}`)];
}
