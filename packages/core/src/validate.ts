// What an agent says is data, not a promise (T63). Every JSON reply is checked here before the
// runner stores it, and the same readers run again when old events are replayed (state.ts,
// knowledge.ts, the daemon), so one bad reply can't break the fold, the tick or the board.
//
// Each reader takes whatever JSON.parse produced. It returns the checked value (with defaults for
// what is harmless to default, caps on lengths), or `null` when the reply can't be used as it is: the
// caller then fails the stage with "could not be read" rather than storing it.
import type { Finding } from "./events.ts";
import type { Effort, FollowUp, KnowledgeEdit, OutboundAction, Proposal } from "./model.ts";

export type ProofItem = { doneWhen: string; pass: boolean; evidence: string };

const maxText = 8_000;
const maxTitle = 200;
const maxItems = 100;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A string cut to `max`; anything that isn't one is "". */
export const text = (v: unknown, max = maxText): string => (typeof v === "string" ? v.slice(0, max) : "");

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;

export const efforts: readonly Effort[] = ["low", "medium", "high"];
export const followUpTypes = ["fix", "feat", "chore"] as const;
export const severities = ["blocking", "should-fix", "nit"] as const;
export const knowledgeLayers = ["brain", "fact", "policy"] as const;
export const outboundActions: readonly OutboundAction[] = [
  "send-email",
  "accept-invite",
  "calendar-hold",
  "calendar-invite",
  "book",
  "pay",
  "delete-mail",
  "forward",
  "share-file",
  "account-settings",
];

/** The verifier's `{"items":[{doneWhen, pass, evidence}]}`. `pass` must be a real boolean. */
export function readProof(value: unknown): ProofItem[] | null {
  const items = isRecord(value) ? value.items : value;
  if (!Array.isArray(items)) return null;
  const out: ProofItem[] = [];
  for (const i of items.slice(0, maxItems)) {
    if (!isRecord(i) || typeof i.pass !== "boolean") return null;
    out.push({ doneWhen: text(i.doneWhen), pass: i.pass, evidence: text(i.evidence) });
  }
  return out;
}

/** One review finding; a bad severity becomes "should-fix", and something that isn't an object is dropped. */
export function readFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  const out: Finding[] = [];
  for (const f of value.slice(0, 50)) {
    if (!isRecord(f)) continue;
    out.push({
      severity: oneOf(f.severity, severities) ?? "should-fix",
      where: text(f.where, 500),
      text: text(f.text),
    });
  }
  return out;
}

/**
 * The reviewer's `{"approved", "findings"}`. `approved` must be a boolean. A rejection with no usable
 * finding gets one that says so, so the builder's next session has something to answer.
 */
export function readVerdict(value: unknown): { approved: boolean; findings: Finding[] } | null {
  if (!isRecord(value) || typeof value.approved !== "boolean") return null;
  const findings = readFindings(value.findings);
  if (!value.approved && findings.length === 0) {
    findings.push({
      severity: "blocking",
      where: "",
      text: "The reviewer did not approve the change and gave no findings.",
    });
  }
  return { approved: value.approved, findings };
}

/** What the builder says about the findings: a reason to disagree, or nothing. */
export function readDisputed(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const d = value.disputed;
  if (typeof d === "string") return d.trim() ? d.slice(0, maxText) : null;
  return d === null || d === undefined || d === false ? null : text(JSON.stringify(d));
}

/**
 * Follow-up tickets an agent proposed. Kept: those with a title, a done-when list, a type in
 * fix|feat|chore and an effort in low|medium|high. `dropped` counts the rest.
 */
export function readFollowUps(value: unknown, limit = 3): { kept: FollowUp[]; dropped: number } {
  if (!Array.isArray(value)) return { kept: [], dropped: value === undefined || value === null ? 0 : 1 };
  const kept: FollowUp[] = [];
  let dropped = 0;
  for (const f of value) {
    const title = isRecord(f) && typeof f.title === "string" ? f.title.trim().slice(0, maxTitle) : "";
    const type = isRecord(f) ? oneOf(f.type, followUpTypes) : null;
    const effort = isRecord(f) ? oneOf(f.effort, efforts) : null;
    if (!isRecord(f) || !title || !type || !effort || !Array.isArray(f.doneWhen) || kept.length >= limit) {
      dropped++;
      continue;
    }
    const doneWhen = f.doneWhen
      .filter((d): d is string => typeof d === "string" && d.trim() !== "")
      .slice(0, 20)
      .map((d) => d.slice(0, 500));
    kept.push({ title, doneWhen, type, effort, reason: text(f.reason, 2000) });
  }
  return { kept, dropped };
}

/** Knowledge edits an agent proposed: a layer in brain|fact|policy, a page name and the text. */
export function readEdits(
  value: unknown,
  opts: { limit?: number; layer?: KnowledgeEdit["layer"] } = {},
): { kept: KnowledgeEdit[]; dropped: number } {
  if (!Array.isArray(value)) return { kept: [], dropped: value === undefined || value === null ? 0 : 1 };
  const kept: KnowledgeEdit[] = [];
  let dropped = 0;
  for (const e of value) {
    const layer = isRecord(e) ? (opts.layer ?? oneOf(e.layer, knowledgeLayers)) : null;
    const page = isRecord(e) && typeof e.page === "string" ? e.page.slice(0, 200) : "";
    const body = isRecord(e) && typeof e.text === "string" ? e.text.slice(0, 64_000) : "";
    if (!layer || !page.trim() || !body.trim() || kept.length >= (opts.limit ?? 50)) {
      dropped++;
      continue;
    }
    kept.push({ layer, page, text: body });
  }
  return { kept, dropped };
}

/** An errand's `{"proposals":[{action, summary, to?, invitesOthers?}]}`. */
export function readProposals(value: unknown): Proposal[] | null {
  const items = isRecord(value) ? value.proposals : null;
  if (!Array.isArray(items)) return null;
  const out: Proposal[] = [];
  for (const p of items.slice(0, maxItems)) {
    const action = isRecord(p) ? oneOf(p.action, outboundActions) : null;
    if (!isRecord(p) || !action) return null;
    const to = Array.isArray(p.to)
      ? p.to.filter((a): a is string => typeof a === "string").map((a) => a.slice(0, 320))
      : undefined;
    out.push({
      action,
      summary: text(p.summary),
      ...(to ? { to } : {}),
      ...(typeof p.invitesOthers === "boolean" ? { invitesOthers: p.invitesOthers } : {}),
    });
  }
  return out;
}
