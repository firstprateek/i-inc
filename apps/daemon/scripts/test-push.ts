// An owner-side smoke tool: send one test notification to every device that turned push on, and print
// what each push service answered. It runs ON THE HOST, from the release the daemon runs:
//
//   bun apps/daemon/scripts/test-push.ts
//
// It reads the subscriptions from ~/.i-inc/i-inc.db (read-only) and the VAPID keys from ~/.config/i-inc
// (never printed). A device whose subscription is gone (404 or 410) is reported, not removed: the daemon
// removes it on its next real notification. Exit code: 0 when every device's service accepted it, 1 otherwise.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { type PushSubscription, WebPushSender } from "../src/push.ts";

const db = new Database(join(homedir(), ".i-inc/i-inc.db"), { readonly: true });
const subs = db
  .query("SELECT body FROM company WHERE kind = 'push_sub'")
  .all()
  .map((r) => JSON.parse((r as { body: string }).body) as PushSubscription);
if (!subs.length) {
  console.log("No device has turned push on: open the web app on the phone and turn notifications on first.");
  process.exit(1);
}

let failed = 0;
const fetchImpl = (async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  if (!res.ok) failed++;
  console.log(`${new URL(url).host}: ${res.status}${res.ok ? " (accepted)" : ""}`);
  return res;
}) as typeof fetch;
const registry = {
  pushSubscriptions: () => subs,
  removePushSubscription: () =>
    console.log("  that subscription is gone: turn notifications on again on that device"),
};
// biome-ignore lint/suspicious/noExplicitAny: only the two subscription methods are used.
const sender = new WebPushSender(registry as any, { configDir: join(homedir(), ".config/i-inc"), fetchImpl });
await sender.send({ title: "i.inc", body: "Test notification: push works.", url: "/", tag: "test" });
process.exit(failed ? 1 : 0);
