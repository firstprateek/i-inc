// The brief a session starts from. Any engine can pick up a stage from it, so an engine switch or a
// crash costs only the old session's in-context memory (spec §4, principle 5).
import type { Ticket } from "./model.ts";
import type { StageId } from "./stages.ts";
import type { TicketState } from "./state.ts";

export function brief(ticket: Ticket, stage: StageId, state: TicketState, task: string): string {
  const lines = [
    `Ticket #${ticket.id} [${ticket.type}] ${ticket.title} · ${ticket.project} · effort ${ticket.effort}`,
    "Done when:",
    ...ticket.doneWhen.map((d) => `- ${d}`),
    `Stage: ${stage}. Task: ${task}`,
  ];
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
  if (state.outputs.plan) lines.push("Plan:", state.outputs.plan);
  if (state.finished.length) lines.push(`Stages done: ${state.finished.join(", ")}`);
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
  // Messages reach the employee at the next stage boundary; urgent ones at the next session (spec §10, "Chat").
  const delivered = state.messages.filter(
    (m) => m.urgent || (state.stageStartedAt !== null && m.at <= state.stageStartedAt),
  );
  if (delivered.length)
    lines.push("Messages from the owner:", ...delivered.slice(-5).map((m) => `- ${m.text}`));
  return lines.join("\n");
}
