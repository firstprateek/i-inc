// Live event bus for SSE updates (Contract C3: live ticket and office events).
import { EventEmitter } from "node:events";
import type { Id } from "@i-inc/core";

export class LiveEvents extends EventEmitter {
  notifyTicket(id: Id): void {
    this.emit("ticket", id);
  }

  notifyOffice(): void {
    this.emit("office");
  }
}
