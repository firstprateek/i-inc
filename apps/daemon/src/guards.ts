// Process-level safety nets (T63, audit 4.1). A rejection or exception nobody handled is logged and
// the daemon carries on: a bug in one ticket's step, a stream that errors after its child exited, a
// timer callback that throws, none of those should end the process that holds every other ticket.
// It exits only for states it cannot work in (below), and when exceptions come in a flood, so a
// crash loop stays visible to launchd's restart instead of a daemon that serves nothing.

/** Errors that mean this process cannot go on: out of memory, or a database that is damaged. */
export function isFatal(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof e?.code === "string" ? e.code : "";
  const message = typeof e?.message === "string" ? e.message : String(err);
  return (
    code === "ENOMEM" ||
    code === "ERR_OUT_OF_MEMORY" ||
    /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i.test(
      `${code} ${message}`,
    ) ||
    /JavaScript heap out of memory|out of memory/i.test(message)
  );
}

export interface GuardOptions {
  log: (msg: string) => void;
  /** Ends the process. Tests pass a stand-in. */
  exit: (code: number) => void;
  /** More uncaught exceptions than this within `windowMs` is a flood, and the process leaves. */
  floodLimit?: number;
  windowMs?: number;
  now?: () => number;
}

/** The handlers, as functions, so a test can call them without raising a real exception. */
export function guards(o: GuardOptions) {
  const now = o.now ?? Date.now;
  const limit = o.floodLimit ?? 20;
  const windowMs = o.windowMs ?? 60_000;
  const seen: number[] = [];
  const text = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));
  return {
    unhandledRejection(reason: unknown): void {
      o.log(`unhandled rejection (carrying on): ${text(reason)}`);
      if (isFatal(reason)) {
        o.log("that is fatal: leaving, and launchd starts the daemon again");
        o.exit(1);
      }
    },
    uncaughtException(err: unknown): void {
      o.log(`uncaught exception (carrying on): ${text(err)}`);
      const at = now();
      seen.push(at);
      while (seen.length && at - (seen[0] ?? at) > windowMs) seen.shift();
      if (isFatal(err)) {
        o.log("that is fatal: leaving, and launchd starts the daemon again");
        o.exit(1);
      } else if (seen.length > limit) {
        o.log(`${seen.length} uncaught exceptions in ${Math.round(windowMs / 1000)} s: leaving`);
        o.exit(1);
      }
    },
  };
}

/** Installs the handlers on this process. */
export function installGuards(o: GuardOptions): void {
  const g = guards(o);
  process.on("unhandledRejection", (reason) => g.unhandledRejection(reason));
  process.on("uncaughtException", (err) => g.uncaughtException(err));
}

/**
 * What the HTTP server answers when a request's handler throws (Bun.serve `error`): plain JSON, with
 * the details in the log. Without it Bun serves its development error page, source excerpts and
 * absolute paths included (T63, audit 4.3; main.ts also sets `development: false`).
 */
export function serverError(log: (msg: string) => void): (err: unknown) => Response {
  return (err) => {
    log(`request failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return Response.json({ error: "something went wrong on our side" }, { status: 500 });
  };
}
