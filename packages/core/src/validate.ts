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

export type DoneWhenVerdict = "met" | "not-met" | "cant-tell";
export type DoneWhenItem = { doneWhen: string; verdict: DoneWhenVerdict; evidence: string };

const verdictOf = (v: unknown): DoneWhenVerdict => {
  const t =
    typeof v === "string"
      ? v
          .toLowerCase()
          .replace(/[\s_-]+/g, " ")
          .trim()
      : "";
  if (t === "met") return "met";
  if (t === "not met" || t === "unmet") return "not-met";
  return "cant-tell";
};

/** One line: the checker's words go into markdown (the PR body, the report), where a newline could start a heading. */
export const oneLine = (t: unknown, max = 2000): string => text(t, max).replace(/\s+/g, " ").trim();

/**
 * The done-when checker's `{"items":[{doneWhen, verdict, evidence}]}`, lined up with the ticket's own done-when
 * list (T72). An answer belongs to an item only by its exact text (case and spacing aside); never by position, so a
 * reply that reorders, rewords or skips items cannot put one item's verdict on another. An item with no answer, a
 * `met` with no evidence, and every item of a reply that cannot be read read as "can't tell": nothing is ever made
 * done on a guess. The evidence is cut to one line.
 */
export function readDoneWhenCheck(value: unknown, expected: string[]): DoneWhenItem[] {
  const raw = isRecord(value) ? value.items : value;
  const replied = Array.isArray(raw) ? raw.slice(0, maxItems).filter(isRecord) : [];
  const norm = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
  const used = new Set<number>();
  return expected.map((doneWhen) => {
    const at = replied.findIndex((r, i) => !used.has(i) && norm(text(r.doneWhen)) === norm(doneWhen));
    const r = replied[at];
    if (!r) return { doneWhen, verdict: "cant-tell", evidence: "the checker did not answer for this item" };
    used.add(at);
    const evidence = oneLine(r.evidence);
    const verdict = verdictOf(r.verdict);
    if (verdict === "met" && !evidence) {
      return { doneWhen, verdict: "cant-tell", evidence: "the checker said met but gave no evidence" };
    }
    return { doneWhen, verdict, evidence };
  });
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

/** Words that make a "nothing" reason a report of giving up (a failure, a missing tool or access), not of having nothing to do. */
const gaveUp =
  /\b(sudo|fail(?:s|ed|ure|ures|ing)?|errors?|can'?t|cannot|can not|couldn'?t|could not|unable|not possible|impossible|no internet|offline|denied|permission|refused|not installed|missing|access|time[sd]? ?out|did not work|didn'?t work|doesn'?t work|not working|unavailable|not available|isn'?t available|blocked|broken|crash(?:ed)?|exception|not allowed|forbidden|unauthori[sz]ed|no tool|lack(?:s|ed|ing)?|stuck)\b/i;

/** Words that make it a report of there being nothing to do. */
const nothingToDo =
  /\b(no action|nothing (?:to do|needed|is needed|needs|new|pending|more|else|to (?:reply|answer|send|prepare|propose|triage|report|file|book|schedule))|no (?:new|unread|pending|outstanding|open|unanswered|urgent) |no (?:mail|e-?mails?|messages?|invites?|requests?|events?|questions?) |no (?:reply|replies|response|responses|changes?|updates?|tasks?|work|action) (?:is |are )?(?:needed|required|necessary)|not needed|no need|already (?:done|handled|answered|replied|sorted|up to date|booked|scheduled)|up to date|all clear|all caught up|(?:inbox|calendar|list) (?:is )?(?:empty|clear)|nothing has changed)\b/i;

/**
 * Whether the reason an errand gave for proposing nothing reads as "no action was needed". Anything that mentions an
 * error, a failure, missing tools or access is giving up, and so is anything this cannot tell: both go to the owner
 * (the errand's `nothing` reply, spec §7).
 */
export function nothingMeansNoActionNeeded(reason: string): boolean {
  return !gaveUp.test(reason) && nothingToDo.test(reason);
}
