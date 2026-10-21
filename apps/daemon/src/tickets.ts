// The backlog: ticket definitions, priority and holds. What happened to a ticket lives in the events.
import type { Id, Ticket, TicketAttachment } from "@i-inc/core";
import type { Db } from "./db.ts";

export interface NewTicket {
  title: string;
  project: string;
  type: Ticket["type"];
  effort: Ticket["effort"];
  doneWhen: string[];
  /** Empty means unassigned: a standing order may pick it up. */
  assignee?: Id;
  labels?: string[];
  priority?: number;
  hold?: boolean;
  /** The agent that filed it, for a follow-up. */
  createdBy?: Id;
  /** Why an agent proposed it, for a follow-up. */
  reason?: string;
  /** The conversation it was made from, and that conversation's branch (ship.ts). */
  conversation?: Id;
  branch?: string;
}

/** An image the owner sends with a ticket, already checked by the API. */
export interface NewAttachment {
  name: string;
  mime: string;
  data: Uint8Array;
}

/** An attachment with its bytes. */
export interface AttachmentFile extends TicketAttachment {
  data: Uint8Array<ArrayBuffer>;
}

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * A file name that's safe in a shell script, a path and a header: letters, digits, dots, dashes and
 * underscores, no leading dot, and the extension that matches the type.
 */
export function safeName(name: string, mime: string): string {
  const ext = extensions[mime] ?? "bin";
  const stem = (name.split(/[\\/]/).pop() ?? "")
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 60);
  return `${stem || "image"}.${ext}`;
}

/** Metadata for new images, numbered on from `after`. */
function numbered(images: NewAttachment[], after: number): TicketAttachment[] {
  return images.map((f, i) => ({
    n: after + i + 1,
    name: safeName(f.name, f.mime),
    mime: f.mime,
    size: f.data.byteLength,
  }));
}

export interface TicketRecord {
  ticket: Ticket;
  priority: number;
  hold: boolean;
  createdAt: number;
  /** When a standing order picked it up, if one did. */
  pickedAt: number | null;
}

export class Tickets {
  onChange?: (ticketId: Id) => void;

  constructor(private readonly db: Db) {}

  create(input: NewTicket, now: number, images: NewAttachment[] = []): Ticket {
    const [row] = this.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM tickets");
    const id = String((row?.n ?? 0) + 1);
    const attachments = numbered(images, 0);
    const ticket: Ticket = {
      id,
      title: input.title,
      project: input.project,
      type: input.type,
      effort: input.effort,
      doneWhen: input.doneWhen,
      assignee: input.assignee ?? "",
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.conversation ? { conversation: input.conversation } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    // One transaction, so a ticket is never picked up before its images are there.
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO tickets (id, body, priority, hold, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        JSON.stringify(ticket),
        input.priority ?? 0,
        input.hold ? 1 : 0,
        now,
      );
      this.insertImages(id, attachments, images, now);
    });
    this.onChange?.(id);
    return ticket;
  }

  /** Adds images to a ticket that already exists, numbered after its last one. Returns the new ones. */
  attach(id: Id, images: NewAttachment[], now: number): TicketAttachment[] {
    let added: TicketAttachment[] = [];
    this.db.transaction(() => {
      const r = this.get(id);
      if (!r) throw new Error(`no ticket ${id}`);
      const [row] = this.db.all<{ n: number | null }>(
        "SELECT MAX(seq) AS n FROM ticket_attachments WHERE ticket_id = ?",
        id,
      );
      added = numbered(images, row?.n ?? 0);
      const attachments = [...(r.ticket.attachments ?? []), ...added];
      this.db.run(
        "UPDATE tickets SET body = ? WHERE id = ?",
        JSON.stringify({ ...r.ticket, attachments }),
        id,
      );
      this.insertImages(id, added, images, now);
    });
    this.onChange?.(id);
    return added;
  }

  private insertImages(id: Id, attachments: TicketAttachment[], images: NewAttachment[], now: number): void {
    attachments.forEach((a, i) => {
      this.db.run(
        "INSERT INTO ticket_attachments (ticket_id, seq, name, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        a.n,
        a.name,
        a.mime,
        a.size,
        images[i]?.data ?? new Uint8Array(),
        now,
      );
    });
  }

  /** One attachment with its bytes, or all of a ticket's when `n` is absent. */
  attachments(ticketId: Id, n?: number): AttachmentFile[] {
    return this.db
      .all<{ seq: number; name: string; mime: string; size: number; data: Uint8Array }>(
        `SELECT seq, name, mime, size, data FROM ticket_attachments WHERE ticket_id = ?${n === undefined ? "" : " AND seq = ?"} ORDER BY seq`,
        ...(n === undefined ? [ticketId] : [ticketId, n]),
      )
      .map((r) => ({ n: r.seq, name: r.name, mime: r.mime, size: r.size, data: new Uint8Array(r.data) }));
  }

  get(id: Id): TicketRecord | undefined {
    return this.rows("WHERE id = ?", id)[0];
  }

  all(): TicketRecord[] {
    return this.rows("ORDER BY created_at, CAST(id AS INTEGER)");
  }

  /** Assigns a ticket; `pickedAt` records a standing order picking it up (for its daily limit). */
  assign(id: Id, assignee: Id, pickedAt: number | null = null): void {
    const r = this.get(id);
    if (!r) throw new Error(`no ticket ${id}`);
    this.db.run(
      "UPDATE tickets SET body = ?, picked_at = ? WHERE id = ?",
      JSON.stringify({ ...r.ticket, assignee }),
      pickedAt,
      id,
    );
    this.onChange?.(id);
  }

  setProject(id: Id, project: string): void {
    const r = this.get(id);
    if (!r) throw new Error(`no ticket ${id}`);
    this.db.run("UPDATE tickets SET body = ? WHERE id = ?", JSON.stringify({ ...r.ticket, project }), id);
    this.onChange?.(id);
  }

  setHold(id: Id, hold: boolean): void {
    this.db.run("UPDATE tickets SET hold = ? WHERE id = ?", hold ? 1 : 0, id);
    this.onChange?.(id);
  }

  private rows(where: string, ...params: string[]): TicketRecord[] {
    return this.db
      .all<{ body: string; priority: number; hold: number; created_at: number; picked_at: number | null }>(
        `SELECT body, priority, hold, created_at, picked_at FROM tickets ${where}`,
        ...params,
      )
      .map((r) => ({
        ticket: JSON.parse(r.body) as Ticket,
        priority: r.priority,
        hold: r.hold === 1,
        createdAt: r.created_at,
        pickedAt: r.picked_at,
      }));
  }
}
